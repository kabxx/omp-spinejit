import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Tokenizer } from "@oh-my-pi/pi-agent-core";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent";
import { DEFAULT_RESERVE_TOKENS, MAX_SUMMARY_TOKENS } from "@oh-my-pi/pi-agent-core/compaction";
import { SpawnChildren, runSpawnChild, spineToolRefusal, spineToolResult, unarrivedBirths, isSpineToolName, SpineToolInputError, } from "@spinejit/spine-sdk/host";
import { createNodeSpineRuntime, } from "@spinejit/spine-sdk/node";
import { childBirthOf, latestChildSession } from "./child-session.js";
import { readChildState } from "./child-memory.js";
import { OMP_CHILD_CONFIG_ENV, runOmpChild, watchOmpChildParent } from "./child-process.js";
import { mergeHostTranscripts, spliceLiveHostTranscript } from "./context.js";
import { decodeHostToolCall } from "./xdev.js";
import { projectOmpSession, sessionEntryToOmpMessages, spliceOmpGeneratedContext } from "./host-projection.js";
import { isControlToolName } from "./control-cursor.js";
import { createOmpSpineAdapter } from "./index.js";
import { buildCompactBarrier, decodeSpawnTasks, OmpSamplingLifecycle, OmpSamplingLifecycleError, OmpSpineToolLimitError, } from "./lifecycle.js";
import { ompArrivalOf, extractOmpArrival, SPINE_ARRIVAL_CUSTOM_TYPE, isOmpHostSystemMessage, isOmpBranchStateMessage, isOmpSourceMessage, materializeOmpContext, ompNativeMessageKey, } from "./messages.js";
import { loadOmpSpineConfigToml } from "./spine-config.js";
import { linesComponent, } from "./pretty-tree.js";
import { assertOmpV3ReplayBranch, buildOmpReplayPlan, OmpLegacyJournalError, ompResetBoundaryIndex, ompRewindLeaf, readOmpNativeCompactReceipt, recoverOmpSession } from "./recovery.js";
import { buildOmpSourceCheckpoint } from "./source-history.js";
import { OMP_ADAPTER_ID, OMP_ARCHIVE_ENTRY_TYPE, OMP_COMPACT_ENTRY_TYPE, OMP_SOURCE_ENTRY_TYPE } from "./protocol.js";
import { registerSpineTreeCommand, SpineTreeDisplay } from "./tree-view.js";
import { SPINE_TREE_VIEW_REQUEST } from "./tree-view-contract.js";
import { createSpawnBatchView, describeSpawnCall, describeSpawnResult, renderSpawnCall, renderSpawnResult, settleSpawnView, } from "./spawn-view.js";
const CHILD_FLAG = "spine-child";
const EXTENSION_MODULE_PATH = fileURLToPath(import.meta.url);
const spineContextHandlers = new WeakSet();
/** Creates the OMP extension factory backed by the packaged Node/WASM SDK. */
export function createOmpExtension(options = {}) {
    return (pi) => activateOmpExtension(pi, options);
}
export default createOmpExtension();
function activateOmpExtension(pi, options) {
    // Ownership is checked against the live native runner after loading, when
    // every extension's handlers and suspension state are available.
    const configToml = (process.argv.some((arg) => arg === `--${CHILD_FLAG}=true`) && process.env[OMP_CHILD_CONFIG_ENV]) || loadOmpSpineConfigToml();
    const runtimeFactory = options.runtimeFactory ?? {
        create: (thread) => createNodeSpineRuntime({
            thread,
            features: ["jit", "spawn"],
            configToml,
        }),
    };
    pi.registerFlag(CHILD_FLAG, {
        description: "Run as a typed Spine Spawn child",
        type: "boolean",
        default: false,
    });
    const slot = {
        current: null,
        initialization: null,
        generation: 0,
        fault: null,
        notified: false,
        treeDisplay: new SpineTreeDisplay(),
        samplingPrefix: null,
        shuttingDown: false,
    };
    registerSpineTools(pi, slot, configToml);
    registerSpineTreeCommand(pi, () => slot.fault === null ? slot.current?.latestContext.projection : null);
    pi.events.on(SPINE_TREE_VIEW_REQUEST, (request) => {
        if (slot.current === null || slot.fault !== null)
            return;
        slot.treeDisplay.offer(request, slot.generation, slot.current.latestContext.projection);
    });
    registerLifecycleHandlers(pi, slot, runtimeFactory, options.onSessionReady, options.onSamplingCommit, configToml, options.childInvocation, options.compactionCompletion);
}
function registerSpineTools(pi, slot, configToml) {
    for (const tool of loadCanonicalSpineTools(configToml)) {
        if (tool.name === "spine_spawn") {
            pi.registerTool({
                name: tool.name,
                label: tool.label,
                description: tool.description,
                parameters: tool.parameters,
                async execute(toolCallId, params) {
                    const session = await requireSession(slot);
                    assertCurrentSession(slot, session);
                    const call = decodeControlExecuteCall(tool.name, params);
                    const tasks = decodeSpawnTasks(call.input);
                    return {
                        content: [{ type: "text", text: spineToolResult(session.latestContext.projection, "spine_spawn", call.input, session.runtime.nodePrompt()) }],
                        details: { ...snapshotSpawnView(createSpawnBatchView(tasks)), batchId: toolCallId, staged: true },
                    };
                },
                renderCall(args, _options, theme) {
                    const record = isRecord(args) ? args : {};
                    const tasks = Array.isArray(record.tasks) ? record.tasks : [];
                    return renderSpawnCall(tasks.length, theme);
                },
                renderResult(result, { expanded, cancelled }, theme) {
                    const details = spawnViewFromResult(result, cancelled);
                    if (details === null) {
                        const text = result.content[0];
                        return linesComponent([text?.type === "text" ? text.text : "Spine Spawn"]);
                    }
                    return renderSpawnResult(details, expanded, theme);
                },
                describeCall(args) {
                    const record = isRecord(args) ? args : {};
                    return describeSpawnCall(Array.isArray(record.tasks) ? record.tasks.length : 0);
                },
                describeResult(result, { expanded, cancelled }) {
                    const details = spawnViewFromResult(result, cancelled);
                    if (details === null) {
                        const output = result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
                        return { tool: { title: "Spine Spawn" }, body: [{ k: "text", p: { text: output, wrap: "word" } }] };
                    }
                    return describeSpawnResult(details, expanded);
                },
            });
            continue;
        }
        pi.registerTool({
            name: tool.name,
            label: tool.label,
            description: tool.description,
            parameters: tool.parameters,
            async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
                const session = await requireSession(slot);
                assertCurrentSession(slot, session);
                await session.lifecycle.previewContext();
                assertCurrentSession(slot, session);
                const call = decodeControlExecuteCall(tool.name, params);
                if (!isSpineToolName(call.toolName))
                    throw new Error(`Unknown Spine tool ${call.toolName}`);
                return toolResult(spineToolResult(session.latestContext.projection, call.toolName, call.input, session.runtime.nodePrompt()));
            },
            renderCall() {
                return linesComponent([]);
            },
            renderResult(result, _options, theme) {
                if (!result.isError)
                    return linesComponent([]);
                const text = result.content[0];
                const message = text?.type === "text" ? text.text : `${tool.name}`;
                return linesComponent([theme.fg("error", message)]);
            },
        });
    }
}
function spawnRecoveryPolicy(ctx, pi) {
    if (!ctx.hasUI ||
        pi.getFlag(CHILD_FLAG) ||
        typeof ctx.ui.select !== "function") {
        return undefined;
    }
    return {
        async choose(failure, signal) {
            const choices = [
                ...(failure.continueable ? ["Continue"] : []),
                ...(failure.retryable ? ["Retry"] : []),
                "Abandon",
            ];
            if (choices.length === 1)
                return { action: "abandon" };
            const choice = await ctx.ui.select(`Spine Spawn ${failure.producer.join(".")} failed: ${failure.diagnostic}`, choices, { signal });
            if (choice === undefined)
                return undefined;
            if (choice === "Abandon")
                return { action: "abandon" };
            const guidance = await ctx.ui.input(`${choice} guidance (optional)`, "Leave empty to continue without guidance", { signal });
            if (guidance === undefined)
                return undefined;
            return {
                action: choice.toLowerCase(),
                ...(guidance.trim().length === 0 ? {} : { guidance: guidance.trim().slice(0, 4096) }),
            };
        },
    };
}
function loadCanonicalSpineTools(configToml) {
    const runtime = createNodeSpineRuntime({
        thread: "omp-tool-catalog",
        features: ["jit", "spawn"],
        configToml,
    });
    try {
        return runtime.toolCatalog().map((tool) => ({
            name: `spine_${tool.id}`,
            label: `Spine ${tool.id[0]?.toUpperCase() ?? ""}${tool.id.slice(1)}`,
            description: tool.description,
            parameters: tool.parameters,
        }));
    }
    finally {
        runtime.dispose();
    }
}
function localOmpSession(pi, ctx) {
    const session = pi.pi.AgentRegistry.global().get(ctx.agent.id)?.session;
    // Proxies expose a read-only handle and cannot own local journal/loop hooks.
    return session?.sessionManager === ctx.sessionManager ? session : undefined;
}
function installModelStopGate(pi, ctx, decide) {
    const session = localOmpSession(pi, ctx);
    // /clear rotates the provider session ID, not the journal's SessionManager.
    if (!session
        || typeof session.agent.addBeforeModelCall !== "function") {
        throw new Error("OMP Spine requires its live session's native pre-model-call stop gate");
    }
    return session.agent.addBeforeModelCall(decide);
}
/**
 * OMP has no ownership event protocol. Use its public session/runner metadata.
 * Separate extensions may not register either exclusive hook, including
 * observers: native metadata does not declare whether a callback replaces data.
 * A composed bridge may add observers within the owning extension, but it must
 * not return another context or compaction. Two Spine activations are rejected.
 */
