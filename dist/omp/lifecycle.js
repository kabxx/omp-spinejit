import { decodeSpineSpawnTasks, isSpineToolName, operationFromSpineToolCall, SPINE_TOOL_NAMES, } from "@spinejit/spine-sdk/host";
import { isOmpSourceMessage, ompArrivalOf, ompNativeMessageKey, sourceObservation } from "./messages.js";
export const OMP_SPINE_TOOL_NAMES = SPINE_TOOL_NAMES;
export class OmpSamplingLifecycleError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = "OmpSamplingLifecycleError";
    }
}
/** Recoverable denial: a sampling admits only one Spine operation. */
export class OmpSpineToolLimitError extends Error {
    constructor(tool) {
        super(`Only one Spine tool call is allowed per sampling; ${tool} was already staged. Call the other Spine tool on the next assistant turn.`);
        this.name = "OmpSpineToolLimitError";
    }
}
/** One OMP assistant/tool turn maps to one Spine sampling. Provider retries reuse it. */
export class OmpSamplingLifecycle {
    #adapter;
    #bindings;
    #mirroredMessages = new Map();
    #sourceIdsByBoundary = new Map();
    #enteredArrivals = new Set();
    #nextBoundary;
    #contextVersion = 0;
    #publishedContextVersion = -1;
    #previewInFlight = null;
    #observeChain = Promise.resolve();
    #operationChain = Promise.resolve();
    #samplingActive = false;
    #staged = null;
    #responseCalls = 0;
    #fault = null;
    constructor(adapter, bindings, source, options = {}) {
        this.#adapter = adapter;
        this.#bindings = bindings;
        this.#nextBoundary = nextSourceBoundary(source);
        this.#publishedContextVersion = options.contextReady === true ? 0 : -1;
        for (const cell of source.cells) {
            this.#sourceIdsByBoundary.set(cell.boundary, cell.source_id);
            const message = bindings.resolve(cell.source_id);
            const arrival = ompArrivalOf(message);
            if (arrival !== undefined)
                this.#enteredArrivals.add(arrival.producer.join("."));
            const identity = messageIdentity(message);
            this.#mirroredMessages.set(identity, (this.#mirroredMessages.get(identity) ?? 0) + 1);
        }
    }
    get fault() {
        return this.#fault ?? this.#adapter.fault;
    }
    get samplingActive() {
        return this.#samplingActive;
    }
    get responseCalls() {
        return this.#responseCalls;
    }
    get enteredArrivals() {
        return this.#enteredArrivals;
    }
    async observeMessage(message) {
        if (!isOmpSourceMessage(message))
            return;
        const run = this.#observeChain.then(async () => {
            this.#countResponseCalls(message);
            const identity = messageIdentity(message);
            const mirrored = this.#mirroredMessages.get(identity) ?? 0;
            if (mirrored > 0) {
                this.#mirroredMessages.set(identity, mirrored - 1);
                return;
            }
            await this.#appendMessage(message);
        });
        this.#observeChain = run.then(() => undefined, () => undefined);
        await run;
    }
    #countResponseCalls(message) {
        if (message.role === "assistant" && this.#samplingActive) {
            this.#responseCalls = message.content.filter((part) => part.type === "toolCall").length;
        }
    }
    async #appendMessage(message, entryId = null) {
        await this.#guard(async () => {
            const observation = sourceObservation(message, this.#nextBoundary);
            const sourceIds = await this.#adapter.observeSources([observation.character]);
            const sourceId = sourceIds[0];
            if (sourceIds.length !== 1 || sourceId === undefined) {
                throw new OmpSamplingLifecycleError(`Spine admitted ${sourceIds.length} source IDs for one OMP message`);
            }
            this.#bindings.bind(sourceId, observation.message, entryId);
            if (observation.character.type === "arrival") {
                this.#enteredArrivals.add(observation.character.arrival.producer.join("."));
            }
            this.#sourceIdsByBoundary.set(this.#nextBoundary, sourceId);
            this.#nextBoundary += 1;
            this.#contextVersion += 1;
        });
    }
    async previewContext() {
        await this.#observeChain;
        if (this.#contextVersion === this.#publishedContextVersion)
            return;
        if (this.#previewInFlight !== null) {
            await this.#previewInFlight;
            if (this.#contextVersion !== this.#publishedContextVersion) {
                await this.previewContext();
            }
            return;
        }
        const targetVersion = this.#contextVersion;
        const pending = this.#guard(async () => {
            await this.#adapter.previewAndPublish();
            if (this.#contextVersion === targetVersion) {
                this.#publishedContextVersion = targetVersion;
            }
        });
        this.#previewInFlight = pending;
        try {
            await pending;
        }
        finally {
            if (this.#previewInFlight === pending)
                this.#previewInFlight = null;
        }
        if (this.#contextVersion !== this.#publishedContextVersion) {
            await this.previewContext();
        }
    }
    /** Admit durable host additions that omp appends without extension message events. */
    async observePersistedSources(sources) {
        const run = this.#observeChain.then(() => this.#admitPersistedSources(sources));
        this.#observeChain = run.then(() => undefined, () => undefined);
        await run;
    }
    async #admitPersistedSources(sources) {
        for (const source of sources) {
            if (source.boundary < this.#nextBoundary) {
                const sourceId = this.#sourceIdsByBoundary.get(source.boundary);
                const entryId = sourceId === undefined ? null : this.#bindings.entryId(sourceId);
                if (sourceId === undefined || this.#bindings.identity(sourceId) !== ompNativeMessageKey(source.message)
                    || (source.entryId != null && entryId !== null && entryId !== source.entryId)) {
                    const cause = new OmpSamplingLifecycleError(`Persisted OMP source identity does not match boundary ${source.boundary}`);
                    this.#fault ??= cause;
                    throw cause;
                }
                if (source.entryId !== undefined)
                    this.#bindings.assignEntryId(sourceId, source.entryId);
                continue;
            }
            if (source.boundary !== this.#nextBoundary) {
                throw new OmpSamplingLifecycleError("Persisted OMP source tail is discontinuous");
            }
            this.#countResponseCalls(source.message);
            await this.#appendMessage(source.message, source.entryId);
            const identity = messageIdentity(source.message);
            this.#mirroredMessages.set(identity, (this.#mirroredMessages.get(identity) ?? 0) + 1);
        }
    }
    async sourceSnapshot() {
        await this.#observeChain;
        return this.#guard(() => this.#adapter.sourceSnapshot());
    }
    async compact(barrier, replacementMessages, entryIds) {
        await this.#observeChain;
        await this.#guard(async () => {
            if (this.#samplingActive) {
                throw new OmpSamplingLifecycleError("OMP compaction started before the sampling turn ended");
            }
            if (replacementMessages.length !== barrier.replacement_boundaries.length) {
                throw new OmpSamplingLifecycleError("OMP compact replacement messages do not match replacement boundaries");
            }
            if (entryIds !== undefined && entryIds.length !== replacementMessages.length) {
                throw new OmpSamplingLifecycleError("OMP compact replacement entry ids do not match replacement messages");
            }
            const targetVersion = ++this.#contextVersion;
            await this.#adapter.compact(barrier, {
                publish: false,
                metadata: entryIds === undefined
                    ? replacementMessages
                    : { messages: replacementMessages, entryIds },
            });
            const source = await this.#adapter.sourceSnapshot();
            if (source.cells.length !== replacementMessages.length) {
                throw new OmpSamplingLifecycleError(`Spine compact returned ${source.cells.length} source cells for ${replacementMessages.length} replacements`);
            }
            this.#bindings.clear();
            this.#sourceIdsByBoundary.clear();
            this.#mirroredMessages.clear();
            for (const cell of source.cells) {
                const index = barrier.replacement_boundaries.indexOf(cell.boundary);
                if (index < 0) {
                    throw new OmpSamplingLifecycleError(`Spine compact returned an unexpected replacement boundary ${cell.boundary}`);
                }
                this.#bindings.bind(cell.source_id, replacementMessages[index], entryIds?.[index] ?? null);
                this.#sourceIdsByBoundary.set(cell.boundary, cell.source_id);
            }
            this.#nextBoundary = nextSourceBoundary(source);
            await this.#adapter.previewAndPublish();
            if (this.#contextVersion === targetVersion) {
                this.#publishedContextVersion = targetVersion;
            }
        });
    }
    async beginSampling(_providerPayload) {
        await this.#observeChain;
        await this.#guard(async () => {
            if (this.#samplingActive) {
                return;
            }
            await this.#adapter.beginSampling();
            this.#samplingActive = true;
            this.#staged = null;
            this.#responseCalls = 0;
        });
    }
    /** omp fires multiple provider requests per user turn; start sampling at most once. */
    async ensureSampling(providerPayload = undefined) {
        await this.#observeChain;
        if (this.#samplingActive)
            return;
        if (this.#nextBoundary === 0)
            return;
        await this.beginSampling(providerPayload);
    }
    async registerToolCall(toolCallId, toolName, input) {
        await this.#observeChain;
        if (!isSpineToolName(toolName)) {
            return false;
        }
        if (this.fault !== null) {
            throw new OmpSamplingLifecycleError("OMP Spine lifecycle is faulted", {
                cause: this.fault,
            });
        }
        const operation = operationFromOmpToolCall(toolName, input);
        await this.#guard(async () => {
            this.#assertSamplingActive();
            if (this.#staged !== null) {
                if (this.#staged.key === toolCallId && this.#staged.name === toolName)
                    return;
                throw new OmpSpineToolLimitError(this.#staged.name);
            }
            await this.#adapter.registerExecution(toolCallId);
            await this.#adapter.stageExecution(toolCallId, toolCallId, operation);
            this.#staged = { key: toolCallId, name: toolName, running: true };
        });
        return true;
    }
    async finishToolCall(toolCallId, succeeded) {
        await this.#observeChain;
        return this.#guard(async () => {
            // Recheck after queued cancellation/finalization has drained executions.
            const staged = this.#staged;
            if (staged?.key !== toolCallId || !staged.running)
                return false;
            await this.#adapter.finishExecution(toolCallId, succeeded);
            staged.running = false;
            return true;
        });
    }
    async finishTurn(turn) {
        await this.#observeChain;
        return this.#guard(async () => {
            // Close is idempotent: OMP may emit a stray turn_end after sampling is already closed.
            if (!this.#samplingActive) {
                return null;
            }
            const staged = this.#staged;
            if (staged?.running) {
                if (!samplingWasCancelled(turn)) {
                    throw new OmpSamplingLifecycleError(`OMP turn ended with unfinished Spine execution: ${staged.key}`);
                }
                // OMP can skip the tool result on immediate abort after registration.
                await this.#adapter.finishExecution(staged.key, false);
                staged.running = false;
            }
            const targetVersion = this.#contextVersion;
            const result = await this.#adapter.finishSampling(samplingTerminal(turn), assistantInputTokens(turn.message));
            this.#samplingActive = false;
            if (result.type === "committed" && this.#contextVersion === targetVersion) {
                this.#publishedContextVersion = targetVersion;
            }
            return result;
        });
    }
    #guard(operation) {
        // Native tool_result and cancelled turn_end observers may overlap. Runtime
        // execution settlement and sampling finalization must share one ordering.
        const run = this.#operationChain.then(async () => {
            if (this.fault !== null) {
                throw new OmpSamplingLifecycleError("OMP Spine lifecycle is faulted", {
                    cause: this.fault,
                });
            }
            try {
                return await operation();
            }
            catch (cause) {
                if (cause instanceof OmpSpineToolLimitError)
                    throw cause;
                this.#fault ??= cause;
                throw new OmpSamplingLifecycleError("OMP Spine lifecycle fault", { cause });
            }
        });
        this.#operationChain = run.then(() => undefined, () => undefined);
        return run;
    }
    #assertSamplingActive() {
        if (!this.#samplingActive) {
            throw new OmpSamplingLifecycleError("OMP Spine operation occurred outside sampling");
        }
    }
}
export function buildCompactBarrier(source, replacementCount) {
    if (!Number.isSafeInteger(replacementCount) || replacementCount <= 0) {
        throw new OmpSamplingLifecycleError("OMP compact requires at least one replacement message");
    }
    const boundary = nextSourceBoundary(source);
    if (!Number.isSafeInteger(boundary)) {
        throw new OmpSamplingLifecycleError("OMP compact source boundary is exhausted");
    }
    const nextEpoch = source.epoch + 1;
    if (!Number.isSafeInteger(nextEpoch)) {
        throw new OmpSamplingLifecycleError("OMP compact context epoch is exhausted");
    }
    const replacementBoundaries = Array.from({ length: replacementCount }, (_, index) => boundary + index + 1);
    if (!Number.isSafeInteger(replacementBoundaries.at(-1))) {
        throw new OmpSamplingLifecycleError("OMP compact replacement boundary is exhausted");
    }
    return {
        schema: "spine.compact.barrier.v1",
        thread: source.thread,
        previous_epoch: source.epoch,
        next_epoch: nextEpoch,
        boundary,
        replacement_boundaries: replacementBoundaries,
    };
}
export function operationFromOmpToolCall(toolName, input) {
    try {
        return operationFromSpineToolCall(toolName, input);
    }
    catch (cause) {
        throw new OmpSamplingLifecycleError("invalid OMP Spine tool input", { cause });
    }
}
export function decodeSpawnTasks(input) {
    try {
        return decodeSpineSpawnTasks(input);
    }
    catch (cause) {
        throw new OmpSamplingLifecycleError("invalid OMP Spine Spawn input", { cause });
    }
}
function samplingWasCancelled(turn) {
    if (turn.aborted) {
        return true;
    }
    return turn.message.role === "assistant" && turn.message.stopReason === "aborted";
}
function samplingTerminal(turn) {
    if (turn.aborted) {
        return "cancelled";
    }
    if (turn.message.role !== "assistant") {
        throw new OmpSamplingLifecycleError("OMP turn_end did not carry an assistant message");
    }
    switch (turn.message.stopReason) {
        case "aborted":
            return "cancelled";
        case "error":
            return "failed";
        case "stop":
        case "toolUse":
        case "length":
            return "completed";
        case "deferred":
            throw new OmpSamplingLifecycleError("OMP deferred assistant responses are unsupported by the Spine sampling contract");
        default:
            throw new OmpSamplingLifecycleError(`OMP assistant response has unsupported stop reason ${String(turn.message.stopReason)}`);
    }
}
function assistantInputTokens(message) {
    if (message.role !== "assistant") {
        throw new OmpSamplingLifecycleError("OMP turn_end did not carry an assistant message");
    }
    const usage = message.usage;
    if (usage === null || typeof usage !== "object" || Array.isArray(usage)) {
        return undefined;
    }
    const usageRecord = usage;
    const components = [usageRecord.input, usageRecord.cacheRead, usageRecord.cacheWrite];
    if (!components.every((value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0)) {
        return undefined;
    }
    let total = 0;
    for (const value of components) {
        total += value;
    }
    return Number.isSafeInteger(total) ? total : undefined;
}
function nextSourceBoundary(source) {
    let next = 0;
    for (const cell of source.cells) {
        next = Math.max(next, cell.boundary + 1);
    }
    return next;
}
function messageIdentity(message) {
    const observation = sourceObservation(message, 0);
    return JSON.stringify([
        observation.character,
        "timestamp" in message ? message.timestamp : null,
        message.role === "custom" ? message.customType : null,
        message.role === "assistant" ? message.content.filter((part) => part.type === "toolCall").map((part) => part.id) : null,
    ]);
}
//# sourceMappingURL=lifecycle.js.map