function assertNativeOwnership(pi, ctx, contextHandler) {
    const session = localOmpSession(pi, ctx);
    const runner = session?.extensionRunner;
    if (session?.sessionManager !== ctx.sessionManager || runner === undefined) {
        throw new Error("OMP Spine ownership requires its live native extension runner");
    }
    let ownerFound = false;
    for (const extension of runner.getLoadedExtensions()) {
        if (!runner.isExtensionActive(extension.path))
            continue;
        const context = extension.handlers.get("context");
        const compact = extension.handlers.get("session_before_compact");
        let ownsContext = false;
        let spineCount = 0;
        if (context !== undefined) {
            for (const handler of context) {
                if (handler === contextHandler)
                    ownsContext = true;
                if (spineContextHandlers.has(handler))
                    spineCount += 1;
            }
        }
        if (ownsContext) {
            if (ownerFound || spineCount !== 1) {
                throw new Error(`OMP Spine ownership conflict: duplicate Spine instances in ${extension.path}`);
            }
            ownerFound = true;
            continue;
        }
        if ((context?.length ?? 0) > 0 || (compact?.length ?? 0) > 0) {
            throw new Error(`OMP Spine ownership conflict: ${extension.path} registers ${(context?.length ?? 0) > 0 ? "context" : "session_before_compact"}. Load only one context/compaction owner.`);
        }
    }
    if (!ownerFound)
        throw new Error("OMP Spine ownership conflict: this Spine extension is not active in its native runner");
}
function registerLifecycleHandlers(pi, slot, runtimeFactory, onSessionReady, onSamplingCommit, configToml, childInvocation, compactionCompletion) {
    let mainTurnOpen = false;
    let endingTurn = false;
    const queuedArrivals = new Map();
    function flushArrivals(ctx, session) {
        if (mainTurnOpen || endingTurn || session.lifecycle.samplingActive || slot.fault !== null)
            return;
        let wakeParent = false;
        for (const { arrival, wake } of queuedArrivals.values()) {
            wakeParent = deliverOmpArrival(pi, ctx, session, arrival, wake) || wakeParent;
        }
        queuedArrivals.clear();
        if (wakeParent)
            pi.sendMessage({ customType: "spine-arrival-wake", content: "A Spine child finished. See its result in context.", display: false }, { deliverAs: "nextTurn", triggerTurn: true });
    }
    let samplingAdmission = Promise.resolve();
    let samplingSettled = Promise.resolve();
    const stopParentWatch = watchOmpChildParent();
    let removeModelStopGate = null;
    let resetBoundaryId = null;
    let compactApplied = Promise.resolve();
    let compactJob = null;
    function nativeSession(ctx) {
        return localOmpSession(pi, ctx);
    }
    function releaseCompaction(job) {
        if (compactJob !== job)
            return;
        compactJob = null;
        clearTimeout(job.expiry);
        job.controller.abort();
    }
    function compactionIsCurrent(ctx, job) {
        return compactJob === job && !job.controller.signal.aborted && slot.generation === job.generation
            && !slot.shuttingDown && slot.fault === null && ctx.model === job.model
            && (!job.automatic || nativeSession(ctx)?.autoCompactionEnabled === true)
            && ctx.sessionManager.getLeafId() === job.leaf;
    }
    const reinitialize = async (hook, ctx, cut) => {
        const branch = ctx.sessionManager.getBranch();
        if (compactJob)
            releaseCompaction(compactJob);
        compactApplied = Promise.resolve();
        resetBoundaryId = branch[ompResetBoundaryIndex(branch)]?.id ?? null;
        mainTurnOpen = false;
        queuedArrivals.clear();
        endingTurn = false;
        removeModelStopGate?.();
        removeModelStopGate = null;
        slot.fault = null;
        slot.notified = false;
        slot.samplingPrefix = null;
        samplingAdmission = Promise.resolve();
        samplingSettled = Promise.resolve();
        const pending = beginSessionInitialization(slot, async () => {
            const generation = slot.generation;
            const assertGeneration = () => {
                if (slot.generation !== generation)
                    throw abortError("OMP Spine session changed");
            };
            // Install for every main run, before initialization can fail. Native hook
            // dispatch contains handler errors; this core gate is the fail-closed fence.
            removeModelStopGate = installModelStopGate(pi, ctx, async (wire, signal) => {
                await compactApplied;
                assertGeneration();
                assertNativeOwnership(pi, ctx, onContext);
                if (signal?.aborted)
                    return { stop: true, reason: "Cancelled" };
                if (slot.current === null)
                    throw new Error("OMP Spine session is not initialized", { cause: slot.fault });
                assertCurrentSession(slot, slot.current);
                if (wire && ctx.model?.contextWindow) {
                    const tokenizer = new Tokenizer(ctx.model);
                    const { messages, systemPrompt = [], tools = [] } = wire;
                    if (countOmpPromptTokens(tokenizer, messages, systemPrompt, tools) >= ctx.model.contextWindow) {
                        let lastUser = messages.length - 1;
                        while (lastUser >= 0 && messages[lastUser]?.role !== "user")
                            lastUser--;
                        if (lastUser < 0 || countOmpPromptTokens(tokenizer, messages.slice(lastUser), systemPrompt, tools) >= ctx.model.contextWindow) {
                            throw new Error("Spine latest turn and fixed prompt exceed the model window; shorten the input or use a larger context model");
                        }
                        if (nativeSession(ctx)?.autoCompactionEnabled === true && startCompaction(ctx, undefined, true)) {
                            throw new Error("Spine projected history exceeds the model window; wait for compaction and retry, or use a larger context model");
                        }
                        throw new Error("Spine projected history exceeds the model window; run /compact or use a larger context model");
                    }
                }
                return undefined;
            });
            assertNativeOwnership(pi, ctx, onContext);
            assertOmpV3ReplayBranch(ctx.sessionManager.getBranch());
            if (cut) {
                const rewind = ompRewindLeaf(ctx.sessionManager.getBranch());
                if (rewind !== null) {
                    const live = localOmpSession(pi, ctx);
                    if (live?.sessionManager !== ctx.sessionManager) {
                        throw new Error("OMP rewind requires the active native session manager");
                    }
                    if (rewind.leafId === null)
                        live.sessionManager.resetLeaf();
                    else
                        live.sessionManager.branch(rewind.leafId);
                }
            }
            return initializeSession(pi, ctx, runtimeFactory, assertGeneration, (session, arrival, wake) => {
                if (slot.current !== session || slot.shuttingDown || slot.generation !== generation || slot.fault !== null)
                    return;
                queuedArrivals.set(arrival.producer.join("."), { arrival, wake });
                flushArrivals(ctx, session);
            }, onSessionReady);
        });
        const generation = slot.generation;
        try {
            await pending;
            if (slot.generation !== generation)
                return;
            const session = await requireSession(slot);
            renderSpineTree(ctx, slot, session);
            recoverOmpChildren(pi, ctx, session, configToml, childInvocation, () => assertCurrentSession(slot, session));
        }
        catch (cause) {
            if (slot.generation === generation) {
                if (cause instanceof OmpLegacyJournalError) {
                    slot.fault = cause;
                    ctx.ui.notify(cause.message, "warning");
                    return;
                }
                recordSpineFault(pi, slot, ctx, { hook, stage: "initialize_session" }, cause, false);
            }
        }
    };
    const refreshNativeReset = async (ctx) => {
        const branch = ctx.sessionManager.getBranch();
        const resetId = branch[ompResetBoundaryIndex(branch)]?.id ?? null;
        if (resetId !== resetBoundaryId)
            await reinitialize("reset_boundary", ctx, false);
    };
    pi.on("session_start", async (_event, ctx) => reinitialize("session_start", ctx, false));
    pi.on("session_switch", async (_event, ctx) => reinitialize("session_switch", ctx, false));
    pi.on("session_branch", async (_event, ctx) => reinitialize("session_branch", ctx, true));
    pi.on("session_tree", async (_event, ctx) => reinitialize("session_tree", ctx, true));
    pi.on("session_shutdown", (_event, ctx) => {
        slot.shuttingDown = true;
        if (compactJob)
            releaseCompaction(compactJob);
        // Direct/RPC reload may run while a context handler is suspended. Cancel
        // while its host ctx is still active; after invalidation ctx.abort throws.
        if (!ctx.isIdle())
            ctx.abort();
        removeModelStopGate?.();
        removeModelStopGate = null;
        stopParentWatch?.();
        slot.fault = abortError("OMP Spine session shut down");
        slot.generation += 1;
        slot.samplingPrefix = null;
        disposeCurrent(slot);
        slot.initialization = null;
        slot.treeDisplay.reset();
    });
    pi.on("message_end", async (event, ctx) => {
        await refreshNativeReset(ctx);
        await guardHook(pi, slot, ctx, { hook: "message_end", stage: "observe_message" }, async () => {
            const generation = slot.generation;
            const session = await requireSession(slot);
            if (slot.generation !== generation)
                return;
            // Host-only messages can follow live Spawn staging. Reconcile that
            // durable tail at turn_end, not as an independently replayable prefix.
            if (event.message.role !== "user" && event.message.role !== "assistant")
                return;
            await drainOmpMessagePersistence();
            if (slot.generation !== generation)
                return;
            await observeOmpMessageSource(session, ctx, event.message);
        }, false);
    });
    const onContext = async (event, ctx) => {
        const mainTurnWasOpen = mainTurnOpen;
        await refreshNativeReset(ctx);
        const hostMessages = Array.isArray(event?.messages)
            ? event.messages.filter((message) => !isOmpBranchStateMessage(message))
            : undefined;
        const generation = slot.generation;
        try {
            await compactApplied;
            assertNativeOwnership(pi, ctx, onContext);
            const session = await requireSession(slot);
            if (slot.generation !== generation)
                return {};
            await drainOmpMessagePersistence();
            if (slot.generation !== generation)
                return {};
            let branch = ctx.sessionManager.getBranch();
            let persistedMessages = branch.flatMap(sessionEntryToOmpMessages);
            const transientMessages = hostMessages === undefined ? [] : mergeHostTranscripts([], hostMessages, persistedMessages);
            // Native live steering transforms only its queued batch while the main
            // reply is still streaming. Preserve that wire input without admitting it
            // before the assistant or replacing it with a whole Spine context.
            if ((mainTurnWasOpen || hostMessages?.every((message) => message.role === "user" && "steering" in message && message.steering === true))
                && hostMessages !== undefined && hostMessages.length > 0
                && persistedMessages.length > 0
                && transientMessages.length === hostMessages.length) {
                return { messages: hostMessages };
            }
            const detachedStart = detachedOmpContextStart(hostMessages, persistedMessages);
            if (detachedStart === null) {
                await observePersistedOmpSources(session, ctx);
            }
            if (slot.generation !== generation)
                return {};
            await session.lifecycle.previewContext();
            if (slot.generation !== generation)
                return {};
            assertCurrentSession(slot, session);
            branch = ctx.sessionManager.getBranch();
            persistedMessages = branch.flatMap(sessionEntryToOmpMessages);
            const projected = session.materializeMessages(branch);
            if (detachedStart === null) {
                for (const message of transientMessages) {
                    if (!isOmpSourceMessage(message) || message.role === "assistant")
                        continue;
                    const key = ompNativeMessageKey(message);
                    if (!projected.some((source) => ompNativeMessageKey(source) === key))
                        projected.push(message);
                }
            }
            const host = mergeHostTranscripts(flattenBranchMessages(branch), detachedStart === null ? hostMessages : undefined, persistedMessages);
            const messages = spliceLiveHostTranscript(projected, host, persistedMessages);
            if (detachedStart !== null && hostMessages !== undefined) {
                // Native side snapshots can replace the streaming main reply. Keep that
                // unpersisted prefix and the entire side reminder/history/prompt detached.
                messages.push(...mergeHostTranscripts([], hostMessages.slice(0, detachedStart), persistedMessages)
                    .filter((message) => message.role !== "user" || !projected.some((projectedMessage) => projectedMessage.role === "user" && projectedMessage.timestamp === message.timestamp)), ...hostMessages.slice(detachedStart));
            }
            if (messages.length === 0 && host.length > 0) {
                return { messages: host };
            }
            renderSpineTree(ctx, slot, session);
            return {
                messages: structuredClone(messages),
            };
        }
        catch (cause) {
            if (slot.generation !== generation)
                return {};
            if (slot.current === null && isAbortError(slot.fault)) {
                return hostMessages !== undefined ? { messages: hostMessages } : { messages: [] };
            }
            recordSpineFault(pi, slot, ctx, { hook: "context", stage: "preview_context" }, cause, false);
            return hostMessages !== undefined ? { messages: hostMessages } : { messages: [] };
        }
    };
    spineContextHandlers.add(onContext);
    pi.on("context", onContext);
    pi.on("turn_start", () => {
        // Native main turns open only after context preparation and the pre-model
        // gate. Ephemeral turns use the same provider hooks without these events.
        mainTurnOpen = true;
    });
    pi.on("before_provider_request", async (event, ctx) => {
        try {
            assertNativeOwnership(pi, ctx, onContext);
        }
        catch (cause) {
            faultAndAbort(pi, slot, ctx, { hook: "before_provider_request", stage: "native_ownership" }, cause);
            return;
        }
        if (!mainTurnOpen)
            return;
        const generation = slot.generation;
        samplingAdmission = samplingAdmission.then(async () => {
            if (!mainTurnOpen || slot.generation !== generation)
                return;
            await guardHook(pi, slot, ctx, { hook: "before_provider_request", stage: "begin_sampling" }, async () => {
                const session = await requireSession(slot);
                if (!mainTurnOpen || slot.generation !== generation || slot.current !== session)
                    return;
                if (session.lifecycle.fault !== null)
                    return;
                // Native can still have the primary user persistence queued when this
                // provider hook begins. Drain it before snapshotting the durable prefix.
                if (!session.lifecycle.samplingActive) {
                    await drainOmpMessagePersistence();
                    if (!mainTurnOpen || slot.generation !== generation || slot.current !== session)
                        return;
                    if (slot.samplingPrefix === null) {
                        slot.samplingPrefix = structuredClone(ctx.sessionManager.getBranch());
                    }
                    await observePersistedOmpSources(session, ctx);
                }
                if (!mainTurnOpen || slot.generation !== generation || slot.current !== session)
                    return;
                await session.lifecycle.ensureSampling(event.payload);
            }, false);
        });
        await samplingAdmission;
    });
    const onBeforeAgentStart = async (_event, ctx) => {
        try {
            await refreshNativeReset(ctx);
            const generation = slot.generation;
            const session = await requireSession(slot);
            if (slot.generation !== generation)
                return;
            await drainOmpMessagePersistence();
            if (slot.generation !== generation)
                return;
            await observePersistedOmpSources(session, ctx);
            if (slot.generation !== generation)
                return;
            await session.lifecycle.previewContext();
            if (slot.generation !== generation)
                return;
            return { systemPrompt: [...ctx.getSystemPrompt(), session.runtime.extendSystemPrompt("")] };
        }
        catch {
            return;
        }
    };
    pi.on("before_agent_start", onBeforeAgentStart);
    pi.on("tool_call", async (event, ctx) => {
        const generation = slot.generation;
        const call = decodeHostToolCall(event.toolName, event.input);
        try {
            if (!isSpineToolName(call.toolName))
                return undefined;
            if (!mainTurnOpen) {
                return { block: true, reason: "Spine sampling has not started" };
            }
            const session = await requireSession(slot);
            if (slot.generation !== generation)
                return { block: true, reason: "Spine session changed" };
            await session.lifecycle.ensureSampling();
            if (slot.generation !== generation)
                return { block: true, reason: "Spine session changed" };
            if (!session.lifecycle.samplingActive) {
                return { block: true, reason: "Spine sampling has not started" };
            }
            const refusal = spineToolRefusal(session.latestContext.projection, call.toolName, session.lifecycle.enteredArrivals, session.birth, Math.max(1, session.lifecycle.responseCalls));
            if (refusal !== null) {
                if (ctx.mode === "tui" && isControlToolName(call.toolName))
                    ctx.ui.notify(refusal, "warning");
                return { block: true, reason: refusal };
            }
            await session.lifecycle.registerToolCall(event.toolCallId, call.toolName, call.input);
            if (slot.generation !== generation)
                return { block: true, reason: "Spine session changed" };
            return undefined;
        }
        catch (cause) {
            if (slot.generation !== generation)
                return { block: true, reason: "Spine session changed" };
            if (cause instanceof OmpSpineToolLimitError) {
                return { block: true, reason: cause.message };
            }
            if (cause instanceof SpineToolInputError)
                return { block: true, reason: cause.message };
            if (cause instanceof OmpSamplingLifecycleError && cause.cause instanceof SpineToolInputError) {
                return { block: true, reason: cause.cause.message };
            }
            if (isOutsideSampling(cause)) {
                return { block: true, reason: "Spine sampling has not started" };
            }
            recordSpineFault(pi, slot, ctx, { hook: "tool_call", stage: "register_tool_call" }, cause, false);
            const detail = cause instanceof Error ? cause.message : String(cause);
            return { block: true, reason: `Spine durability is faulted: ${detail}` };
        }
    });
    pi.on("tool_result", async (event, ctx) => {
        await guardHook(pi, slot, ctx, { hook: "tool_result", stage: "finish_tool_call" }, async () => {
            await (await requireSession(slot)).lifecycle.finishToolCall(event.toolCallId, !event.isError);
        }, false);
    });
    pi.on("turn_end", async (event, ctx) => {
        mainTurnOpen = false;
        endingTurn = true;
        const generation = slot.generation;
        const prefix = slot.samplingPrefix;
        slot.samplingPrefix = null;
        const boundary = { hook: "turn_end", stage: "finish_sampling" };
        const settlement = guardHook(pi, slot, ctx, boundary, async () => {
            // Drain a side provider hook admitted while the main turn was still open.
            // It must not resume sampling after this turn's commit has closed it.
            await samplingAdmission;
            if (slot.generation !== generation)
                return;
            const session = await requireSession(slot);
            if (slot.generation !== generation)
                return;
            await drainOmpMessagePersistence();
            if (slot.generation !== generation)
                return;
            await observeOmpMessageSource(session, ctx, event.message, true);
            if (slot.generation !== generation)
                return;
            const commit = await session.lifecycle.finishTurn({
                message: event.message,
                aborted: event.message.role === "assistant" && event.message.stopReason === "aborted",
            });
            if (slot.generation !== generation)
                return;
            if (commit === null || commit.type !== "committed")
                return;
            if (commit.record.type === "sampling_commit" && prefix) {
                const origin = session.ownArchiveTail.commit;
                const record = commit.record.record;
                if (origin && record.executions.some(({ operation }) => operation.type === "spawn")) {
                    ctx.sessionManager.flushSync();
                    const births = unarrivedBirths(commit.projection).filter((birth) => birth.start === record.post_boundary.ordinal);
                    launchOmpChildren(pi, ctx, session, births, origin, prefix, configToml, childInvocation, () => assertCurrentSession(slot, session));
                }
            }
            const commitInfo = {
                sessionId: ctx.sessionManager.getSessionId(),
                commit,
                entries: ctx.sessionManager.getBranch(),
            };
            boundary.stage = "sampling_commit_observer";
            await onSamplingCommit?.(commitInfo);
            if (slot.generation !== generation)
                return;
            boundary.stage = "render_tree";
            renderSpineTree(ctx, slot, await requireSession(slot));
        }, false);
        // Native turn notifications and post-turn maintenance run concurrently.
        // Include publication/observers, not only the serialized runtime commit.
        // Always release the fence, including faulted or superseded generations.
        samplingSettled = samplingSettled.then(() => settlement, () => settlement).then(() => { }, () => { });
        await settlement;
        if (slot.generation !== generation)
            return;
        endingTurn = false;
        if (slot.current)
            flushArrivals(ctx, slot.current);
    });
    // In print mode OMP would exit at the first plain reply, even when a
    // Spawn child is still completing. Hold only the headless stop boundary.
    pi.on("session_stop", async (event, ctx) => {
        if (ctx.hasUI || ctx.mode === "rpc" || event.signal.aborted)
            return;
        const generation = slot.generation;
        await samplingSettled;
        const session = slot.current;
        if (!session || slot.generation !== generation || slot.fault !== null || !session.children.running)
            return;
        const wait = Promise.withResolvers();
        const abort = () => { session.children.stop(); wait.resolve(); };
        event.signal.addEventListener("abort", abort, { once: true });
        try {
            await Promise.race([session.children.next(), wait.promise]);
        }
        finally {
            event.signal.removeEventListener("abort", abort);
        }
    });
    function startCompaction(ctx, instructions, policy) {
        const model = ctx.model;
        const session = slot.current;
        const generation = slot.generation;
        if (!model || !session || slot.fault !== null || slot.shuttingDown)
            return null;
        const leaf = ctx.sessionManager.getLeafId();
        if (leaf === null)
            return null;
        if (compactJob && compactionIsCurrent(ctx, compactJob) && compactJob.instructions === instructions)
            return compactJob;
        if (compactJob)
            releaseCompaction(compactJob);
        const controller = new AbortController();
        const job = {
            controller, model, instructions, leaf, generation, automatic: policy, deferred: policy,
            promise: Promise.resolve().then(async () => {
                await samplingSettled;
                await compactApplied;
                if (controller.signal.aborted || slot.generation !== generation || session.lifecycle.samplingActive
                    || ctx.model !== model || slot.fault !== null)
                    return null;
                const branch = ctx.sessionManager.getBranch();
                const origin = branch.findIndex((entry) => entry.id === leaf);
                if (origin < 0 || branch.slice(origin + 1).some((entry) => entry.id !== session.ownArchiveTail.source && entry.id !== session.ownArchiveTail.commit))
                    return null;
                job.leaf = branch.at(-1)?.id ?? null;
                if (!compactionIsCurrent(ctx, job) || !job.leaf)
                    return null;
                const projection = projectOmpSession(branch);
                await observeOmpBranchSources(session, ctx.sessionManager.getSessionId(), branch);
                await session.lifecycle.previewContext();
                assertCurrentSession(slot, session);
                if (unarrivedBirths(session.latestContext.projection).length > 0) {
                    if (!policy && ctx.hasUI)
                        ctx.ui.notify("Spine compaction waits for spawned children to arrive and be committed", "warning");
                    return null;
                }
                const visible = spliceLiveHostTranscript(session.materializeMessages(branch), projection.messages, projection.messages)
                    .filter((message) => !isOmpHostSystemMessage(message));
                const tokenizer = new Tokenizer(model);
                const tokensBefore = tokenizer.countMessages(visible);
                const keepBudget = Math.min(20_000, Math.floor((model.contextWindow ?? 128_000) / 8));
                const candidates = projection.entries.filter(({ messages }) => messages.some((message) => message.role === "user"));
                const last = candidates.at(-1);
                if (!last || (policy && candidates.length < 2))
                    return null;
                let firstKeptEntryId = last.sourceEntry.id;
                let tail = 0;
                for (const { sourceEntry, messages } of [...projection.entries].reverse()) {
                    tail += tokenizer.countMessages(messages);
                    if (tail > keepBudget)
                        break;
                    if (sourceEntry.id !== candidates[0]?.sourceEntry.id && messages.some((message) => message.role === "user")) {
                        firstKeptEntryId = sourceEntry.id;
                    }
                }
                const summary = await summarizeOmpCompaction(model, visible, instructions, controller.signal, ctx, pi, compactionCompletion);
                assertCurrentSession(slot, session);
                if (!compactionIsCurrent(ctx, job))
                    return null;
                const retained = retainedOmpMessages({ branchEntries: branch, preparation: { firstKeptEntryId } }, visible);
                const source = await session.lifecycle.sourceSnapshot();
                assertCurrentSession(slot, session);
                if (!compactionIsCurrent(ctx, job) || !job.leaf)
                    return null;
                const replacementMessages = [
                    { role: "compactionSummary", summary, tokensBefore, timestamp: Date.now() }, ...retained.messages,
                ];
                const receipt = {
                    schema: OMP_ADAPTER_ID, barrier: buildCompactBarrier(source, replacementMessages.length),
                    replacementMessages, replacementEntryIds: [null, ...retained.entryIds],
                    preparedLeafId: job.leaf,
                    nativeAcknowledgement: { firstKeptEntryId, tokensBefore },
                };
                return { summary, firstKeptEntryId, tokensBefore, details: { [OMP_COMPACT_ENTRY_TYPE]: receipt } };
            }).catch((cause) => {
                if (!controller.signal.aborted && slot.generation === generation && !isAbortError(cause))
                    notifyOmpCompactionFailure(ctx, cause);
                return null;
            }),
        };
        compactJob = job;
        job.expiry = setTimeout(() => {
            if (compactionIsCurrent(ctx, job))
                notifyOmpCompactionFailure(ctx, new Error("Spine compaction timed out"));
            releaseCompaction(job);
        }, 120_000);
        job.expiry.unref();
        void job.promise.then((result) => {
            if (!result) {
                releaseCompaction(job);
                return;
            }
            if (!job.deferred)
                return;
            // Wait for the originating /compact or prompt to unwind. Never apply an
            // earlier snapshot to a newer turn or hold a stale result indefinitely.
            const apply = async (remaining) => {
                if (!compactionIsCurrent(ctx, job))
                    return releaseCompaction(job);
                const native = nativeSession(ctx);
                if (!ctx.isIdle() || native?.isCompacting || native?.isStreaming) {
                    if (remaining > 0)
                        setTimeout(() => void apply(remaining - 1), 100);
                    else
                        releaseCompaction(job);
                    return;
                }
                try {
                    await ctx.compact(instructions);
                }
                catch (cause) {
                    if (compactionIsCurrent(ctx, job) && !isAbortError(cause))
                        notifyOmpCompactionFailure(ctx, cause);
                }
                finally {
                    releaseCompaction(job);
                }
            };
            setTimeout(() => void apply(100), 0);
        });
        return job;
    }
    // Abort native automatic maintenance before its in-place rescue or summary
    // paths. Read the live preference for Spine's own schedule; never override it.
    pi.on("auto_compaction_start", (_event, ctx) => nativeSession(ctx)?.abortCompaction());
    pi.on("agent_end", async (event, ctx) => {
        if (event.willContinue)
            return;
        const generation = slot.generation;
        await samplingSettled;
        await compactApplied;
        const session = slot.current;
        if (!session || slot.generation !== generation || slot.fault !== null || session.lifecycle.samplingActive)
            return;
        const aborted = event.messages.findLast((message) => message.role === "assistant")?.stopReason === "aborted";
        if (aborted)
            session.children.stop();
        session.children.settle(unarrivedBirths(session.latestContext.projection)
            .filter((birth) => !session.lifecycle.enteredArrivals.has(birth.producer.join("."))), aborted);
        if (aborted || !nativeSession(ctx)?.autoCompactionEnabled || !ctx.model?.contextWindow)
            return;
        const branch = ctx.sessionManager.getBranch();
        const visible = session.materializeMessages(branch);
        const tokenizer = new Tokenizer(ctx.model);
        const usage = countOmpPromptTokens(tokenizer, visible, ctx.getSystemPrompt(), currentOmpToolDeclarations(pi));
        if (usage >= ctx.model.contextWindow * 0.70)
            startCompaction(ctx, undefined, true);
    });
    let selectedCompaction = null;
    pi.on("session_before_compact", async (event, ctx) => {
        selectedCompaction = null;
        if (event.signal.aborted || !slot.current || slot.fault !== null || slot.shuttingDown)
            return { cancel: true };
        assertNativeOwnership(pi, ctx, onContext);
        const job = startCompaction(ctx, event.customInstructions, false);
        if (!job)
            return { cancel: true };
        const abort = () => releaseCompaction(job);
        event.signal.addEventListener("abort", abort, { once: true });
        let deadline;
        try {
            const result = await Promise.race([
                job.promise,
                new Promise((resolve) => { deadline = setTimeout(resolve, 1500, "defer"); }),
            ]);
            if (result === "defer") {
                job.deferred = true;
                return { cancel: true };
            }
            if (!result || event.signal.aborted || !compactionIsCurrent(ctx, job)) {
                releaseCompaction(job);
                return { cancel: true };
            }
            selectedCompaction = { event, result, job };
            return undefined;
        }
        finally {
            clearTimeout(deadline);
            event.signal.removeEventListener("abort", abort);
        }
    });
    // Only the second, synchronous hook may hand a result to OMP. If the
    // preparation hook timed out or failed, this hook vetoes native fallback.
    pi.on("session_before_compact", (event, ctx) => {
        const selected = selectedCompaction;
        selectedCompaction = null;
        if (selected?.event !== event)
            return { cancel: true };
        if (event.signal.aborted || !compactionIsCurrent(ctx, selected.job)) {
            releaseCompaction(selected.job);
            return { cancel: true };
        }
        return { compaction: selected.result };
    });
    pi.on("session_compact", async (event, ctx) => {
        const generation = slot.generation;
        const entry = event.compactionEntry;
        const settled = compactApplied.then(async () => {
            const session = await requireSession(slot);
            if (slot.generation !== generation || slot.fault !== null || slot.shuttingDown)
                return;
            if (!entry)
                throw new Error("OMP compaction completed without a journal entry");
            const committed = ctx.sessionManager.getBranch().find((candidate) => candidate.id === entry.id);
            if (!committed || session.appliedCompactions.has(entry.id))
                return;
            const receipt = readOmpNativeCompactReceipt(committed);
            if (!receipt)
                throw new Error("OMP native compaction completed without Spine interception");
            ctx.sessionManager.flushSync();
            session.committedCompact = receipt;
            try {
                const retainedIds = receipt.replacementEntryIds?.slice(1) ?? receipt.replacementMessages.slice(1).map(() => null);
                await session.lifecycle.compact(receipt.barrier, receipt.replacementMessages, [entry.id, ...retainedIds]);
                session.appliedCompactions.add(entry.id);
                if (compactJob?.leaf === committed.parentId)
                    releaseCompaction(compactJob);
            }
            finally {
                session.committedCompact = null;
            }
            if (slot.generation === generation)
                renderSpineTree(ctx, slot, session);
        }).catch((cause) => {
            if (slot.generation === generation)
                faultAndAbort(pi, slot, ctx, { hook: "session_compact", stage: "apply_receipt" }, cause);
        });
        compactApplied = settled;
        await settled;
    });
}
function countOmpPromptTokens(tokenizer, messages, system, tools) {
    const declarations = tools.flatMap(({ name, description, parameters }) => [name, description, JSON.stringify(parameters) ?? ""]);
    return tokenizer.countMessages(messages) + tokenizer.countTokens(system) + tokenizer.countTokens(declarations);
}
async function summarizeOmpCompaction(model, visible, instructions, signal, ctx, pi, compactionCompletion) {
    signal.throwIfAborted();
    const tools = currentOmpToolDeclarations(pi);
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok)
        throw new Error(auth.error);
    // The host supplies this Bun-native client; it is not an installed plugin dependency.
    const complete = compactionCompletion ?? (await import("@oh-my-pi/pi-ai")).completeSimple;
    const completionMessages = convertToLlm(visible);
    const response = await complete(model, {
        ...(tools.length > 0 ? { tools } : {}),
        messages: [
            ...completionMessages,
            {
                role: "user",
                content: [{
                        type: "text",
                        text: `Create a concise structured continuation summary for this session.${instructions ? `\n\nFocus: ${instructions}` : ""}`,
                    }],
                timestamp: Date.now(),
            },
        ],
    }, {
        ...(auth.apiKey === undefined ? {} : { apiKey: auth.apiKey }),
        ...(auth.headers === undefined ? {} : { headers: auth.headers }),
        maxTokens: ompNativeSummaryMaxTokens(undefined, model.maxTokens),
        signal,
        cacheRetention: "none",
        sessionId: randomUUID(),
    });
    if (signal.aborted || response.stopReason === "aborted") {
        throw abortError("OMP compaction summarization aborted");
    }
    if (response.stopReason === "error") {
        const detail = typeof response.errorMessage === "string" ? response.errorMessage.trim() : "";
        throw new Error(detail.length > 0 ? detail : "OMP compaction model returned stopReason=error");
    }
    const summary = response.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n")
        .trim();
    if (summary.length === 0)
        throw new Error("OMP compaction model returned an empty summary");
    return summary;
}
function currentOmpToolDeclarations(pi) {
    const enabled = new Set(pi.getActiveTools());
    // The native schemas may be ArkType functions; preserve them instead of JSON-cloning ToolInfo.
    const tools = pi.getAllTools();
    return tools.filter((tool) => enabled.has(tool.name));
}
function ompNativeSummaryMaxTokens(reserveTokens, modelMaxTokens) {
    return Math.min(MAX_SUMMARY_TOKENS, Math.floor(0.8 * (reserveTokens ?? DEFAULT_RESERVE_TOKENS)), modelMaxTokens !== null && modelMaxTokens > 0 ? modelMaxTokens : Number.POSITIVE_INFINITY);
}
function retainedOmpMessages(event, visible) {
    const projection = projectOmpSession(event.branchEntries);
    const start = projection.entries.findIndex((entry) => entry.sourceEntry.id === event.preparation.firstKeptEntryId);
    if (start < 0)
        throw new Error("OMP compaction first-kept entry is missing from the active branch");
    const visibleByKey = new Map(visible.filter((message) => !ompArrivalOf(message)).map((message) => [ompNativeMessageKey(message), message]));
    const messages = [];
    const entryIds = [];
    for (const entry of projection.entries.slice(start)) {
        for (const message of entry.messages) {
            const retained = visibleByKey.get(ompNativeMessageKey(message));
            if (!retained || isOmpHostSystemMessage(retained))
                continue;
            messages.push(retained);
            entryIds.push(entry.sourceEntry.id);
        }
    }
    return { messages, entryIds };
}
function flattenBranchMessages(branch) {
    return projectOmpSession(branch).messages.filter((message) => !isOmpHostSystemMessage(message));
}
/** Native persistence is a synchronous sink on a promise tail queued before emit. */
async function drainOmpMessagePersistence() {
    // OMP 18.8.6 queues message_end before extension emit. Its persistence .then
    // callback is #persistMessageEnd(): void (synchronous append), and the tail
    // has only finally/catch microtasks. setImmediate is one queue barrier, not
    // a timed wait: every already queued persistence callback drains before it.
    await new Promise((resolve) => setImmediate(resolve));
}
function projectedOmpMessages(projection) {
    const projected = new Map();
    for (const entry of projection.entries) {
        projected.set(entry.sourceEntry.id, entry.messages.filter((message) => !isOmpHostSystemMessage(message)));
    }
    return projected;
}
/**
 * Native ephemeral snapshots end in an agent-attributed user prompt, preceded
 * by an unpersisted agent-attributed developer reminder and optional history.
 * Durable agent reminders are ordinary main sources, not a side delimiter.
 */
function detachedOmpContextStart(messages, persistedMessages) {
    const last = messages?.at(-1);
    if (messages === undefined || last?.role !== "user" || last.attribution !== "agent")
        return null;
    const transient = mergeHostTranscripts([], messages, persistedMessages);
    if (!transient.includes(last))
        return null;
    for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index];
        if (message.role === "developer" && message.attribution === "agent"
            && transient.includes(message)) {
            return index;
        }
    }
    return null;
}
async function observePersistedOmpSources(session, ctx) {
    await observeOmpBranchSources(session, ctx.sessionManager.getSessionId(), ctx.sessionManager.getBranch());
}
async function observeOmpMessageSource(session, ctx, message, includeFollowing = false) {
    if (!isOmpSourceMessage(message))
        return;
    if (message.role === "assistant" && message.stopReason === "error" && isRecord(message.stopDetails)
        && (message.stopDetails.type === "refusal" || message.stopDetails.type === "sensitive"))
        return;
    const branch = ctx.sessionManager.getBranch();
    // Match native persistence identity, not display bytes. Reconcile the prefix
    // so queued durable custom notices retain their position before a later user.
    let index = branch.length - 1;
    for (; index >= 0; index -= 1) {
        const entry = branch[index];
        if (entry.type !== "message")
            continue;
        const raw = entry.message;
        if (raw.role === "user" && message.role === "user"
            && raw.timestamp === message.timestamp
            && (raw.attribution ?? "") === (message.attribution ?? ""))
            break;
        if (raw.role === "assistant" && message.role === "assistant"
            && raw.timestamp === message.timestamp
            && raw.provider === message.provider
            && raw.model === message.model
            && (raw.responseId ?? "") === (message.responseId ?? "")
            && raw.stopReason === message.stopReason)
            break;
    }
    // Display and queued messages remain wire input until native persistence gives
    // them a position. Admitting them here can overtake an in-flight assistant.
    if (index < 0)
        return;
    const following = includeFollowing ? [] : undefined;
    if (following !== undefined) {
        for (let tail = index + 1; tail < branch.length; tail += 1) {
            for (const source of sessionEntryToOmpMessages(branch[tail])) {
                if (isOmpSourceMessage(source) && !ompArrivalOf(source))
                    following.push(source);
            }
        }
    }
    if (!includeFollowing || !branch.slice(index + 1).some((entry) => extractOmpArrival(entry))) {
        branch.length = index + 1; // Native getBranch returns a defensive snapshot.
        await observeOmpBranchSources(session, ctx.sessionManager.getSessionId(), branch, following);
    }
    else
        await observeOmpBranchSources(session, ctx.sessionManager.getSessionId(), branch);
}
async function observeOmpBranchSources(session, sessionId, branch, extraMessages) {
    const plan = buildOmpReplayPlan({
        currentSessionId: sessionId,
        branch,
        messagesForEntry: (entry) => sessionEntryToOmpMessages(entry),
        ...(extraMessages === undefined ? {} : { extraMessages }),
    });
    await session.lifecycle.observePersistedSources(plan.sources);
}
// Host edits can change the rendered view without changing the core plan.
// Bind entry ids and project that view from one synchronous branch snapshot.
function materializeFromBranch(publication, bindings, branch, nodePrompt) {
    assignMissingOmpSourceEntryIds(bindings, branch);
    const projection = projectOmpSession(branch);
    return spliceOmpGeneratedContext(materializeOmpContext(publication, bindings, {
        nodePrompt,
        projectedMessages: projectedOmpMessages(projection),
    }), projection);
}
function assignMissingOmpSourceEntryIds(bindings, branch) {
    let sources;
    try {
        sources = buildOmpReplayPlan({
            currentSessionId: "omp-projection",
            branch,
            messagesForEntry: (entry) => sessionEntryToOmpMessages(entry),
        }).sources;
    }
    catch {
        return;
    }
    bindings.assignEntryIds(sources.map((source) => source.entryId));
}
async function initializeSession(pi, ctx, runtimeFactory, assertGeneration, deliver, onSessionReady) {
    const branch = ctx.sessionManager.getBranch();
    const plan = buildOmpReplayPlan({
        currentSessionId: ctx.sessionManager.getSessionId(),
        branch,
        completePendingNativeCompaction: true,
        messagesForEntry: (entry) => sessionEntryToOmpMessages(entry),
    });
    let runtime = null;
    let runtimeThread = null;
    let latestContext = null;
    let active = null;
    const manager = ctx.sessionManager;
    const ownArchiveTail = { commit: null, source: null };
    const persistSource = (source, bindings) => {
        assertGeneration();
        const checkpoint = buildOmpSourceCheckpoint(source, plan.sourceHistory, (id) => bindings.identity(id), plan.currentThread, (id) => ompArrivalOf(bindings.resolve(id)));
        if (checkpoint === null)
            return;
        pi.appendEntry(OMP_SOURCE_ENTRY_TYPE, checkpoint);
        ownArchiveTail.source = ctx.sessionManager.getLeafId();
        plan.sourceHistory.add(checkpoint);
    };
    try {
        const recovered = await recoverOmpSession({
            plan,
            runtimeFactory(thread) {
                runtimeThread = thread;
                runtime = runtimeFactory.create(thread);
                return runtime.client;
            },
            async adapterFactory(client, bindings) {
                const adapter = await createOmpSpineAdapter({
                    enabled: true,
                    runtime: client,
                    host: {
                        async claimOwnership(claim) {
                            if (claim.context !== "exclusive-final" || claim.compaction !== "exclusive") {
                                throw new Error("OMP Spine received an invalid ownership claim");
                            }
                        },
                        async appendCustomEntry(type, entry) {
                            assertGeneration();
                            if (type === OMP_ARCHIVE_ENTRY_TYPE) {
                                const snapshot = await client.execute({ type: "source_snapshot" });
                                assertGeneration();
                                if (snapshot.type !== "source_snapshot") {
                                    throw new Error(`OMP Source snapshot returned ${snapshot.type}`);
                                }
                                persistSource(snapshot.source, bindings);
                            }
                            if (type === OMP_COMPACT_ENTRY_TYPE) {
                                if (!active?.committedCompact)
                                    throw new Error("OMP compact has no durable native receipt");
                                // The barrier already lives in the same journal record as the summary.
                            }
                            else {
                                pi.appendEntry(type, entry);
                            }
                            if (type === OMP_ARCHIVE_ENTRY_TYPE && isRecord(entry) && isRecord(entry.record)
                                && entry.record.type === "sampling_commit") {
                                ownArchiveTail.commit = ctx.sessionManager.getLeafId();
                            }
                        },
                        async materializeContext(context) {
                            assertGeneration();
                            return materializeFromBranch(context, bindings, ctx.sessionManager.getBranch(), runtime?.nodePrompt() ?? "");
                        },
                        async replaceContext(context) {
                            assertGeneration();
                            const installed = structuredClone(context);
                            if (latestContext === null) {
                                latestContext = installed;
                            }
                            else {
                                Object.assign(latestContext, installed);
                            }
                        },
                    },
                });
                if (adapter === null) {
                    throw new Error("OMP Spine adapter unexpectedly disabled");
                }
                return adapter;
            },
        });
        if (runtime === null || latestContext === null) {
            throw new Error("OMP Spine recovery did not install runtime context");
        }
        if (plan.pendingNativeCompaction !== null) {
            const compact = plan.pendingNativeCompaction;
            const ack = compact.nativeAcknowledgement;
            const summary = compact.replacementMessages[0];
            const native = localOmpSession(pi, ctx);
            if (native?.sessionManager !== manager)
                throw new Error("OMP compact recovery requires the active native session");
            assertGeneration();
            manager.appendCompaction(summary.summary, undefined, ack.firstKeptEntryId, ack.tokensBefore, { fromExtension: true });
            manager.flushSync();
            native.agent.replaceMessages(manager.buildSessionContext().messages);
        }
        const initialContext = latestContext;
        active = {
            children: new SpawnChildren((arrival, wake) => { if (active)
                deliver(active, arrival, wake); }),
            birth: childBirthOf(ctx.sessionManager.getHeader()),
            ownArchiveTail,
            committedCompact: null,
            appliedCompactions: new Set(branch.filter((entry) => entry.type === "compaction").map((entry) => entry.id)),
            lifecycle: new OmpSamplingLifecycle(recovered.adapter, recovered.bindings, recovered.source, {
                contextReady: true,
            }),
            runtime,
            latestContext: initialContext,
            materializeMessages(branch) {
                return materializeFromBranch(initialContext, recovered.bindings, branch, runtime.nodePrompt());
            },
        };
        assertGeneration();
        persistSource(recovered.source, recovered.bindings);
        if (onSessionReady && runtimeThread !== null) {
            await onSessionReady({
                sessionId: ctx.sessionManager.getSessionId(),
                thread: runtimeThread,
                epoch: recovered.source.epoch,
                scopeCursor: [...initialContext.projection.cursor],
                runtime,
                entries: ctx.sessionManager.getBranch(),
            });
        }
        return active;
    }
    catch (cause) {
        runtime?.dispose();
        throw cause;
    }
}
function childRuntimeFlags(pi, ctx) {
    const flags = [];
    const model = ctx.model;
    if (model !== undefined) {
        flags.push("--provider", model.provider, "--model", model.id);
    }
    const thinking = pi.getThinkingLevel();
    if (thinking !== undefined) {
        flags.push("--thinking", thinking);
    }
    if (process.argv.includes("--approve") || process.argv.includes("--auto-approve")) {
        flags.push("--auto-approve");
    }
    return flags;
}
function ompChildScope(ctx) {
    const file = ctx.sessionManager.getSessionFile();
    return { parentSessionId: ctx.sessionManager.getSessionId(), ...(file ? { parentSessionFile: file } : {}) };
}
function launchOmpChildren(pi, ctx, session, births, origin, prefixEntries, configToml, childInvocation, assertGeneration) {
    const recovery = spawnRecoveryPolicy(ctx, pi);
    const scope = ompChildScope(ctx);
    session.children.launch(births, (birth, peers, signal) => runSpawnChild({
        producer: birth.producer, task: birth.task, signal,
        ...(recovery && { recovery }),
        executor: { execute: (task, child) => runOmpChild(task, child, {
                ...scope, cwd: ctx.cwd, origin, peers, prefixEntries, configToml,
                extensionPath: EXTENSION_MODULE_PATH, runtimeFlags: childRuntimeFlags(pi, ctx), assertGeneration,
                ...(childInvocation && { childInvocation }),
            }) },
    }));
}
function recoverOmpChildren(pi, ctx, session, configToml, childInvocation, assertGeneration) {
    const births = unarrivedBirths(session.latestContext.projection).filter((birth) => !session.lifecycle.enteredArrivals.has(birth.producer.join(".")));
    if (!births.length)
        return;
    const branch = ctx.sessionManager.getBranch();
    const origins = new Map();
    for (const entry of branch) {
        if (entry.type === "compaction" || entry.type === "reset_boundary")
            origins.clear();
        if (entry.type !== "custom" || entry.customType !== OMP_ARCHIVE_ENTRY_TYPE)
            continue;
        const archive = entry.data.record;
        if (archive.type === "sampling_commit" && archive.record.executions.some(({ operation }) => operation.type === "spawn")) {
            origins.set(archive.record.post_boundary.ordinal, entry.id);
        }
    }
    const scope = ompChildScope(ctx);
    const recovery = spawnRecoveryPolicy(ctx, pi);
    for (const birth of births) {
        const origin = origins.get(birth.start);
        if (!origin)
            throw new Error(`No committed OMP birth entry for Spawn ${birth.producer.join(".")}`);
        let ran = false;
        session.children.start(birth, async (signal) => {
            const latest = await latestChildSession(scope, { origin, producer: birth.producer });
            return runSpawnChild({
                producer: birth.producer, task: birth.task, signal, ...(recovery && { recovery }),
                executor: { async execute(task, child) {
                        if (child.mode === "initial") {
                            const saved = latest ? await readChildState(latest.path) : null;
                            return {
                                ...(saved?.terminal ?? { outcome: "aborted", diagnostic: saved?.diagnostic ?? "Parent restarted before the child returned" }),
                                recovery: { continueable: latest !== null, retryable: false },
                            };
                        }
                        if (!latest || child.mode !== "continue")
                            throw new Error("Saved child session unavailable for Continue");
                        ran = true;
                        return runOmpChild(task, { ...child, attempt: latest.attempt }, {
                            ...scope, cwd: ctx.cwd, origin, peers: [task], configToml,
                            extensionPath: EXTENSION_MODULE_PATH, runtimeFlags: childRuntimeFlags(pi, ctx), assertGeneration,
                            ...(childInvocation && { childInvocation }),
                        });
                    } },
            });
        }, () => ran);
    }
}
function deliverOmpArrival(pi, ctx, session, arrival, wake) {
    const key = arrival.producer.join(".");
    if (!unarrivedBirths(session.latestContext.projection).some((birth) => birth.producer.join(".") === key))
        return false;
    const branch = ctx.sessionManager.getBranch();
    const reset = ompResetBoundaryIndex(branch);
    if (branch.slice(reset + 1).some((entry) => extractOmpArrival(entry)?.producer.join(".") === key))
        return false;
    // The result is durable on this branch regardless of OMP's pending queue.
    // The next turn reads it from the journal, never from the wake notice.
    pi.appendEntry(SPINE_ARRIVAL_CUSTOM_TYPE, arrival);
    ctx.sessionManager.flushSync();
    if (ctx.hasUI)
        ctx.ui.notify(`Spine child ${key}: ${arrival.outcome}`, "info");
    return wake;
}
function decodeControlExecuteCall(toolName, params) {
    const input = isRecord(params) ? params : {};
    if (typeof input.path === "string" && input.path.startsWith("xd://")) {
        return decodeHostToolCall("write", input);
    }
    return decodeHostToolCall(toolName, input);
}
function assertCurrentSession(slot, session) {
    if (slot.current !== session)
        throw new Error("OMP Spine session changed while preparing context");
    const fault = slot.fault ?? session.lifecycle.fault;
    if (fault !== null)
        throw new Error("OMP Spine extension is faulted", { cause: fault });
}
async function requireSession(slot) {
    if (slot.fault !== null)
        throw new Error("OMP Spine extension is faulted", { cause: slot.fault });
    if (slot.current !== null)
        return slot.current;
    if (slot.initialization !== null)
        return slot.initialization;
    throw new Error("OMP Spine session is not initialized");
}
async function beginSessionInitialization(slot, initialize) {
    const generation = slot.generation + 1;
    slot.generation = generation;
    slot.shuttingDown = false;
    slot.treeDisplay.reset();
    disposeCurrent(slot);
    const pending = initialize();
    slot.initialization = pending;
    try {
        const session = await pending;
        if (slot.generation !== generation) {
            session.runtime.dispose();
            return;
        }
        slot.current = session;
        slot.initialization = null;
    }
    catch (cause) {
        if (slot.generation !== generation)
            return;
        slot.initialization = null;
        throw cause;
    }
}
async function guardHook(pi, slot, ctx, boundary, operation, abortTurn = true) {
    const generation = slot.generation;
    try {
        await operation();
    }
    catch (cause) {
        if (slot.generation !== generation)
            return;
        recordSpineFault(pi, slot, ctx, boundary, cause, abortTurn);
    }
}
/** Diagnostic only: never archive payloads, model context, or arbitrary error properties. */
function faultErrors(cause) {
    const errors = [];
    for (let depth = 0; depth < 4 && cause !== undefined; depth += 1) {
        const code = cause instanceof Error && "code" in cause && typeof cause.code === "string"
            ? cause.code.slice(0, 128) : undefined;
        errors.push({
            name: cause instanceof Error ? cause.name.slice(0, 128) : "NonErrorThrow",
            ...(code === undefined ? {} : { code }),
            message: (cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "Non-Error thrown value").slice(0, 2048),
        });
        cause = cause instanceof Error ? cause.cause : undefined;
    }
    return errors;
}
function recordSpineFault(pi, slot, ctx, boundary, cause, abortTurn) {
    const firstFault = slot.fault === null;
    slot.fault ??= cause;
    if (firstFault) {
        const diagnostic = {
            schema: "spine.fault/v1",
            ...boundary,
            timestamp: Date.now(),
            errors: faultErrors(cause),
        };
        try {
            const projection = slot.current?.latestContext.projection;
            pi.appendEntry("spine.fault.v1", {
                ...diagnostic,
                sessionId: ctx.sessionManager.getSessionId(),
                transactionId: slot.current?.latestContext.transactionId ?? null,
                ...(projection === undefined ? {} : {
                    cursor: [...projection.cursor],
                    lastBoundary: projection.last_boundary,
                }),
            });
        }
        catch (persistenceError) {
            console.error(JSON.stringify({ ...diagnostic, persistenceErrors: faultErrors(persistenceError) }));
        }
    }
    if (abortTurn)
        ctx.abort();
    if (!slot.notified && ctx.hasUI) {
        slot.notified = true;
        ctx.ui.notify(abortTurn ? "Spine faulted; current omp operation aborted" : "Spine faulted; host messages kept", abortTurn ? "error" : "warning");
    }
}
function faultAndAbort(pi, slot, ctx, boundary, cause) {
    recordSpineFault(pi, slot, ctx, boundary, cause, true);
}
function notifyOmpCompactionFailure(ctx, cause) {
    const message = cause instanceof Error && cause.message.trim() !== ""
        ? cause.message
        : "OMP compaction failed";
    ctx.ui.notify(message, "error");
}
function isAbortError(cause) {
    return typeof cause === "object" && cause !== null && "name" in cause && cause.name === "AbortError";
}
function isOutsideSampling(cause) {
    const text = cause instanceof Error ? `${cause.message} ${String(cause.cause ?? "")}` : String(cause);
    return /outside sampling/.test(text);
}
function abortError(message) {
    const error = new Error(message);
    error.name = "AbortError";
    return error;
}
function disposeCurrent(slot) {
    slot.current?.children.dispose();
    slot.current?.runtime.dispose();
    slot.current = null;
}
function toolResult(text) {
    return { content: [{ type: "text", text }], details: {} };
}
function renderSpineTree(ctx, slot, session, projection = session.latestContext.projection) {
    slot.treeDisplay.publish(ctx, slot.generation, projection);
}
function snapshotSpawnView(view) {
    return {
        schema: "spine.spawn.view.v1",
        tasks: view.tasks.map((task) => ({ ...task })),
    };
}
function spawnViewFromResult(result, cancelled = false) {
    const details = result.details;
    if (!isRecord(details) || details.schema !== "spine.spawn.view.v1" || !Array.isArray(details.tasks)) {
        return null;
    }
    const view = details;
    if (!cancelled && !result.isError)
        return view;
    const diagnostic = result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
    return settleSpawnView(view, cancelled ? "aborted" : "errored", diagnostic);
}
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
//# sourceMappingURL=extension.js.map