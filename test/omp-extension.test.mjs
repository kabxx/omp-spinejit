import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Type } from "@oh-my-pi/omptype/typebox";

import { createOmpExtension } from "../dist/omp/extension.js";
import { SPINE_ARRIVAL_CUSTOM_TYPE } from "../dist/omp/messages.js";
import { OMP_ADAPTER_ID, OMP_ARCHIVE_ENTRY_TYPE, OMP_COMPACT_ENTRY_TYPE } from "../dist/omp/protocol.js";
import { MOCK_MODEL_ID, MOCK_PROVIDER } from "./mock-model.mjs";

function mockOmp(options = {}) {
  const handlers = new Map();
  const tools = new Map();
  const entries = [];
  const eventListeners = new Map();
  const beforeModelCalls = new Set();
  const extension = { path: "mock-spine-extension", handlers };
  const loadedExtensions = [extension, ...(options.extensions ?? [])];
  const suspendedExtensions = new Set();
  const branch = options.branch ?? [];
  const childFlag = options.childFlag === true;
  let turnOpen = false;
  let nativeSessionManager = options.sessionManager;
  let compactionContextProvider;
  let activeTools = options.activeTools ?? [
    "read",
    "bash",
    "edit",
    "write",
    "spine_open",
    "spine_close",
    "spine_next",
    "spine_spawn",
  ];
  const sentMessages = [];

  return {
    tools,
    entries,
    sentMessages,
    loadedExtensions,
    suspendedExtensions,
    get turnOpen() {
      return turnOpen;
    },
    async beforeModelCall() {
      for (const gate of beforeModelCalls) {
        const result = await gate();
        if (result?.stop) return result;
      }
    },
    api: {
      typebox: { Type },
      pi: {
        startExternalAgentObservation: options.startExternalAgentObservation ?? (async () => ({
          async finish() {},
        })),
        observeExternalAgentSession: options.observeExternalAgentSession ?? (async () => () => {}),
        AgentRegistry: {
          global: () => ({
            get: (id) => id !== "Main" ? undefined : {
              session: {
                sessionId: options.sessionId ?? "omp-session",
                sessionManager: nativeSessionManager,
                extensionRunner: {
                  getLoadedExtensions: () => loadedExtensions,
                  isExtensionActive: (path) => loadedExtensions.some((item) => item.path === path) && !suspendedExtensions.has(path),
                  registerCompactionContextProvider(_owner, project) {
                    assert.equal(compactionContextProvider, undefined);
                    compactionContextProvider = project;
                    return () => {
                      if (compactionContextProvider === project) compactionContextProvider = undefined;
                    };
                  },
                },
                agent: {
                  addBeforeModelCall(gate) {
                    beforeModelCalls.add(gate);
                    return () => beforeModelCalls.delete(gate);
                  },
                },
              },
            },
          }),
        },
      },
      events: {
        on(name, listener) {
          const listeners = eventListeners.get(name) ?? new Set();
          listeners.add(listener);
          eventListeners.set(name, listeners);
          return () => listeners.delete(listener);
        },
        emit(name, data) {
          for (const listener of eventListeners.get(name) ?? []) listener(data);
        },
      },
      registerFlag() {},
      getFlag(name) {
        return name === "spine-child" && childFlag;
      },
      registerTool(tool) {
        tools.set(tool.name, tool);
      },
      registerCommand() {},
      getThinkingLevel() {
        return "low";
      },
      getActiveTools() {
        return activeTools;
      },
      getAllTools() {
        return options.allTools ?? [...tools.values()];
      },
      setActiveTools(names) {
        activeTools = [...names];
      },
      on(name, handler) {
        const existing = handlers.get(name) ?? [];
        existing.push(handler);
        handlers.set(name, existing);
      },

      appendEntry(customType, data) {
        const entry = {
          type: "custom",
          id: `c${nextTs()}`,
          parentId: branch.at(-1)?.id ?? null,
          timestamp: new Date(nextTs()).toISOString(),
          customType,
          data,
        };
        entries.push(entry);
        branch.push(entry);
        if (customType === SPINE_ARRIVAL_CUSTOM_TYPE) options.onArrival?.(entry);
      },
      sendMessage(message, options) {
        sentMessages.push({ message, options });
      },

    },
    async emit(name, event, ctx) {
      if (["session_start", "session_tree", "session_switch", "session_branch"].includes(name)) nativeSessionManager = ctx.sessionManager;
      if (name === "turn_start") turnOpen = true;
      if (["turn_end", "session_shutdown", "session_tree", "session_switch", "session_branch"].includes(name)) turnOpen = false;
      let result;
      for (const handler of handlers.get(name) ?? []) {
        result = await handler(event, ctx);
      }
      return result;
    },
  };
}


function extensionContext(branch, options = {}) {
  let aborts = 0;
  let idle = options.idle ?? true;
  const notifications = [];
  const widgets = [];
  const context = {
    mode: "tui",
    hasUI: true,
    isIdle: () => idle,
    cwd: options.cwd ?? "/tmp",
    agent: { kind: "main", id: "Main" },
    model: { provider: MOCK_PROVIDER, id: MOCK_MODEL_ID, maxTokens: 8192 },
    thinkingLevel: "low",
    modelRegistry: {
      async getApiKeyAndHeaders() {
        return { ok: true, apiKey: "omp-test-key", headers: { "x-test-auth": "resolved" } };
      },
    },
    sessionManager: options.sessionManager ?? {
      getSessionId: () => options.sessionId ?? "omp-session",
      getBranch: () => [...branch],
      getHeader: () => options.header,
      getLeafId: () => branch.at(-1)?.id ?? null,
      getSessionFile: () => options.sessionFile ?? "/tmp/omp-test-session.jsonl",
      flushSync() {},
    },
    ui: {
      notify(message, level) {
        notifications.push([message, level]);
      },
      setWidget(key, content, opts) {
        widgets.push([key, content, opts]);
      },
      ...(options.select === undefined ? {} : { select: options.select }),
      ...(options.input === undefined ? {} : { input: options.input }),
    },

    abort() {
      aborts += 1;
    },
    shutdown() {
      idle = true;
    },
  };
  return {
    notifications,
    widgets,
    context,
    async complete() {
      return { content: [{ type: "text", text: "compact summary" }], stopReason: "stop" };
    },
    setIdle(value) {
      idle = value;
    },
    get aborts() {
      return aborts;
    },
  };
}

function widgetLines(widget, width = 80) {
  const content = widget?.[1];
  if (content === undefined) return [];
  if (Array.isArray(content)) return content;
  const theme = {
    fg(_color, text) {
      return text;
    },
    bold(text) {
      return text;
    },
  };
  return content({ terminal: { rows: 40 }, requestRender() {} }, theme).render(width);
}



let clock = 1;
function nextTs() {
  clock += 1;
  return clock;
}

function user(content) {
  return { role: "user", content, timestamp: nextTs() };
}

function assistantCall(toolCallId, tool, input) {
  return {
    role: "assistant",
    content: [{
      type: "toolCall",
      id: toolCallId,
      name: tool,
      arguments: input,
    }],
    api: "test",
    provider: MOCK_PROVIDER,
    model: MOCK_MODEL_ID,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    stopReason: "toolUse",
    timestamp: nextTs(),
  };
}

function pushMessage(branch, message) {
  const entry = { type: "message", id: `e${nextTs()}`, parentId: branch.at(-1)?.id ?? null,
    timestamp: new Date(message.timestamp).toISOString(), message };
  branch.push(entry);
  return entry;
}

function toolText(result) {
  const part = result.content?.[0];
  return part?.type === "text" ? part.text : "";
}

function faults(host) {
  return host.entries.filter((entry) => entry.customType === "spine.fault.v1");
}

function samplingRecords(host) {
  return host.entries.filter((entry) => entry.customType === OMP_ARCHIVE_ENTRY_TYPE).map((entry) => {
    assert.equal(entry.data.schema, OMP_ADAPTER_ID);
    return entry.data.record;
  });
}

async function startSession(host, ctx) {
  await host.emit("session_start", { type: "session_start", reason: "new" }, ctx.context);
}

async function admitUser(host, ctx, branch, content) {
  const message = user(content);
  pushMessage(branch, message);
  await host.emit("message_end", { type: "message_end", message }, ctx.context);
  return message;
}

async function beginTurn(host, ctx, branch) {
  if (!host.turnOpen) {
    await modelPrompt(host, ctx, branch);
    await host.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: nextTs() }, ctx.context);
  }
  await host.emit(
    "before_provider_request",
    { type: "before_provider_request", payload: { model: MOCK_MODEL_ID } },
    ctx.context,
  );
}

async function runToolTurn(host, ctx, branch, tool, input, { beforeCommit } = {}) {
  await beginTurn(host, ctx, branch);
  const toolCallId = `call-${tool}-${nextTs()}`;
  const callMessage = assistantCall(toolCallId, tool, input);
  pushMessage(branch, callMessage);
  await host.emit("message_end", { type: "message_end", message: callMessage }, ctx.context);
  const admission = await host.emit(
    "tool_call",
    { type: "tool_call", toolCallId, toolName: tool, input },
    ctx.context,
  );
  const result = admission?.block
    ? { content: [{ type: "text", text: admission.reason }], details: {} }
    : await host.tools.get(tool).execute(toolCallId, input, undefined, undefined, ctx.context);
  const resultMessage = {
    role: "toolResult",
    toolCallId,
    toolName: tool,
    content: result.content,
    details: result.details,
    isError: admission?.block ?? result.isError ?? false,
    timestamp: nextTs(),
  };
  await host.emit("tool_result", { ...resultMessage, type: "tool_result", input }, ctx.context);
  pushMessage(branch, resultMessage);
  await beforeCommit?.({ result, toolCallId });
  await host.emit(
    "turn_end",
    { type: "turn_end", turnIndex: 0, message: callMessage, toolResults: [resultMessage] },
    ctx.context,
  );
  return { toolCallId, callMessage, admission, result, resultMessage };
}

async function runReplyTurn(host, ctx, branch, text) {
  await beginTurn(host, ctx, branch);
  const message = { ...assistantCall("", "", {}), content: [{ type: "text", text }], stopReason: "stop" };
  pushMessage(branch, message);
  await host.emit("message_end", { type: "message_end", message }, ctx.context);
  await host.emit("turn_end", { type: "turn_end", message, toolResults: [] }, ctx.context);
  return message;
}


function visibleText(messages) {
  const parts = [];
  for (const message of messages ?? []) {
    if (typeof message.content === "string") parts.push(message.content);
    else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part?.type === "text") parts.push(part.text);
        if (part?.type === "toolCall") parts.push(JSON.stringify(part.arguments ?? {}));
      }
    }
  }
  return parts.join("\n");
}


function resultText(message) {
  if (message?.role !== "toolResult") return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part?.type === "text").map((part) => part.text).join("\n");
}

function lastResult(messages, tool) {
  return messages.findLast((message) => message.role === "toolResult" && message.toolName === tool);
}

async function modelPrompt(host, ctx, branch) {
  const hostMessages = [];
  for (const entry of branch) {
    if (entry.message) hostMessages.push(entry.message);
  }
  const projected = await host.emit(
    "context",
    { type: "context", messages: hostMessages },
    ctx.context,
  );
  return projected?.messages ?? [];
}

function decideOpenClose(messages) {
  const close = lastResult(messages, "spine_close");
  if (close && !close.isError && /\broot\b/i.test(resultText(close))) return { type: "stop", reason: "at-root" };
  if (lastResult(messages, "spine_open")) {
    return { type: "tool", tool: "spine_close", input: { memory: "demo complete" } };
  }
  return { type: "tool", tool: "spine_open", input: { goal: "demo" } };
}

function decideNextThenClose(messages) {
  if (lastResult(messages, "spine_next") && !lastResult(messages, "spine_close")) {
    return { type: "tool", tool: "spine_close", input: { memory: "sibling done" } };
  }
  if (lastResult(messages, "spine_open") && !lastResult(messages, "spine_close")) {
    return { type: "tool", tool: "spine_next", input: { memory: "first done", goal: "second" } };
  }
  return decideOpenClose(messages);
}

function decideNestedOpenClose(messages) {
  const close = lastResult(messages, "spine_close");
  if (close && !close.isError) {
    return /\broot\b/i.test(resultText(close)) ? { type: "stop", reason: "at-root" }
      : { type: "tool", tool: "spine_close", input: { memory: "parent done" } };
  }
  const opened = resultText(lastResult(messages, "spine_open"));
  if (opened.includes('id="1.1.1"')) return { type: "tool", tool: "spine_close", input: { memory: "child done" } };
  return { type: "tool", tool: "spine_open", input: { goal: opened ? "child" : "parent" } };
}

function decideStubbornClose(messages) {
  const close = lastResult(messages, "spine_close");
  if (close?.isError) return { type: "stop", reason: "denied" };
  return { type: "tool", tool: "spine_close", input: { memory: "close anyway" } };
}

async function runScriptedModel(host, ctx, branch, decide, maxTurns = 8) {
  const turns = [];
  for (let index = 0; index < maxTurns; index += 1) {
    const messages = await modelPrompt(host, ctx, branch);
    const action = decide(messages);
    turns.push({ action, messages });
    if (action.type === "stop") return { turns, messages, stopped: true };
    await runToolTurn(host, ctx, branch, action.tool, action.input);
  }
  return { turns, stopped: false };
}

async function withOmp(fn, ompOptions = {}, ctxOptions = {}, extensionOptions = {}) {
  const branch = [];
  const host = mockOmp({ ...ompOptions, branch });
  const ctx = extensionContext(branch, {
    sessionFile: `/tmp/omp-session-${nextTs()}.jsonl`,
    ...ctxOptions,
  });
  createOmpExtension({ compactionCompletion: (...args) => ctx.complete(...args), ...extensionOptions })(host.api);
  await startSession(host, ctx);
  try {
    return await fn({ host, ctx, branch });
  } finally {
    await host.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx.context);
  }
}

function sees(messages, pattern) {
  const blob = typeof messages === "string" ? messages : visibleText(messages);
  if (pattern instanceof RegExp) {
    assert.match(blob, pattern);
    return;
  }
  assert.ok(blob.includes(pattern), `model prompt missing ${JSON.stringify(pattern)}\n${blob.slice(0, 1500)}`);
}

function unseen(messages, pattern) {
  const blob = typeof messages === "string" ? messages : visibleText(messages);
  if (pattern instanceof RegExp) {
    assert.equal(pattern.test(blob), false, `model prompt unexpectedly matched ${pattern}\n${blob.slice(0, 1500)}`);
    return;
  }
  assert.equal(blob.includes(pattern), false, `model prompt unexpectedly contains ${JSON.stringify(pattern)}\n${blob.slice(0, 1500)}`);
}

function calledTools(run) {
  return run.turns.filter((turn) => turn.action.type === "tool").map((turn) => turn.action.tool);
}




for (const hook of ["context", "session_before_compact"]) {
  test(`native metadata refuses another extension's ${hook} without initializing Spine`, async (t) => {
    const branch = [];
    const competitor = { path: `competitor-${hook}`, handlers: new Map([[hook, [() => undefined]]]) };
    const host = mockOmp({ branch, extensions: [competitor] });
    const ctx = extensionContext(branch);
    let initialized = false;
    createOmpExtension({
      runtimeFactory: { create() { initialized = true; throw new Error("must not initialize"); } },
    })(host.api);
    t.after(() => host.emit("session_shutdown", {}, ctx.context));
    await startSession(host, ctx);
    assert.equal(initialized, false);
    await assert.rejects(host.beforeModelCall());
    assert.equal(initialized, false);
    assert.deepEqual(await host.emit("session_before_compact", { signal: new AbortController().signal }, ctx.context), { cancel: true });
    assert.equal(host.entries.some((entry) => entry.customType === OMP_ARCHIVE_ENTRY_TYPE), false);
  });
}

test("two Spine activations in one native extension fail closed rather than overwrite tools", async (t) => {
  const branch = [];
  const host = mockOmp({ branch });
  const ctx = extensionContext(branch);
  let initialized = false;
  const options = { runtimeFactory: { create() { initialized = true; throw new Error("must not initialize"); } } };
  createOmpExtension(options)(host.api);
  createOmpExtension(options)(host.api);
  t.after(() => host.emit("session_shutdown", {}, ctx.context));
  await startSession(host, ctx);
  await assert.rejects(host.beforeModelCall());
  assert.equal(initialized, false);
  assert.equal(host.entries.some((entry) => entry.customType === OMP_ARCHIVE_ENTRY_TYPE), false);
});

test("own bridge observers and suspended competitors do not claim ownership; reactivation is checked before the model", async (t) => {
  const branch = [];
  const competitor = { path: "suspended-observer", handlers: new Map([["context", [() => undefined]]]) };
  const host = mockOmp({ branch, extensions: [competitor] });
  host.suspendedExtensions.add(competitor.path);
  const ctx = extensionContext(branch);
  createOmpExtension()(host.api);
  host.api.on("context", () => undefined);
  host.api.on("session_before_compact", () => undefined);
  t.after(() => host.emit("session_shutdown", {}, ctx.context));
  await startSession(host, ctx);
  assert.deepEqual(faults(host), []);
  assert.equal(await host.beforeModelCall(), undefined);
  host.suspendedExtensions.delete(competitor.path);
  await assert.rejects(host.beforeModelCall());
  host.suspendedExtensions.add(competitor.path);
  await host.emit("session_switch", {}, ctx.context);
  assert.equal(await host.beforeModelCall(), undefined, "session reload replaces the previous model gate");
  await host.emit("session_shutdown", {}, ctx.context);
  assert.equal(await host.beforeModelCall(), undefined, "shutdown releases the model gate");
});

test("omp open/close report the committed cursor and do not abort", async () => {
  const branch = [];
  const host = mockOmp({ branch });
  const ctx = extensionContext(branch);
  createOmpExtension()(host.api);

  await startSession(host, ctx);
  await admitUser(host, ctx, branch, "demo open close");
  const opened = await runToolTurn(host, ctx, branch, "spine_open", { goal: "inspect" });
  assert.equal(opened.admission, undefined);
  assert.match(toolText(opened.result), /<spine_node id="1\.1" summary="inspect" status="opened">/);
  assert.equal(ctx.aborts, 0);
  assert.equal(faults(host).length, 0, JSON.stringify(faults(host), null, 2));


  const afterOpen = await modelPrompt(host, ctx, branch);
  assert.deepEqual(lastResult(afterOpen, "spine_open")?.content, opened.result.content);
  const openTree = widgetLines(ctx.widgets.at(-1)).join("\n");
  assert.match(openTree, /Spine Tree/);
  assert.match(openTree, /◉/);
  assert.match(openTree, /inspect/);

  const closed = await runToolTurn(host, ctx, branch, "spine_close", { memory: "done" });
  assert.equal(closed.admission, undefined);
  const closeTree = widgetLines(ctx.widgets.at(-1)).join("\n");
  assert.match(closeTree, /✓/);
  assert.match(closeTree, /inspect/);
  assert.equal(ctx.aborts, 0);


  const secondClose = await runToolTurn(host, ctx, branch, "spine_close", { memory: "again" });
  assert.equal(secondClose.admission.block, true);
  assert.equal(secondClose.resultMessage.isError, true);
  assert.equal(ctx.aborts, 0);
  await host.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx.context);
});

test("omp next after open reports the sibling, not the staged child", async () => {
  const branch = [];
  const host = mockOmp({ branch });
  const ctx = extensionContext(branch);
  createOmpExtension()(host.api);

  await startSession(host, ctx);
  await admitUser(host, ctx, branch, "demo next");
  await runToolTurn(host, ctx, branch, "spine_open", { goal: "first" });
  const next = await runToolTurn(host, ctx, branch, "spine_next", {
    memory: "first done",
    goal: "second",
  });
  assert.equal(next.admission, undefined);
  assert.match(toolText(next.result), /<spine_node id="1\.2" summary="second" status="opened">/);
  const closed = await runToolTurn(host, ctx, branch, "spine_close", { memory: "second done" });
  assert.equal(closed.admission, undefined);
  assert.match(toolText(closed.result), /\broot\b/i);
  assert.equal(ctx.aborts, 0);
  assert.equal(faults(host).length, 0);

  await host.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx.context);
});


test("a latched publish fault blocks spawn without pretending the user interrupted", async () => {
  const branch = [];
  const host = mockOmp({ branch });
  const ctx = extensionContext(branch);
  const cause = new Error("post-commit observer boom");
  createOmpExtension({
    onSamplingCommit() { throw cause; },
  })(host.api);

  await startSession(host, ctx);
  await admitUser(host, ctx, branch, "open then spawn");
  await runToolTurn(host, ctx, branch, "spine_open", { goal: "owner" });
  assert.ok(faults(host).length >= 1);
  const abortsAfterOpen = ctx.aborts;
  await assert.rejects(host.beforeModelCall(), (error) => error.cause === cause);
  await host.emit("turn_start", { type: "turn_start" }, ctx.context);

  const spawnAdmission = await host.emit(
    "tool_call",
    {
      type: "tool_call",
      toolCallId: "spawn-1",
      toolName: "spine_spawn",
      input: {
        tasks: [
          { summary: "a", prompt: "a" },
          { summary: "b", prompt: "b" },
        ],
      },
    },
    ctx.context,
  );
  assert.equal(spawnAdmission.block, true);
  const ordinaryAdmission = await host.emit("tool_call", {
    type: "tool_call", toolCallId: "read-after-fault", toolName: "read", input: { path: "notes.txt" },
  }, ctx.context);
  assert.equal(ordinaryAdmission, undefined);
  assert.equal(ctx.aborts, abortsAfterOpen);
  await host.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx.context);
});


test("omp blocks spawn mixed with open without aborting", async () => {
  const branch = [];
  const host = mockOmp({ branch });
  const ctx = extensionContext(branch);
  createOmpExtension()(host.api);

  await startSession(host, ctx);
  await admitUser(host, ctx, branch, "mix");
  await host.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: nextTs() }, ctx.context);
  await host.emit(
    "before_provider_request",
    { type: "before_provider_request", payload: { model: MOCK_MODEL_ID } },
    ctx.context,
  );
  const openCall = assistantCall("open-1", "spine_open", { goal: "inspect" });
  const spawnInput = { tasks: [{ summary: "a", prompt: "a" }, { summary: "b", prompt: "b" }] };
  openCall.content.push(...assistantCall("spawn-1", "spine_spawn", spawnInput).content);
  pushMessage(branch, openCall);
  await host.emit("message_end", { type: "message_end", message: openCall }, ctx.context);
  const openAdmission = await host.emit(
    "tool_call",
    { type: "tool_call", toolCallId: "open-1", toolName: "spine_open", input: { goal: "inspect" } },
    ctx.context,
  );
  const spawnAdmission = await host.emit(
    "tool_call",
    {
      type: "tool_call",
      toolCallId: "spawn-1",
      toolName: "spine_spawn",
      input: spawnInput,
    },
    ctx.context,
  );
  assert.equal(openAdmission, undefined);
  assert.equal(spawnAdmission.block, true);
  assert.deepEqual(faults(host), []);
  assert.equal(ctx.aborts, 0);
  await host.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx.context);
});

test("idle shutdown does not abort; busy shutdown does", async () => {
  const idleBranch = [];
  const idleHost = mockOmp({ branch: idleBranch });
  const idleCtx = extensionContext(idleBranch);
  createOmpExtension()(idleHost.api);
  await startSession(idleHost, idleCtx);
  await idleHost.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, idleCtx.context);
  assert.equal(idleCtx.aborts, 0);

  const busyBranch = [];
  const busyHost = mockOmp({ branch: busyBranch });
  const busyCtx = extensionContext(busyBranch, { idle: false });
  createOmpExtension()(busyHost.api);
  await startSession(busyHost, busyCtx);
  await busyHost.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, busyCtx.context);
  assert.equal(busyCtx.aborts, 1);
});

test("context splices a successful close that WASM dropped", async () => {
  const branch = [];
  const host = mockOmp({ branch });
  const ctx = extensionContext(branch);
  createOmpExtension()(host.api);

  await startSession(host, ctx);
  await admitUser(host, ctx, branch, "close then think");
  const closed = await runToolTurn(host, ctx, branch, "spine_open", { goal: "child" });
  assert.equal(closed.admission, undefined);
  const finished = await runToolTurn(host, ctx, branch, "spine_close", { memory: "child done" });
  const projected = await host.emit("context", { type: "context", messages: [] }, ctx.context);
  const closeResults = projected.messages.filter((message) =>
    message.role === "toolResult" && message.toolCallId === finished.toolCallId);
  assert.equal(closeResults.length, 1);
  assert.equal(closeResults[0].toolName, "spine_close");
  assert.deepEqual(closeResults[0].content, finished.result.content);
  assert.equal(ctx.aborts, 0);
  await host.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx.context);
});

test("omp compaction summarizes published context and does not abort", async () => {
  const branch = [];
  const host = mockOmp({ branch });
  const ctx = extensionContext(branch);
  let requestMessages;
  ctx.complete = async (_model, request) => {
    requestMessages = request.messages;
    return { content: [{ type: "text", text: "kept going" }], stopReason: "stop" };
  };
  createOmpExtension({ compactionCompletion: (...args) => ctx.complete(...args) })(host.api);

  await startSession(host, ctx);
  const first = await admitUser(host, ctx, branch, "early work");
  await runToolTurn(host, ctx, branch, "spine_open", { goal: "child" });
  await runToolTurn(host, ctx, branch, "spine_close", { memory: "child done" });
  const kept = await admitUser(host, ctx, branch, "keep this turn");
  const firstKept = branch.find((entry) => entry.message === kept);
  const result = await host.emit(
    "session_before_compact",
    {
      type: "session_before_compact",
      preparation: {
        firstKeptEntryId: firstKept.id,
        messagesToSummarize: [first],
        turnPrefixMessages: [],
        tokensBefore: 40,
        settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
      },
      branchEntries: [...branch],
      signal: new AbortController().signal,
      reason: "threshold",
      willRetry: false,
    },
    ctx.context,
  );
  assert.equal(result.compaction.summary, "kept going");
  const receipt = result.compaction.details[OMP_COMPACT_ENTRY_TYPE];
  assert.equal(receipt.schema, OMP_ADAPTER_ID);
  assert.equal(receipt.preparedLeafId, branch.at(-1).id);
  assert.equal(receipt.nativeAcknowledgement.firstKeptEntryId, firstKept.id);
  assert.equal(receipt.replacementMessages[0].summary, result.compaction.summary);
  assert.equal(result.cancel, undefined);
  const rendered = JSON.stringify(requestMessages);
  assert.ok(rendered.includes("keep this turn") || rendered.includes("child done"), rendered);
  assert.equal(ctx.aborts, 0);
  const compactionEntry = { type: "compaction", id: `compaction-${branch.length}`, parentId: branch.at(-1)?.id ?? null,
    timestamp: new Date().toISOString(), fromExtension: true, ...result.compaction };
  branch.push(compactionEntry);
  await host.emit("session_compact", { type: "session_compact", fromExtension: true, compactionEntry }, ctx.context);
  assert.deepEqual(faults(host), []);
  assert.equal(ctx.aborts, 0);
  await host.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx.context);
});

test("omp restart recovers an open child from archive entries", async () => {
  const branch = [];
  const live = mockOmp({ branch });
  const liveCtx = extensionContext(branch);
  createOmpExtension()(live.api);
  await startSession(live, liveCtx);
  await admitUser(live, liveCtx, branch, "recover me");
  await runToolTurn(live, liveCtx, branch, "spine_open", { goal: "inspect" });
  await live.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, liveCtx.context);

  const recovered = mockOmp({ branch });
  const recoveredCtx = extensionContext(branch);
  createOmpExtension()(recovered.api);
  await startSession(recovered, recoveredCtx);
  const messages = await modelPrompt(recovered, recoveredCtx, branch);
  sees(resultText(lastResult(messages, "spine_open")), '<spine_node id="1.1"');
  const close = await runToolTurn(recovered, recoveredCtx, branch, "spine_close", { memory: "recovered" });
  assert.equal(close.admission, undefined);
  assert.match(toolText(close.result), /\broot\b/i);
  assert.equal(recoveredCtx.aborts, 0);
  assert.equal(faults(recovered).length, 0, JSON.stringify(faults(recovered), null, 2));
  await recovered.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, recoveredCtx.context);
});

test("restart restores a later user persisted after its sampling-started archive", async () => {
  const branch = [];
  const live = mockOmp({ branch });
  const ctx = extensionContext(branch);
  createOmpExtension()(live.api);
  await startSession(live, ctx);
  await admitUser(live, ctx, branch, "first user");
  await runToolTurn(live, ctx, branch, "spine_open", { goal: "first" });
  const later = user("later user");
  await live.emit("context", { type: "context", messages: [later] }, ctx.context);
  await live.emit("turn_start", { type: "turn_start", turnIndex: 1, timestamp: nextTs() }, ctx.context);
  await live.emit("before_provider_request", { payload: {} }, ctx.context);
  await live.emit("message_end", { message: later }, ctx.context);
  pushMessage(branch, later);
  await runToolTurn(live, ctx, branch, "spine_next", { memory: "first done", goal: "second" });
  await live.emit("session_shutdown", {}, ctx.context);

  const recovered = mockOmp({ branch });
  const recoveredCtx = extensionContext(branch);
  createOmpExtension()(recovered.api);
  await startSession(recovered, recoveredCtx);
  assert.deepEqual(faults(recovered), []);
  const closed = await runToolTurn(recovered, recoveredCtx, branch, "spine_close", { memory: "second done" });
  assert.equal(closed.admission, undefined);
  assert.match(toolText(closed.result), /\broot\b/i);
  assert.equal(faults(recovered).length, 0);
  await recovered.emit("session_shutdown", {}, recoveredCtx.context);
});

test("root next is denied without aborting", async () => {
  const branch = [];
  const host = mockOmp({ branch });
  const ctx = extensionContext(branch);
  createOmpExtension()(host.api);
  await startSession(host, ctx);
  await admitUser(host, ctx, branch, "next at root");
  const next = await runToolTurn(host, ctx, branch, "spine_next", {
    memory: "none",
    goal: "sibling",
  });
  assert.equal(next.admission.block, true);
  assert.equal(next.resultMessage.isError, true);
  assert.equal(ctx.aborts, 0);
  await host.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx.context);
});

test("nested open then close returns to the parent task", async () => {
  const branch = [];
  const host = mockOmp({ branch });
  const ctx = extensionContext(branch);
  createOmpExtension()(host.api);
  await startSession(host, ctx);
  await admitUser(host, ctx, branch, "nested");
  await runToolTurn(host, ctx, branch, "spine_open", { goal: "parent" });
  const child = await runToolTurn(host, ctx, branch, "spine_open", { goal: "child" });
  assert.match(toolText(child.result), /<spine_node id="1\.1\.1" summary="child" status="opened">/);
  const closed = await runToolTurn(host, ctx, branch, "spine_close", { memory: "child done" });
  assert.match(toolText(closed.result), /\b1\.1\b/);
  assert.equal(ctx.aborts, 0);
  assert.equal(faults(host).length, 0, JSON.stringify(faults(host), null, 2));
  await host.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx.context);
});







test("native compact without interception faults without looking like a user interrupt", async () => {
  const branch = [];
  const host = mockOmp({ branch });
  const ctx = extensionContext(branch);
  createOmpExtension()(host.api);
  await startSession(host, ctx);
  await host.emit("session_compact", { type: "session_compact" }, ctx.context);
  assert.ok(faults(host).length >= 1);
  assert.equal(ctx.aborts, 1);
  await host.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx.context);
});

test("compact abort before native acknowledgement leaves the session usable", async () => {
  const branch = [];
  const host = mockOmp({ branch });
  const ctx = extensionContext(branch);
  const signal = new AbortController();
  createOmpExtension({ compactionCompletion: (...args) => ctx.complete(...args) })(host.api);
  await startSession(host, ctx);
  const kept = await admitUser(host, ctx, branch, "keep this");
  const keptEntry = branch.find((entry) => entry.message === kept);
  const proposal = await host.emit(
    "session_before_compact",
    {
      type: "session_before_compact",
      preparation: {
        firstKeptEntryId: keptEntry.id,
        messagesToSummarize: [kept],
        turnPrefixMessages: [],
        tokensBefore: 1,
        settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
      },
      branchEntries: [...branch],
      signal: signal.signal,
      reason: "manual",
      willRetry: false,
    },
    ctx.context,
  );
  assert.ok(proposal.compaction);
  signal.abort();
  assert.equal(ctx.aborts, 0);
  assert.deepEqual(faults(host), []);
  assert.equal(branch.some((entry) => entry.type === "compaction"), false);
  await admitUser(host, ctx, branch, "continue after the rejected proposal");
  await runToolTurn(host, ctx, branch, "spine_open", { goal: "history still available" });
  assert.deepEqual(faults(host), []);
  await host.emit("session_shutdown", {}, ctx.context);
});

test("compact abort during summary cancels without latching a fault", async () => {
  const branch = [];
  const host = mockOmp({ branch });
  const ctx = extensionContext(branch);
  ctx.complete = async () => ({ content: [{ type: "text", text: "partial" }], stopReason: "aborted" });
  createOmpExtension({ compactionCompletion: (...args) => ctx.complete(...args) })(host.api);
  await startSession(host, ctx);
  const kept = await admitUser(host, ctx, branch, "keep this");
  const keptEntry = branch.find((entry) => entry.message === kept);
  const result = await host.emit(
    "session_before_compact",
    {
      type: "session_before_compact",
      preparation: {
        firstKeptEntryId: keptEntry.id,
        messagesToSummarize: [kept],
        turnPrefixMessages: [],
        tokensBefore: 1,
        settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
      },
      branchEntries: [...branch],
      signal: new AbortController().signal,
      reason: "manual",
      willRetry: false,
    },
    ctx.context,
  );
  assert.deepEqual(result, { cancel: true });
  assert.equal(ctx.aborts, 0);
  assert.equal(branch.some((entry) => entry.type === "compaction"), false);
  await host.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx.context);
});

test("compact cancellation while reading the source preserves history and subsequent Spine operations", async (t) => {
  const branch = [];
  const host = mockOmp({ branch });
  const ctx = extensionContext(branch);
  const controller = new AbortController();
  let cancelOnSnapshot = false;
  createOmpExtension({
    compactionCompletion: (...args) => ctx.complete(...args),
    onSessionReady({ runtime }) {
      const execute = runtime.client.execute.bind(runtime.client);
      runtime.client.execute = async (command) => {
        const result = await execute(command);
        if (cancelOnSnapshot && command.type === "source_snapshot") {
          cancelOnSnapshot = false;
          controller.abort();
        }
        return result;
      };
    },
  })(host.api);
  t.after(() => host.emit("session_shutdown", {}, ctx.context));
  await startSession(host, ctx);
  await admitUser(host, ctx, branch, "preserve the current owner");
  await runToolTurn(host, ctx, branch, "spine_open", { goal: "before cancelled compaction" });
  const kept = await admitUser(host, ctx, branch, "continue after cancellation");
  const keptEntry = branch.find((entry) => entry.message === kept);
  ctx.complete = async () => {
    cancelOnSnapshot = true;
    return { content: [{ type: "text", text: "valid local summary" }], stopReason: "stop" };
  };
  const result = await host.emit("session_before_compact", {
    type: "session_before_compact",
    preparation: {
      firstKeptEntryId: keptEntry.id,
      messagesToSummarize: [], turnPrefixMessages: [], tokensBefore: 1000,
      settings: { reserveTokens: 1000, keepRecentTokens: 1 },
    },
    branchEntries: [...branch],
    signal: controller.signal,
  }, ctx.context);
  assert.deepEqual(result, { cancel: true });
  assert.deepEqual(faults(host), []);
  assert.equal(ctx.aborts, 0);
  assert.equal(branch.some((entry) => entry.type === "compaction"), false);
  await runToolTurn(host, ctx, branch, "spine_open", { goal: "AFTER-COMPACTION-CANCEL" });
  sees(await modelPrompt(host, ctx, branch), "AFTER-COMPACTION-CANCEL");
});

test("session_start does not hang", async () => {
  const branch = [];
  const host = mockOmp({ branch });
  const ctx = extensionContext(branch);
  createOmpExtension()(host.api);
  await Promise.race([
    startSession(host, ctx),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error("session_start hung")), 2000);
    }),
  ]);
  await host.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx.context);
});

test("scripted model stops after close reports root and does not close again", async () => {
  const branch = [];
  const host = mockOmp({ branch });
  const ctx = extensionContext(branch);
  createOmpExtension()(host.api);
  await startSession(host, ctx);
  await admitUser(host, ctx, branch, "demo open then close");
  const run = await runScriptedModel(host, ctx, branch, decideOpenClose, 6);
  assert.equal(run.stopped, true);
  assert.equal(run.turns.at(-1).action.reason, "at-root");
  assert.deepEqual(calledTools(run), ["spine_open", "spine_close"]);
  assert.equal(lastResult(run.messages, "spine_close")?.isError, false);
  assert.equal(ctx.aborts, 0);
  await host.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx.context);
});



test("model sees user anchor, live node, JIT node body, and open cursor after open", async () => {
  await withOmp(async ({ host, ctx, branch }) => {
    await admitUser(host, ctx, branch, "inspect the tree");
    const opened = await runToolTurn(host, ctx, branch, "spine_open", { goal: "inspect" });
    const messages = await modelPrompt(host, ctx, branch);
    sees(messages, "[U1]");
    sees(messages, "inspect the tree");
    sees(messages, '<spine_node id="1.1"');
    sees(messages, 'summary="inspect"');
    sees(messages, 'status="opened"');
    assert.deepEqual(lastResult(messages, "spine_open")?.content, opened.result.content);
  });
});

test("Close keeps its result for the next sampling, then folds the branch into memory", async () => {
  await withOmp(async ({ host, ctx, branch }) => {
    await admitUser(host, ctx, branch, "close it");
    await runToolTurn(host, ctx, branch, "spine_open", { goal: "inspect" });
    const closed = await runToolTurn(host, ctx, branch, "spine_close", { memory: "inspect done" });
    const messages = await modelPrompt(host, ctx, branch);
    sees(messages, "[U1]");
    unseen(messages, "<spine_memory");
    assert.deepEqual(lastResult(messages, "spine_close")?.content, closed.result.content);
    await runReplyTurn(host, ctx, branch, "Close acknowledged");
    const folded = await modelPrompt(host, ctx, branch);
    sees(folded, "<spine_memory");
    sees(folded, "inspect done");
    unseen(folded, 'status="opened"');
    assert.equal(lastResult(folded, "spine_close"), undefined);
  });
});

test("open/close/close: second close is visible as root denial, not a user interrupt", async () => {
  await withOmp(async ({ host, ctx, branch }) => {
    await admitUser(host, ctx, branch, "close twice");
    await runToolTurn(host, ctx, branch, "spine_open", { goal: "close once" });
    const run = await runScriptedModel(host, ctx, branch, decideStubbornClose, 6);
    assert.equal(ctx.aborts, 0);
    assert.equal(run.stopped, true);
    assert.deepEqual(calledTools(run), ["spine_close", "spine_close"]);
    assert.equal(lastResult(run.messages, "spine_close")?.isError, true);
  });
});

test("root next denial is visible to the model", async () => {
  await withOmp(async ({ host, ctx, branch }) => {
    await admitUser(host, ctx, branch, "next at root");
    const next = await runToolTurn(host, ctx, branch, "spine_next", {
      memory: "none",
      goal: "sibling",
    });
    assert.equal(next.admission.block, true);
    assert.equal(next.resultMessage.isError, true);
    const messages = await modelPrompt(host, ctx, branch);
    assert.deepEqual(lastResult(messages, "spine_next")?.content, next.resultMessage.content);
    unseen(messages, "Interrupted by user");
  });
});

test("open then next: model sees sibling live and first child closed memory", async () => {
  await withOmp(async ({ host, ctx, branch }) => {
    await admitUser(host, ctx, branch, "next please");
    const run = await runScriptedModel(host, ctx, branch, decideNextThenClose, 8);
    assert.equal(run.stopped, true);
    assert.deepEqual(calledTools(run), ["spine_open", "spine_next", "spine_close"]);
    const messages = run.messages;
    sees(resultText(lastResult(run.turns.at(2).messages, "spine_next")), '<spine_node id="1.2"');
    assert.equal(lastResult(messages, "spine_close")?.isError, false);
    sees(messages, "first done");
    sees(messages, "sibling done");
  });
});

test("open next next: model sees 1.3 live", async () => {
  await withOmp(async ({ host, ctx, branch }) => {
    await admitUser(host, ctx, branch, "two nexts");
    await runToolTurn(host, ctx, branch, "spine_open", { goal: "a" });
    await runToolTurn(host, ctx, branch, "spine_next", { memory: "a done", goal: "b" });
    await runToolTurn(host, ctx, branch, "spine_next", { memory: "b done", goal: "c" });
    const messages = await modelPrompt(host, ctx, branch);
    sees(resultText(lastResult(messages, "spine_next")), '<spine_node id="1.3"');
    sees(messages, 'summary="c"');
    sees(messages, "a done");
    sees(messages, "b done");
  });
});

test("nested open/close: model sees 1.1.1 then parent 1.1 then root", async () => {
  await withOmp(async ({ host, ctx, branch }) => {
    await admitUser(host, ctx, branch, "nested");
    const run = await runScriptedModel(host, ctx, branch, decideNestedOpenClose, 8);
    assert.equal(run.stopped, true);
    assert.deepEqual(calledTools(run), ["spine_open", "spine_open", "spine_close", "spine_close"]);
    sees(resultText(lastResult(run.turns.at(2).messages, "spine_open")), '<spine_node id="1.1.1"');
    assert.equal(lastResult(run.messages, "spine_close")?.isError, false);
    const messages = await modelPrompt(host, ctx, branch);
    sees(messages, "child done");
    sees(messages, "parent done");
  });
});

test("open close open: second child is 1.2 in the model prompt", async () => {
  await withOmp(async ({ host, ctx, branch }) => {
    await admitUser(host, ctx, branch, "second child");
    await runToolTurn(host, ctx, branch, "spine_open", { goal: "first" });
    await runToolTurn(host, ctx, branch, "spine_close", { memory: "first done" });
    await runToolTurn(host, ctx, branch, "spine_open", { goal: "second" });
    const messages = await modelPrompt(host, ctx, branch);
    sees(messages, '<spine_node id="1.2"');
    sees(messages, "first done");
  });
});

test("second user turn still sees U2 and prior close memory", async () => {
  await withOmp(async ({ host, ctx, branch }) => {
    await admitUser(host, ctx, branch, "first");
    await runToolTurn(host, ctx, branch, "spine_open", { goal: "one" });
    await runToolTurn(host, ctx, branch, "spine_close", { memory: "one done" });
    await admitUser(host, ctx, branch, "再来一次");
    const messages = await modelPrompt(host, ctx, branch);
    sees(messages, "[U1]");
    sees(messages, "[U2]");
    sees(messages, "再来一次");
    sees(messages, "one done");
  });
});

test("session_tree resets a prior compact fault so open can run again", async () => {
  await withOmp(async ({ host, ctx, branch }) => {
    await host.emit("session_compact", { type: "session_compact" }, ctx.context);
    assert.ok(faults(host).length >= 1);
    await host.emit("session_tree", { type: "session_tree" }, ctx.context);
    await admitUser(host, ctx, branch, "after tree reset");
    const opened = await runToolTurn(host, ctx, branch, "spine_open", { goal: "again" });
    assert.equal(opened.admission, undefined);
    assert.match(toolText(opened.result), /<spine_node id="1\.1"/);
    unseen(await modelPrompt(host, ctx, branch), "Interrupted by user");
  });
});

test("a context-only user stays visible without reserving durable Source", async (t) => {
  const branch = [];
  const host = mockOmp({ branch });
  const ctx = extensionContext(branch);
  let runtime;
  createOmpExtension({ onSessionReady(info) { runtime = info.runtime; } })(host.api);
  t.after(() => host.emit("session_shutdown", {}, ctx.context));
  await startSession(host, ctx);
  const request = user("only in event");
  const projected = await host.emit("context", { type: "context", messages: [request] }, ctx.context);
  sees(projected.messages, request.content);
  await host.emit("message_end", { type: "message_end", message: request }, ctx.context);
  assert.deepEqual((await runtime.client.execute({ type: "source_snapshot" })).source.cells, []);
  pushMessage(branch, request);
  await modelPrompt(host, ctx, branch);
  assert.deepEqual((await runtime.client.execute({ type: "source_snapshot" })).source.cells
    .map((cell) => cell.item.Message.message), [{ boundary: 0, role: "User", content: request.content }]);
});

test("a primary request persisted after context is admitted before sampling", async (t) => {
  const branch = [];
  const host = mockOmp({ branch });
  const ctx = extensionContext(branch);
  let runtime;
  createOmpExtension({ onSessionReady(info) { runtime = info.runtime; } })(host.api);
  t.after(() => host.emit("session_shutdown", {}, ctx.context));
  await startSession(host, ctx);
  const first = await admitUser(host, ctx, branch, "prior durable request");
  const primary = user("late persisted primary request");
  await host.emit("context", { type: "context", messages: [first, primary] }, ctx.context);
  pushMessage(branch, primary);
  await host.emit("turn_start", { type: "turn_start" }, ctx.context);
  await host.emit("before_provider_request", { payload: {} }, ctx.context);
  assert.equal(samplingRecords(host).find((record) => record.type === "sampling_started").record.pre_boundary.ordinal, 1);
  await runToolTurn(host, ctx, branch, "spine_open", { goal: "late primary handled" });
  const source = (await runtime.client.execute({ type: "source_snapshot" })).source;
  assert.deepEqual(source.cells.map((cell) => cell.item.Message.message.content),
    [first.content, primary.content, ""]);
  assert.deepEqual(faults(host), []);
  await host.emit("session_shutdown", {}, ctx.context);
  const recovered = mockOmp({ branch });
  const recoveredCtx = extensionContext(branch);
  let recoveredRuntime;
  createOmpExtension({ onSessionReady(info) { recoveredRuntime = info.runtime; } })(recovered.api);
  t.after(() => recovered.emit("session_shutdown", {}, recoveredCtx.context));
  await startSession(recovered, recoveredCtx);
  assert.deepEqual((await recoveredRuntime.client.execute({ type: "source_snapshot" })).source, source);
  assert.deepEqual(faults(recovered), []);
});

for (const contextKind of ["mixed", "missing-main-event"]) {
  test(`unpersisted steering cannot overtake the reply in ${contextKind} context`, async (t) => {
    const branch = [];
    const host = mockOmp({ branch });
    const ctx = extensionContext(branch);
    let runtime;
    createOmpExtension({ onSessionReady(info) { runtime = info.runtime; } })(host.api);
    t.after(() => host.emit("session_shutdown", {}, ctx.context));
    await startSession(host, ctx);
    const initial = await admitUser(host, ctx, branch, "original request");
    await modelPrompt(host, ctx, branch);
    const before = (await runtime.client.execute({ type: "source_snapshot" })).source;
    const steering = { ...user("keep SLOGAN uppercase"), attribution: "user", steering: true };
    if (contextKind === "mixed") await host.emit("turn_start", { type: "turn_start" }, ctx.context);
    const delivery = await host.emit("context", {
      type: "context", messages: contextKind === "mixed" ? [initial, steering] : [steering],
    }, ctx.context);
    sees(delivery.messages, steering.content);
    if (contextKind === "missing-main-event") assert.deepEqual(delivery.messages, [steering]);
    await host.emit("message_end", { type: "message_end", message: steering }, ctx.context);
    assert.deepEqual((await runtime.client.execute({ type: "source_snapshot" })).source, before);
    await runToolTurn(host, ctx, branch, "spine_open", { goal: "finish original reply" });
    pushMessage(branch, steering);
    await host.emit("message_end", { type: "message_end", message: steering }, ctx.context);
    await modelPrompt(host, ctx, branch);
    const source = (await runtime.client.execute({ type: "source_snapshot" })).source;
    assert.deepEqual(source.cells.slice(-2).map((cell) => cell.item.Message.message),
      [{ boundary: 1, role: "Assistant", content: "" }, { boundary: 2, role: "User", content: steering.content }]);
    assert.deepEqual(faults(host), []);
    await host.emit("session_shutdown", {}, ctx.context);
    const recovered = mockOmp({ branch });
    const recoveredCtx = extensionContext(branch);
    let recoveredRuntime;
    createOmpExtension({ onSessionReady(info) { recoveredRuntime = info.runtime; } })(recovered.api);
    t.after(() => recovered.emit("session_shutdown", {}, recoveredCtx.context));
    await startSession(recovered, recoveredCtx);
    assert.deepEqual((await recoveredRuntime.client.execute({ type: "source_snapshot" })).source, source);
    assert.deepEqual(faults(recovered), []);
  });
}

test("live steering batches do not claim the in-flight assistant Source or rewrite the provider's user-only input", async (t) => {
  const branch = [];
  const host = mockOmp({ branch });
  const ctx = extensionContext(branch);
  let runtime;
  createOmpExtension({ onSessionReady(info) { runtime = info.runtime; } })(host.api);
  t.after(() => host.emit("session_shutdown", {}, ctx.context));
  await startSession(host, ctx);
  await admitUser(host, ctx, branch, "STEERING-INITIAL-REQUEST");
  await runToolTurn(host, ctx, branch, "spine_open", { goal: "STEERING-PARENT" });
  await runToolTurn(host, ctx, branch, "spine_open", { goal: "STEERING-CHILD" });
  await modelPrompt(host, ctx, branch);
  await host.emit("turn_start", { type: "turn_start" }, ctx.context);
  await host.emit("before_provider_request", { payload: {} }, ctx.context);
  const before = (await runtime.client.execute({ type: "source_snapshot" })).source;
  const steering = { ...user("STEERING-QUEUED-REQUEST"), attribution: "user", steering: true };
  // Native openLiveSteering.toProvider transforms this batch alone while the
  // main assistant is still streaming; it is not a full context snapshot.
  const delivery = await host.emit("context", { type: "context", messages: [steering] }, ctx.context);
  assert.deepEqual(delivery.messages, [steering], "Spine history must not contaminate response.steer's user-only batch");
  assert.deepEqual((await runtime.client.execute({ type: "source_snapshot" })).source, before,
    "a steering candidate cannot claim Source before the assistant it interrupts");
  const closed = await runToolTurn(host, ctx, branch, "spine_close", { memory: "STEERING-CHILD-DONE" });
  assert.equal(closed.admission, undefined);
  assert.match(toolText(closed.result), /\b1\.1\b/);
  pushMessage(branch, steering);
  await host.emit("message_end", { type: "message_end", message: steering }, ctx.context);
  const next = await modelPrompt(host, ctx, branch);
  sees(next, "STEERING-QUEUED-REQUEST");
  sees(next, "STEERING-CHILD-DONE");
  const source = (await runtime.client.execute({ type: "source_snapshot" })).source;
  assert.deepEqual(source.cells.slice(-2).map((cell) => cell.item.Message.message),
    [{ boundary: 3, role: "Assistant", content: "" }, { boundary: 4, role: "User", content: steering.content }]);
  assert.deepEqual(faults(host), []);
  await host.emit("session_shutdown", {}, ctx.context);
  const recovered = mockOmp({ branch });
  const recoveredCtx = extensionContext(branch);
  let recoveredRuntime;
  createOmpExtension({ onSessionReady(info) { recoveredRuntime = info.runtime; } })(recovered.api);
  t.after(() => recovered.emit("session_shutdown", {}, recoveredCtx.context));
  await startSession(recovered, recoveredCtx);
  assert.deepEqual((await recoveredRuntime.client.execute({ type: "source_snapshot" })).source, source);
  const parent = await runToolTurn(recovered, recoveredCtx, branch, "spine_close", { memory: "STEERING-PARENT-DONE" });
  assert.equal(parent.admission, undefined);
  assert.match(toolText(parent.result), /\broot\b/i);
  assert.deepEqual(faults(recovered), []);
});

test("detached snapshots preserve side input without changing main sources, sampling, or replay", async (t) => {
  const branch = [];
  const host = mockOmp({ branch });
  const ctx = extensionContext(branch);
  let runtime;
  createOmpExtension({ onSessionReady(info) { runtime = info.runtime; } })(host.api);
  t.after(() => host.emit("session_shutdown", {}, ctx.context));
  await startSession(host, ctx);

  const first = user("MAIN-HUMAN");
  pushMessage(branch, first);
  const mainContext = await host.emit("context", { type: "context", messages: [first] }, ctx.context);
  await host.emit("before_provider_request", { payload: {} }, ctx.context);
  assert.deepEqual(host.entries, [], "context setup and idle requests cannot start sampling");
  await host.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: nextTs() }, ctx.context);
  assert.deepEqual(host.entries, [], "turn setup alone cannot start sampling");
  await host.emit("before_provider_request", { payload: {} }, ctx.context);
  const beforeSide = (await runtime.client.execute({ type: "source_snapshot" })).source;
  assert.deepEqual(beforeSide.cells.map((cell) => cell.boundary), [0]);
  assert.deepEqual(beforeSide.cells.map((cell) => cell.item.Message.message.content), ["MAIN-HUMAN"]);

  const reply = {
    role: "assistant", content: [{ type: "text", text: "MAIN-FULL-REPLY" }],
    stopReason: "stop", timestamp: nextTs(),
  };
  const partial = { ...reply, content: [{ type: "thinking", thinking: "SIDE-PARTIAL-THINKING" },
    { type: "text", text: "SIDE-STREAMING-PARTIAL" }] };
  const detached = [
    { role: "developer", attribution: "agent", timestamp: nextTs(),
      content: [{ type: "text", text: "SIDE-NO-TOOLS-REMINDER" }] },
    { ...user("SIDE-PRIOR-QUESTION"), attribution: "agent" },
    { role: "assistant", content: [{ type: "text", text: "SIDE-PRIOR-ANSWER" }],
      stopReason: "stop", timestamp: nextTs() },
    { ...user("SIDE-CURRENT-QUESTION"), attribution: "agent" },
  ];
  // OMP observers can see a real sampling archive before the queued human's
  // persistence catches up. Side preview must not rebuild that incomplete branch.
  const overlapping = await host.emit("context", {
    type: "context", messages: [first, partial, ...detached],
  }, ctx.context);
  assert.deepEqual(overlapping.messages.slice(-5), [partial, ...detached]);
  assert.equal(overlapping.messages.filter((message) => message.role === "user"
    && message.timestamp === first.timestamp).length, 1);
  sees(overlapping.messages, "[U1]");
  assert.deepEqual((await runtime.client.execute({ type: "source_snapshot" })).source, beforeSide);
  await host.emit("before_provider_request", { payload: {} }, ctx.context);

  await host.emit("message_end", { type: "message_end", message: first }, ctx.context);
  await host.emit("message_end", { type: "message_end", message: reply }, ctx.context);
  pushMessage(branch, reply);
  const racingSideRequest = host.emit("before_provider_request", { payload: {} }, ctx.context);
  await host.emit("turn_end", { type: "turn_end", turnIndex: 0, message: reply, toolResults: [] }, ctx.context);
  await racingSideRequest;
  const committedFirst = (await runtime.client.execute({ type: "source_snapshot" })).source;
  assert.deepEqual(committedFirst.cells.map((cell) => cell.boundary), [0, 1]);
  assert.deepEqual(committedFirst.cells.map((cell) => cell.item.Message.message.content),
    ["MAIN-HUMAN", "MAIN-FULL-REPLY"]);
  const idleSide = await host.emit("context", {
    type: "context", messages: [first, reply, ...detached],
  }, ctx.context);
  assert.deepEqual(idleSide.messages.slice(-4), detached);
  await host.emit("before_provider_request", { payload: {} }, ctx.context);
  assert.deepEqual((await runtime.client.execute({ type: "source_snapshot" })).source, committedFirst);

  await admitUser(host, ctx, branch, "NEXT-MAIN-HUMAN");
  const opened = await runToolTurn(host, ctx, branch, "spine_open", { goal: "HEALTHY-MAIN-NODE" });
  assert.equal(opened.admission, undefined);
  assert.match(toolText(opened.result), /<spine_node id="1\.1"/);
  const committedSource = (await runtime.client.execute({ type: "source_snapshot" })).source;
  assert.deepEqual(committedSource.cells.map((cell) => cell.boundary), [0, 1, 2, 3]);
  assert.deepEqual(committedSource.cells.map((cell) => cell.item.Message.message), [
    { boundary: 0, role: "User", content: "MAIN-HUMAN" },
    { boundary: 1, role: "Assistant", content: "MAIN-FULL-REPLY" },
    { boundary: 2, role: "User", content: "NEXT-MAIN-HUMAN" },
    { boundary: 3, role: "Assistant", content: "" },
  ]);
  const archives = samplingRecords(host);
  assert.deepEqual(archives.map((archive) => archive.type),
    ["sampling_started", "sampling_commit", "sampling_started", "sampling_commit"]);
  assert.deepEqual(archives.map((archive) => archive.record.pre_boundary.ordinal), [0, 0, 2, 2]);
  assert.deepEqual(archives.filter((archive) => archive.type === "sampling_commit")
    .map((archive) => [archive.record.post_boundary.ordinal, archive.record.executions.length]), [[1, 0], [3, 1]]);
  const sideWithNode = await host.emit("context", {
    type: "context", messages: [...branch.flatMap((entry) => entry.message ? [entry.message] : []), ...detached],
  }, ctx.context);
  sees(sideWithNode.messages, 'summary="HEALTHY-MAIN-NODE"');
  assert.deepEqual(sideWithNode.messages.slice(-4), detached);
  assert.deepEqual((await runtime.client.execute({ type: "source_snapshot" })).source, committedSource);
  assert.deepEqual(faults(host), []);

  await host.emit("session_shutdown", {}, ctx.context);
  const recovered = mockOmp({ branch });
  const recoveredCtx = extensionContext(branch);
  let recoveredRuntime;
  createOmpExtension({ onSessionReady(info) { recoveredRuntime = info.runtime; } })(recovered.api);
  t.after(() => recovered.emit("session_shutdown", {}, recoveredCtx.context));
  await startSession(recovered, recoveredCtx);
  assert.deepEqual(faults(recovered), []);
  assert.deepEqual((await recoveredRuntime.client.execute({ type: "source_snapshot" })).source, committedSource);
  const replayed = await modelPrompt(recovered, recoveredCtx, branch);
  sees(replayed, 'summary="HEALTHY-MAIN-NODE"');
  unseen(replayed, "SIDE-");
  const closed = await runToolTurn(recovered, recoveredCtx, branch, "spine_close", { memory: "MAIN-REPLAY-CLOSE" });
  assert.equal(closed.admission, undefined);
  assert.match(toolText(closed.result), /\broot\b/i);
  assert.deepEqual(faults(recovered), []);
  assert.equal(ctx.aborts, 0);
  assert.equal(recoveredCtx.aborts, 0);
});

test("turn_end drains provider admission waiting on main sources before commit and replay", async (t) => {
  const branch = [];
  const host = mockOmp({ branch });
  const ctx = extensionContext(branch);
  let runtime;
  createOmpExtension({ onSessionReady(info) { runtime = info.runtime; } })(host.api);
  t.after(() => host.emit("session_shutdown", {}, ctx.context));
  await startSession(host, ctx);
  await admitUser(host, ctx, branch, "PAUSED-MAIN-HUMAN");
  await modelPrompt(host, ctx, branch);
  await host.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: nextTs() }, ctx.context);
  await host.emit("before_provider_request", { payload: {} }, ctx.context);

  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const execute = runtime.client.execute.bind(runtime.client);
  let pauseOnce = true;
  runtime.client.execute = async (command) => {
    if (command.type === "observe_sources" && pauseOnce) {
      pauseOnce = false;
      entered.resolve();
      await release.promise;
    }
    return execute(command);
  };
  t.after(() => release.resolve());
  const reply = { role: "assistant", content: [{ type: "text", text: "PAUSED-MAIN-REPLY" }],
    stopReason: "stop", timestamp: nextTs() };
  pushMessage(branch, reply);
  const observed = host.emit("message_end", { message: reply }, ctx.context);
  await entered.promise;
  const admitted = host.emit("before_provider_request", { payload: {} }, ctx.context);
  await new Promise((resolve) => setImmediate(resolve));
  let finished = false;
  const ending = host.emit("turn_end", {
    type: "turn_end", turnIndex: 0, message: reply, toolResults: [],
  }, ctx.context).then(() => { finished = true; });
  await host.emit("before_provider_request", { payload: {} }, ctx.context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished, false, "commit must wait for the admitted provider hook");
  assert.deepEqual(samplingRecords(host).map((record) => record.type), ["sampling_started"],
    "paused source admission cannot leave a premature commit");
  release.resolve();
  await Promise.all([admitted, observed, ending]);
  assert.deepEqual(samplingRecords(host).map((record) => record.type),
    ["sampling_started", "sampling_commit"]);
  assert.deepEqual(samplingRecords(host).map((record) => record.record.pre_boundary.ordinal), [0, 0]);
  assert.equal(samplingRecords(host).at(-1).record.post_boundary.ordinal, 1);

  await admitUser(host, ctx, branch, "NEXT-AFTER-PAUSE");
  const opened = await runToolTurn(host, ctx, branch, "spine_open", { goal: "after paused admission" });
  assert.equal(opened.admission, undefined);
  assert.match(toolText(opened.result), /<spine_node id="1\.1"/);
  const source = (await runtime.client.execute({ type: "source_snapshot" })).source;
  assert.deepEqual(source.cells.map((cell) => cell.boundary), [0, 1, 2, 3]);
  assert.deepEqual(source.cells.map((cell) => cell.item.Message.message.content),
    ["PAUSED-MAIN-HUMAN", "PAUSED-MAIN-REPLY", "NEXT-AFTER-PAUSE", ""]);
  assert.deepEqual(faults(host), []);
  await host.emit("session_shutdown", {}, ctx.context);

  const recovered = mockOmp({ branch });
  const recoveredCtx = extensionContext(branch);
  let recoveredRuntime;
  createOmpExtension({ onSessionReady(info) { recoveredRuntime = info.runtime; } })(recovered.api);
  t.after(() => recovered.emit("session_shutdown", {}, recoveredCtx.context));
  await startSession(recovered, recoveredCtx);
  assert.deepEqual(faults(recovered), []);
  assert.deepEqual((await recoveredRuntime.client.execute({ type: "source_snapshot" })).source, source);
  const closed = await runToolTurn(recovered, recoveredCtx, branch, "spine_close", { memory: "pause replay done" });
  assert.equal(closed.admission, undefined);
  assert.match(toolText(closed.result), /\broot\b/i);
  assert.deepEqual(faults(recovered), []);
});

test("durable agent-attributed developer and user messages remain real main sources", async (t) => {
  const reminder = { role: "developer", attribution: "agent", timestamp: nextTs(),
    content: [{ type: "text", text: "MAIN-AGENT-REMINDER" }] };
  const request = { ...user("MAIN-AGENT-REQUEST"), attribution: "agent" };
  const branch = [];
  pushMessage(branch, reminder);
  pushMessage(branch, request);
  const host = mockOmp({ branch });
  const ctx = extensionContext(branch);
  let runtime;
  createOmpExtension({ onSessionReady(info) { runtime = info.runtime; } })(host.api);
  t.after(() => host.emit("session_shutdown", {}, ctx.context));
  await startSession(host, ctx);
  const projected = await host.emit("context", { type: "context", messages: [reminder, request] }, ctx.context);
  sees(projected.messages, "MAIN-AGENT-REMINDER");
  sees(projected.messages, "MAIN-AGENT-REQUEST");
  const source = (await runtime.client.execute({ type: "source_snapshot" })).source;
  assert.deepEqual(source.cells.map((cell) => cell.boundary), [0, 1]);
  assert.deepEqual(source.cells.map((cell) => cell.item.Message.message.content),
    ["MAIN-AGENT-REMINDER", "MAIN-AGENT-REQUEST"]);
  const opened = await runToolTurn(host, ctx, branch, "spine_open", { goal: "native main request" });
  assert.equal(opened.admission, undefined);
  assert.match(toolText(opened.result), /<spine_node id="1\.1"/);
  assert.deepEqual(faults(host), []);
});

test("extra before_provider_request reuses the same sampling", async () => {
  await withOmp(async ({ host, ctx, branch }) => {
    await admitUser(host, ctx, branch, "one turn");
    await host.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: nextTs() }, ctx.context);
    await host.emit(
      "before_provider_request",
      { type: "before_provider_request", payload: { n: 1 } },
      ctx.context,
    );
    await host.emit(
      "before_provider_request",
      { type: "before_provider_request", payload: { n: 2 } },
      ctx.context,
    );
    await runToolTurn(host, ctx, branch, "spine_open", { goal: "once" });
    assert.deepEqual(samplingRecords(host).map(({ type }) => type), ["sampling_started", "sampling_commit"]);
  });
});

test("duplicate native admission of one tool call commits one operation", async () => {
  await withOmp(async ({ host, ctx, branch }) => {
    await admitUser(host, ctx, branch, "repeat the call event");
    const input = { goal: "inspect" };
    const opened = await runToolTurn(host, ctx, branch, "spine_open", input, {
      async beforeCommit({ toolCallId }) {
        assert.equal(await host.emit("tool_call", { type: "tool_call", toolCallId, toolName: "spine_open", input }, ctx.context), undefined);
      },
    });
    assert.equal(opened.admission, undefined);
    assert.equal(samplingRecords(host).at(-1).record.executions.length, 1);
    assert.equal(ctx.aborts, 0);
    assert.deepEqual(faults(host), []);
  });
});

test("invalid close input is blocked without closing the node or aborting", async () => {
  await withOmp(async ({ host, ctx, branch }) => {
    await admitUser(host, ctx, branch, "bad close");
    await runToolTurn(host, ctx, branch, "spine_open", { goal: "stay open" });
    const invalid = await runToolTurn(host, ctx, branch, "spine_close", {});
    assert.equal(invalid.resultMessage.isError, true);
    assert.deepEqual(samplingRecords(host).at(-1).record.executions, []);
    const valid = await runToolTurn(host, ctx, branch, "spine_close", { memory: "now close" });
    assert.equal(valid.resultMessage.isError, false);
    assert.equal(ctx.aborts, 0);
    assert.deepEqual(faults(host), []);
  });
});

test("spawn rejects one task and seventeen tasks without aborting", async () => {
  await withOmp(async ({ host, ctx, branch }) => {
    await admitUser(host, ctx, branch, "bad spawn size");
    await host.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: nextTs() }, ctx.context);
    await host.emit(
      "before_provider_request",
      { type: "before_provider_request", payload: { model: MOCK_MODEL_ID } },
      ctx.context,
    );
    const one = await host.emit(
      "tool_call",
      {
        type: "tool_call",
        toolCallId: "spawn-1",
        toolName: "spine_spawn",
        input: { tasks: [{ summary: "only", prompt: "p" }] },
      },
      ctx.context,
    );
    const seventeen = await host.emit(
      "tool_call",
      {
        type: "tool_call",
        toolCallId: "spawn-17",
        toolName: "spine_spawn",
        input: {
          tasks: Array.from({ length: 17 }, (_, index) => ({ summary: `s${index}`, prompt: "p" })),
        },
      },
      ctx.context,
    );
    assert.equal(one.block, true);
    assert.equal(seventeen.block, true);
    assert.equal(ctx.aborts, 0);
  });
});



test("compact empty summary cancels without aborting", async () => {
  await withOmp(async ({ host, ctx, branch }) => {
    ctx.complete = async () => ({ content: [{ type: "text", text: "   " }], stopReason: "stop" });

    const kept = await admitUser(host, ctx, branch, "keep");
    const keptEntry = branch.find((entry) => entry.message === kept);
    const result = await host.emit(
      "session_before_compact",
      {
        type: "session_before_compact",
        preparation: {
          firstKeptEntryId: keptEntry.id,
          messagesToSummarize: [kept],
          turnPrefixMessages: [],
          tokensBefore: 1,
          settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
        },
        branchEntries: [...branch],
        signal: new AbortController().signal,
        reason: "manual",
        willRetry: false,
      },
      ctx.context,
    );
    assert.deepEqual(result, { cancel: true });
    assert.equal(ctx.aborts, 0);
    assert.equal(branch.some((entry) => entry.type === "compaction"), false);
  });
});

test("Spine chooses a real user boundary instead of the native proposed cut", async () => {
  await withOmp(async ({ host, ctx, branch }) => {
    const kept = await admitUser(host, ctx, branch, "keep");
    const keptId = branch.find((entry) => entry.message === kept).id;
    const result = await host.emit(
      "session_before_compact",
      {
        type: "session_before_compact",
        preparation: {
          firstKeptEntryId: "missing",
          messagesToSummarize: [],
          turnPrefixMessages: [],
          tokensBefore: 1,
          settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
        },
        branchEntries: [...branch],
        signal: new AbortController().signal,
        reason: "manual",
        willRetry: false,
      },
      ctx.context,
    );
    assert.equal(result.compaction?.firstKeptEntryId, keptId);
    assert.equal(ctx.aborts, 0);
  });
});

test("compaction passes remaining tool declarations and ignores raw-only transcript", async () => {
  let requestContext;
  const bash = { name: "bash", description: "run", parameters: { type: "object" } };
  const gone = { name: "old", description: "gone", parameters: { type: "object" } };
  await withOmp(async ({ host, ctx, branch }) => {
    ctx.complete = async (_model, context) => {
      requestContext = context;
      return { content: [{ type: "text", text: "context summary" }], stopReason: "stop" };
    };
    const visible = await admitUser(host, ctx, branch, "model-visible-turn");
    const visibleId = branch.find((entry) => entry.message === visible).id;
    const result = await host.emit(
      "session_before_compact",
      {
        type: "session_before_compact",
        preparation: {
          firstKeptEntryId: visibleId,
          messagesToSummarize: [user("RAW-ONLY")],
          turnPrefixMessages: [],
          tokensBefore: 12,
          settings: { enabled: true, reserveTokens: 52429, keepRecentTokens: 20000 },
        },
        branchEntries: [...branch],
        signal: new AbortController().signal,
        reason: "threshold",
        willRetry: false,
      },
      ctx.context,
    );
    assert.ok(result?.compaction, JSON.stringify({ result, faults: faults(host), notes: ctx.notifications }));
    assert.equal(result.compaction.summary, "context summary");
    assert.deepEqual(requestContext.tools, [bash]);
    const rendered = JSON.stringify(requestContext.messages);
    assert.equal(rendered.includes("model-visible-turn"), true);
    assert.equal(rendered.includes("RAW-ONLY"), false);
    assert.equal(requestContext.messages.some((message) => message.role === "system"), false);
    assert.equal(ctx.aborts, 0);
  }, { allTools: [bash, gone], activeTools: ["bash"] });
});

async function commitFixtureReply({ sessionPath, sessionId, assignment }, text, inspect = () => {}) {
  const [header, ...branch] = (await readFile(sessionPath, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
  const prefixLength = branch.length;
  const options = { branch, childFlag: true, sessionId, sessionFile: sessionPath, header };
  const host = mockOmp(options);
  const ctx = extensionContext(branch, options);
  createOmpExtension()(host.api);
  await startSession(host, ctx);
  try {
    assert.deepEqual(faults(host), []);
    inspect(await modelPrompt(host, ctx, branch));
    await admitUser(host, ctx, branch, assignment);
    await runReplyTurn(host, ctx, branch, text);
    assert.deepEqual(faults(host), []);
    await appendFile(sessionPath, branch.slice(prefixLength).map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  } finally {
    await host.emit("session_shutdown", {}, ctx.context);
  }
}

function childExit(code = 0, diagnostic = "") {
  return { command: process.execPath, args: ["-e", `process.stderr.write(${JSON.stringify(diagnostic)}); process.exitCode = ${code};`, "--"] };
}

function collectArrivals(count) {
  const entries = [];
  const { promise, resolve } = Promise.withResolvers();
  return {
    entries,
    promise,
    onArrival(entry) {
      entries.push(entry);
      if (entries.length === count) resolve([...entries].sort((a, b) => a.data.producer.at(-1) - b.data.producer.at(-1)));
    },
  };
}

test("Spawn stages, then children inherit the parent scope and publish separate final replies", { timeout: 15_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "omp-extension-spawn-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const arrivals = collectArrivals(2);
  const release = Promise.withResolvers();
  const launched = [];
  const tasks = [{ summary: "left", prompt: "left work" }, { summary: "right", prompt: "right work" }];
  const memories = ["LEFT-CHILD-FINAL-REPLY", "RIGHT-CHILD-FINAL-REPLY"];
  await withOmp(async ({ host, ctx, branch }) => {
    try {
      await admitUser(host, ctx, branch, "initial parent request");
      await runToolTurn(host, ctx, branch, "spine_open", { goal: "current owner" });
      await admitUser(host, ctx, branch, "LATEST-PARENT-CONSTRAINT");
      const spawned = await runToolTurn(host, ctx, branch, "spine_spawn", { tasks }, {
        beforeCommit({ result, toolCallId }) {
          assert.equal(result.details.staged, true);
          assert.equal(result.details.batchId, toolCallId);
          assert.deepEqual(result.details.tasks.map(({ summary, status }) => [summary, status]),
            tasks.map(({ summary }) => [summary, "running"]));
          assert.deepEqual(launched, []);
          assert.deepEqual(arrivals.entries, []);
        },
      });
      assert.equal(spawned.resultMessage.isError, false);
      const spawnCommit = branch.at(-1);
      assert.equal(spawnCommit.customType, OMP_ARCHIVE_ENTRY_TYPE);
      assert.equal(spawnCommit.data.schema, OMP_ADAPTER_ID);
      assert.deepEqual(spawnCommit.data.record.record.executions.map(({ operation }) => operation), [{ type: "spawn", tasks }]);
      const pending = await runToolTurn(host, ctx, branch, "spine_close", { memory: "too early" });
      assert.equal(pending.resultMessage.isError, true);
      assert.deepEqual(arrivals.entries, []);
      release.resolve();
      const delivered = await arrivals.promise;
      assert.deepEqual(launched.map(({ batchId }) => batchId), [spawnCommit.id, spawnCommit.id]);
      assert.deepEqual(delivered.map(({ type, data }) => [type, data.outcome, data.memory]),
        memories.map((memory) => ["custom", "completed", memory]));
      assert.ok(host.sentMessages.some(({ options }) => options.deliverAs === "nextTurn" && options.triggerTurn));
      const messages = await modelPrompt(host, ctx, branch);
      assert.deepEqual(messages.filter(({ customType }) => customType === SPINE_ARRIVAL_CUSTOM_TYPE)
        .map(({ details }) => details.memory).sort(), [...memories].sort());
      for (const memory of memories) sees(messages, memory);
      const closed = await runToolTurn(host, ctx, branch, "spine_close", { memory: "parent result" });
      assert.equal(closed.resultMessage.isError, false);
      assert.equal(ctx.aborts, 0);
      assert.deepEqual(faults(host), []);
    } finally {
      release.resolve();
    }
  }, { onArrival: arrivals.onArrival }, { cwd: dir, sessionFile: join(dir, "parent.jsonl") }, {
    async childInvocation(child) {
      launched.push(child);
      await release.promise;
      await commitFixtureReply(child, memories[tasks.findIndex(({ summary }) => summary === child.task.summary)], (messages) => {
        sees(messages, 'summary="current owner"');
        sees(messages, "LATEST-PARENT-CONSTRAINT");
      });
      return childExit();
    },
  });
});

for (const choice of ["Abandon", "Retry", "Continue"]) {
  test(`Spawn ${choice} publishes one terminal arrival per child`, { timeout: 15_000 }, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "omp-extension-recovery-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const arrivals = collectArrivals(2);
    const attempts = [];
    const failure = "CHILD-PROCESS-FAILED";
    const choices = [];
    await withOmp(async ({ host, ctx, branch }) => {
      await admitUser(host, ctx, branch, "spawn with one recoverable failure");
      const spawned = await runToolTurn(host, ctx, branch, "spine_spawn", {
        tasks: [{ summary: "recover", prompt: "recovering child" }, { summary: "peer", prompt: "successful peer" }],
      });
      assert.equal(spawned.resultMessage.isError, false);
      const [child, peer] = (await arrivals.promise).map(({ data }) => data);
      assert.deepEqual([peer.outcome, peer.memory], ["completed", "PEER-REPLY"]);
      assert.equal(choices.length, 1);
      assert.ok(choices[0].includes(choice));
      if (choice === "Abandon") {
        assert.equal(attempts.length, 1);
        assert.equal(child.outcome, "errored");
        assert.ok(child.diagnostic.includes(failure));
        assert.equal(child.memory, undefined);
      } else {
        assert.deepEqual(attempts.map(({ mode }) => mode), ["initial", choice.toLowerCase()]);
        assert.equal(attempts[0].sessionPath === attempts[1].sessionPath, choice === "Continue");
        assert.equal(attempts[0].sessionId === attempts[1].sessionId, choice === "Continue");
        assert.deepEqual([child.outcome, child.memory], ["completed", "RECOVERED-REPLY"]);
      }
      const messages = await modelPrompt(host, ctx, branch);
      sees(messages, peer.memory);
      sees(messages, choice === "Abandon" ? failure : child.memory);
      assert.deepEqual(faults(host), []);
      assert.equal(ctx.aborts, 0);
    }, { onArrival: arrivals.onArrival }, {
      cwd: dir,
      sessionFile: join(dir, "parent.jsonl"),
      async select(_title, offered) { choices.push(offered); return choice; },
      async input() { return "try again"; },
    }, {
      async childInvocation(child) {
        if (child.task.summary === "recover") {
          attempts.push(child);
          if (child.mode === "initial") return childExit(2, failure);
        }
        await commitFixtureReply(child, child.task.summary === "peer" ? "PEER-REPLY" : "RECOVERED-REPLY");
        return childExit();
      },
    });
  });
}

test("compaction sends the live JIT node to the summary model", async () => {
  await withOmp(async ({ host, ctx, branch }) => {
    await admitUser(host, ctx, branch, "inspect before compact");
    await runToolTurn(host, ctx, branch, "spine_open", { goal: "LIVE-SUMMARY-NODE" });
    const kept = await admitUser(host, ctx, branch, "continue after compact");
    const keptId = branch.find((entry) => entry.message === kept).id;
    ctx.complete = async (_model, request) => {
      sees(request.messages, '<spine_node id="1.1" summary="LIVE-SUMMARY-NODE"');
      return { content: [{ type: "text", text: "retain current node" }], stopReason: "stop" };
    };
    const result = await host.emit("session_before_compact", {
      type: "session_before_compact",
      preparation: {
        firstKeptEntryId: keptId,
        messagesToSummarize: [], turnPrefixMessages: [], tokensBefore: 1000,
        settings: { reserveTokens: 1000, keepRecentTokens: 1 },
      },
      branchEntries: [...branch],
      signal: new AbortController().signal,
    }, ctx.context);
    assert.equal(result?.compaction?.summary, "retain current node");
    assert.equal(faults(host).length, 0);
  });
});

test("resumed eval runtime notice remains model-visible without entering commits or child replay", async (t) => {
  const branch = [];
  const host = mockOmp({ branch });
  const ctx = extensionContext(branch);
  let runtime;
  createOmpExtension({ onSessionReady(info) { runtime = info.runtime; } })(host.api);
  t.after(() => host.emit("session_shutdown", {}, ctx.context));
  await startSession(host, ctx);
  const human = user("durable main request");
  pushMessage(branch, human);
  await host.emit("message_end", { type: "message_end", message: human }, ctx.context);
  const runtimeNotice = { role: "custom", customType: "eval-state-context",
    content: "current runtime is cold; historical variables were not restored",
    display: false, attribution: "agent", timestamp: nextTs() };
  const visible = await host.emit("context", { type: "context", messages: [runtimeNotice, human] }, ctx.context);
  assert.ok(visible.messages.some((message) => message.customType === "eval-state-context"
    && message.content === runtimeNotice.content));
  const source = (await runtime.client.execute({ type: "source_snapshot" })).source;
  assert.deepEqual(source.cells.map((cell) => cell.item.Message.message.content), ["durable main request"]);
  await runToolTurn(host, ctx, branch, "spine_open", { goal: "after runtime notice" });
  const commit = samplingRecords(host).find((record) => record.type === "sampling_commit");
  assert.equal(commit.record.post_boundary.ordinal, 1);
  const childBranch = structuredClone(branch);
  const childOptions = { branch: childBranch, childFlag: true, sessionId: "runtime-notice-child" };
  const child = mockOmp(childOptions);
  const childCtx = extensionContext(childBranch, childOptions);
  createOmpExtension()(child.api);
  t.after(() => child.emit("session_shutdown", {}, childCtx.context));
  await startSession(child, childCtx);
  assert.deepEqual(faults(child), []);
  unseen(await modelPrompt(child, childCtx, childBranch), runtimeNotice.content);
  await admitUser(child, childCtx, childBranch, "return recovered assignment");
  const reply = await runReplyTurn(child, childCtx, childBranch, "replay healthy");
  assert.equal(samplingRecords(child).at(-1).record.terminal, undefined);
  sees(await modelPrompt(child, childCtx, childBranch), reply.content[0].text);
  assert.deepEqual(faults(child), []);
});

test("a child with a missing inherited replay source fails before inference", async (t) => {
  const parentBranch = [];
  const parent = mockOmp({ branch: parentBranch });
  const parentCtx = extensionContext(parentBranch);
  createOmpExtension()(parent.api);
  t.after(() => parent.emit("session_shutdown", {}, parentCtx.context));
  await startSession(parent, parentCtx);
  await admitUser(parent, parentCtx, parentBranch, "inherited parent request");
  await runToolTurn(parent, parentCtx, parentBranch, "spine_open", { goal: "inherited owner" });
  assert.deepEqual(faults(parent), []);
  const missingSource = parentBranch.find((entry) => entry.message?.role === "assistant");
  assert.ok(missingSource);
  const branch = structuredClone(parentBranch.filter((entry) => entry.id !== missingSource.id));
  const host = mockOmp({ branch, childFlag: true });
  const ctx = extensionContext(branch);
  createOmpExtension()(host.api);
  t.after(() => host.emit("session_shutdown", {}, ctx.context));
  await startSession(host, ctx);
  const [startupFault] = faults(host);
  assert.equal(faults(host).length, 1);
  assert.equal(startupFault.data.hook, "session_start");
  assert.equal(startupFault.data.stage, "initialize_session");
  assert.equal(startupFault.data.errors[0].name, "OmpSessionRecoveryError");
  let providerRequests = 0;
  let cause;
  await assert.rejects(async () => {
    await host.beforeModelCall();
    providerRequests += 1;
  }, (error) => {
    cause = error.cause;
    assert.equal(cause.message, startupFault.data.errors[0].message);
    assert.equal(cause.name, startupFault.data.errors[0].name);
    return true;
  });
  await assert.rejects(host.beforeModelCall(), (error) => {
    assert.equal(error.cause, cause);
    return true;
  });
  assert.equal(providerRequests, 0);
  assert.equal(faults(host).length, 1);
  assert.equal(ctx.aborts, 0);
});


test("a known child runtime fault rejects inference and control execution", async (t) => {
  const branch = [];
  const host = mockOmp({ branch, childFlag: true });
  const ctx = extensionContext(branch);
  createOmpExtension()(host.api);
  t.after(() => host.emit("session_shutdown", {}, ctx.context));
  await startSession(host, ctx);
  await host.emit("session_compact", { type: "session_compact" }, ctx.context);
  assert.equal(faults(host).length, 1);
  let cause;
  await assert.rejects(host.beforeModelCall(), (error) => {
    cause = error.cause;
    assert.ok(cause instanceof Error);
    assert.equal(cause.message, faults(host)[0].data.errors[0].message);
    return true;
  });
  await assert.rejects(host.tools.get("spine_open").execute(
    "open-after-runtime-fault", { goal: "must not be accepted" },
  ), (error) => {
    assert.equal(error.cause, cause);
    return true;
  });
  await assert.rejects(host.beforeModelCall(), (error) => {
    assert.equal(error.cause, cause);
    return true;
  });
  assert.equal(faults(host).length, 1);
});

test("a final-reply commit observer failure latches the child fault", async () => {
  const branch = [];
  const host = mockOmp({ branch, childFlag: true });
  const ctx = extensionContext(branch);
  const publicationFault = new Error("terminal publication failed");
  createOmpExtension({
    onSamplingCommit() { throw publicationFault; },
  })(host.api);
  await startSession(host, ctx);
  await admitUser(host, ctx, branch, "persist before completing");
  await runReplyTurn(host, ctx, branch, "terminal memory");
  await assert.rejects(host.beforeModelCall(), (error) => {
    assert.equal(error.cause, publicationFault);
    return true;
  });
  assert.equal(faults(host).length, 1);
  assert.equal(ctx.aborts, 0);
  await host.emit("session_shutdown", {}, ctx.context);
});

function mockNativeSession() {
  const branch = [];
  const options = { branch, sessionId: "native-A" };
  const leafChanges = [];
  const physicalEntries = new Map();
  options.sessionManager = {
    getSessionId: () => options.sessionId,
    getSessionFile: () => `/tmp/${options.sessionId}.jsonl`,
    getBranch: () => [...branch],
    getHeader: () => ({ id: options.sessionId }),
    flushSync() {},
    getLeafId: () => branch.at(-1)?.id ?? null,
    getEntries() {
      for (const entry of branch) physicalEntries.set(entry.id, entry);
      return [...physicalEntries.values()];
    },
    branch(id) {
      this.getEntries();
      const index = branch.findIndex((entry) => entry.id === id);
      assert.ok(index >= 0);
      leafChanges.push(id);
      branch.splice(index + 1);
    },
    resetLeaf() {
      this.getEntries();
      leafChanges.push(null);
      branch.splice(0);
    },
  };
  return { branch, options, leafChanges, host: mockOmp(options), ctx: extensionContext(branch, options) };
}

test("native new, resume and full fork switch identity without a synthetic session_start", async (t) => {
  const { branch, options, host, ctx, leafChanges } = mockNativeSession();
  let runtime;
  createOmpExtension({ onSessionReady(info) { runtime = info.runtime; } })(host.api);
  t.after(() => host.emit("session_shutdown", {}, ctx.context));
  await startSession(host, ctx);
  await admitUser(host, ctx, branch, "SESSION-A-ONLY");
  await runToolTurn(host, ctx, branch, "spine_open", { goal: "A-OWNER" });
  const savedA = structuredClone(branch);
  const sourceA = (await runtime.client.execute({ type: "source_snapshot" })).source;
  options.sessionId = "native-B";
  branch.splice(0);
  await host.emit("session_switch", { type: "session_switch", reason: "new",
    previousSessionFile: "/tmp/native-A.jsonl" }, ctx.context);
  unseen(await modelPrompt(host, ctx, branch), "A-OWNER");
  unseen(await modelPrompt(host, ctx, branch), "SESSION-A-ONLY");
  assert.equal((await runtime.client.execute({ type: "source_snapshot" })).source.cells.length, 0);
  await admitUser(host, ctx, branch, "SESSION-B-ONLY");
  const openedB = await runToolTurn(host, ctx, branch, "spine_open", { goal: "B-OWNER" });
  assert.equal(openedB.admission, undefined);
  options.sessionId = "native-A";
  branch.splice(0, branch.length, ...structuredClone(savedA));
  await host.emit("session_switch", { type: "session_switch", reason: "resume",
    previousSessionFile: "/tmp/native-B.jsonl" }, ctx.context);
  sees(await modelPrompt(host, ctx, branch), 'summary="A-OWNER"');
  unseen(await modelPrompt(host, ctx, branch), "SESSION-B-ONLY");
  assert.deepEqual((await runtime.client.execute({ type: "source_snapshot" })).source, sourceA);
  options.sessionId = "native-fork";
  await host.emit("session_switch", { type: "session_switch", reason: "fork",
    previousSessionFile: "/tmp/native-A.jsonl" }, ctx.context);
  sees(await modelPrompt(host, ctx, branch), 'summary="A-OWNER"');
  const forkSource = (await runtime.client.execute({ type: "source_snapshot" })).source;
  assert.equal(forkSource.thread, "native-fork");
  assert.deepEqual(forkSource.cells, sourceA.cells);
  const closed = await runToolTurn(host, ctx, branch, "spine_close", { memory: "fork memory" });
  assert.equal(closed.admission, undefined);
  assert.deepEqual(leafChanges, []);
  assert.deepEqual(faults(host), []);
});

for (const [eventType, reason] of [["session_tree", undefined], ["session_branch", "branch"], ["session_branch", "fork"]]) {
  test(`${eventType} ${reason ?? "rewind"} cuts an invisible delayed start but preserves the committed tree and journal`, async (t) => {
    const { branch, options, host, ctx, leafChanges } = mockNativeSession();
    createOmpExtension()(host.api);
    t.after(() => host.emit("session_shutdown", {}, ctx.context));
    await startSession(host, ctx);
    await admitUser(host, ctx, branch, "prior request");
    await runToolTurn(host, ctx, branch, "spine_open", { goal: "KEPT-OWNER" });
    const keptLeaf = branch.at(-1).id;
    const later = user("CUT-DRAFT-NOT-A-SOURCE");
    await host.emit("context", { type: "context", messages: [later] }, ctx.context);
    await host.emit("turn_start", { type: "turn_start" }, ctx.context);
    await host.emit("before_provider_request", { payload: {} }, ctx.context);
    const startLeaf = branch.at(-1).id;
    await host.emit("message_end", { message: later }, ctx.context);
    pushMessage(branch, later);
    const physicalJournal = options.sessionManager.getEntries();
    branch.pop();
    if (eventType === "session_branch") options.sessionId = "native-cut";
    await host.emit(eventType, { type: eventType, reason,
      oldLeafId: physicalJournal.at(-1).id, newLeafId: startLeaf,
      previousSessionFile: "/tmp/native-A.jsonl" }, ctx.context);
    assert.deepEqual(leafChanges, [keptLeaf]);
    assert.ok(options.sessionManager.getEntries().some((entry) => entry.id === startLeaf));
    assert.ok(options.sessionManager.getEntries().some((entry) => entry.message === later));
    sees(await modelPrompt(host, ctx, branch), 'summary="KEPT-OWNER"');
    unseen(await modelPrompt(host, ctx, branch), "CUT-DRAFT-NOT-A-SOURCE");
    await admitUser(host, ctx, branch, "NEW-AFTER-CUT");
    const closed = await runToolTurn(host, ctx, branch, "spine_close", { memory: "cut recovery memory" });
    assert.equal(closed.admission, undefined);
    await host.emit("session_switch", { type: "session_switch", reason: "resume" }, ctx.context);
    sees(await modelPrompt(host, ctx, branch), "cut recovery memory");
    assert.deepEqual(faults(host), []);
  });
}

test("assistant display text never replaces queued raw durable Source bytes before commit or replay", async (t) => {
  const branch = [];
  const host = mockOmp({ branch });
  const ctx = extensionContext(branch);
  let runtime;
  createOmpExtension({ onSessionReady(info) { runtime = info.runtime; } })(host.api);
  t.after(() => host.emit("session_shutdown", {}, ctx.context));
  await startSession(host, ctx);
  await admitUser(host, ctx, branch, "raw source request");
  await host.emit("turn_start", { type: "turn_start" }, ctx.context);
  await host.emit("before_provider_request", { payload: {} }, ctx.context);
  const raw = { role: "assistant", content: [{ type: "text", text: "value=$$PLACEHOLDER$$" }],
    stopReason: "stop", timestamp: nextTs() };
  const display = { ...raw, content: [{ type: "text", text: "value=DISPLAY-SECRET" }] };
  // Native queues synchronous persistence before display emit, behind promise-tail hops.
  const persistence = Promise.resolve().then(() => {}).finally(() => {}).catch(() => {})
    .then(() => pushMessage(branch, raw));
  await host.emit("message_end", { type: "message_end", message: display }, ctx.context);
  await persistence;
  await host.emit("turn_end", { type: "turn_end", message: display, toolResults: [] }, ctx.context);
  const live = (await runtime.client.execute({ type: "source_snapshot" })).source;
  assert.deepEqual(live.cells.map((cell) => cell.item.Message.message.content),
    ["raw source request", "value=$$PLACEHOLDER$$"]);
  await host.emit("context", { type: "context", messages: [display] }, ctx.context);
  assert.deepEqual((await runtime.client.execute({ type: "source_snapshot" })).source, live);
  await host.emit("session_tree", { type: "session_tree" }, ctx.context);
  assert.deepEqual((await runtime.client.execute({ type: "source_snapshot" })).source, live);
  await admitUser(host, ctx, branch, "after raw replay");
  const opened = await runToolTurn(host, ctx, branch, "spine_open", { goal: "RAW-REPLAY-HEALTHY" });
  assert.equal(opened.admission, undefined);
  assert.deepEqual(faults(host), []);
});

for (const classification of ["refusal", "sensitive"]) {
  test(`nonempty native ${classification} stays outside Source through retry and restore`, async (t) => {
    const branch = [];
    const host = mockOmp({ branch });
    const ctx = extensionContext(branch);
    let runtime;
    createOmpExtension({ onSessionReady(info) { runtime = info.runtime; } })(host.api);
    t.after(() => host.emit("session_shutdown", {}, ctx.context));
    await startSession(host, ctx);
    const request = await admitUser(host, ctx, branch, "retryable request");
    await host.emit("turn_start", { type: "turn_start" }, ctx.context);
    await host.emit("before_provider_request", { payload: {} }, ctx.context);
    const refusal = { role: "assistant", content: [{ type: "text", text: "NONEMPTY-CLASSIFIER-REPLY" }],
      stopReason: "error", stopDetails: { type: classification }, timestamp: nextTs() };
    await host.emit("message_end", { message: refusal }, ctx.context);
    await host.emit("turn_end", { message: refusal, toolResults: [] }, ctx.context);
    await host.emit("context", { type: "context", messages: [request, refusal] }, ctx.context);
    assert.deepEqual((await runtime.client.execute({ type: "source_snapshot" })).source.cells
      .map((cell) => cell.item.Message.message.content), ["retryable request"]);
    const retried = await runToolTurn(host, ctx, branch, "spine_open", { goal: "RETRY-OWNER" });
    assert.equal(retried.admission, undefined);
    const live = (await runtime.client.execute({ type: "source_snapshot" })).source;
    await host.emit("session_tree", { type: "session_tree" }, ctx.context);
    assert.deepEqual((await runtime.client.execute({ type: "source_snapshot" })).source, live);
    sees(await modelPrompt(host, ctx, branch), 'summary="RETRY-OWNER"');
    const closed = await runToolTurn(host, ctx, branch, "spine_close", { memory: "retry recovered" });
    assert.equal(closed.admission, undefined);
    assert.deepEqual(faults(host), []);
  });
}

for (const staleFailure of [false, true]) {
  test(`paused old context ${staleFailure ? "failure" : "result"} cannot poison a native transition`, async (t) => {
    const { branch, host, ctx } = mockNativeSession();
    let runtime;
    createOmpExtension({ onSessionReady(info) { runtime = info.runtime; } })(host.api);
    t.after(() => host.emit("session_shutdown", {}, ctx.context));
    await startSession(host, ctx);
    await admitUser(host, ctx, branch, "OLD-CONTEXT-REQUEST");
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    t.after(() => release.resolve());
    const execute = runtime.client.execute.bind(runtime.client);
    let pause = true;
    runtime.client.execute = async (command) => {
      if (command.type === "observe_sources" && pause) {
        pause = false;
        const oldResult = staleFailure ? undefined : await execute(command);
        entered.resolve();
        await release.promise;
        if (staleFailure) throw new Error("old context failed after native transition");
        return oldResult;
      }
      return execute(command);
    };
    pushMessage(branch, user("OLD-LATE-DURABLE"));
    const oldContext = host.emit("context", { type: "context",
      messages: branch.flatMap((entry) => entry.message ? [entry.message] : []) }, ctx.context);
    await entered.promise;
    await host.emit("session_tree", { type: "session_tree" }, ctx.context);
    release.resolve();
    assert.deepEqual(await oldContext, {}, "obsolete handler must not replace native context");
    await admitUser(host, ctx, branch, "HEALTHY-NEW-CONTEXT");
    const opened = await runToolTurn(host, ctx, branch, "spine_open", { goal: "HEALTHY-NEW-NODE" });
    assert.equal(opened.admission, undefined);
    sees(await modelPrompt(host, ctx, branch), 'summary="HEALTHY-NEW-NODE"');
    assert.deepEqual(faults(host), []);
  });
}


for (const stopReason of ["error", "aborted"]) {
  test(`durably persisted ${stopReason} assistant remains a canonical Source`, async (t) => {
    const branch = [];
    const host = mockOmp({ branch });
    const ctx = extensionContext(branch);
    let runtime;
    createOmpExtension({ onSessionReady(info) { runtime = info.runtime; } })(host.api);
    t.after(() => host.emit("session_shutdown", {}, ctx.context));
    await startSession(host, ctx);
    await admitUser(host, ctx, branch, "persisted failure request");
    await host.emit("turn_start", { type: "turn_start" }, ctx.context);
    await host.emit("before_provider_request", { payload: {} }, ctx.context);
    const reply = { role: "assistant", content: [{ type: "text", text: "DURABLE-PARTIAL-REPLY" }],
      stopReason, timestamp: nextTs() };
    pushMessage(branch, reply);
    await host.emit("message_end", { message: reply }, ctx.context);
    await host.emit("turn_end", { message: reply, toolResults: [] }, ctx.context);
    const source = (await runtime.client.execute({ type: "source_snapshot" })).source;
    assert.deepEqual(source.cells.map((cell) => cell.item.Message.message.content),
      ["persisted failure request", "DURABLE-PARTIAL-REPLY"]);
    await host.emit("session_tree", { type: "session_tree" }, ctx.context);
    assert.deepEqual((await runtime.client.execute({ type: "source_snapshot" })).source, source);
    assert.deepEqual(faults(host), []);
  });
}

test("native root rewind resets the leaf without erasing the old pending journal", async (t) => {
  const { branch, options, host, ctx, leafChanges } = mockNativeSession();
  let runtime;
  createOmpExtension({ onSessionReady(info) { runtime = info.runtime; } })(host.api);
  t.after(() => host.emit("session_shutdown", {}, ctx.context));
  await startSession(host, ctx);
  const draft = user("OLD-ROOT-DRAFT");
  pushMessage(branch, draft);
  await host.emit("context", { type: "context", messages: [draft] }, ctx.context);
  await host.emit("turn_start", { type: "turn_start" }, ctx.context);
  await host.emit("before_provider_request", { payload: {} }, ctx.context);
  await host.emit("message_end", { message: draft }, ctx.context);
  const oldEntries = options.sessionManager.getEntries();
  options.sessionManager.resetLeaf();
  await host.emit("session_tree", { type: "session_tree",
    newLeafId: null, oldLeafId: oldEntries.at(-1).id }, ctx.context);
  assert.deepEqual(leafChanges, [null]);
  assert.deepEqual(branch, []);
  assert.deepEqual(options.sessionManager.getEntries(), oldEntries);
  await admitUser(host, ctx, branch, "NEW-ROOT-REQUEST");
  const opened = await runToolTurn(host, ctx, branch, "spine_open", { goal: "NEW-ROOT-NODE" });
  assert.equal(opened.admission, undefined);
  const source = (await runtime.client.execute({ type: "source_snapshot" })).source;
  assert.deepEqual(source.cells.map((cell) => cell.item.Message.message.content), ["NEW-ROOT-REQUEST", ""]);
  await host.emit("session_switch", { type: "session_switch", reason: "resume" }, ctx.context);
  assert.deepEqual((await runtime.client.execute({ type: "source_snapshot" })).source, source);
  assert.deepEqual(faults(host), []);
});

test("native queued child mount notice keeps its pre-user Source order through final reply and replay", async (t) => {
  const parentBranch = [];
  const parent = mockOmp({ branch: parentBranch });
  const parentCtx = extensionContext(parentBranch);
  createOmpExtension()(parent.api);
  t.after(() => parent.emit("session_shutdown", {}, parentCtx.context));
  await startSession(parent, parentCtx);
  await admitUser(parent, parentCtx, parentBranch, "parent constraint");
  await runToolTurn(parent, parentCtx, parentBranch, "spine_open", { goal: "QUEUED-NOTICE-OWNER" });
  const branch = structuredClone(parentBranch);
  const options = { branch, childFlag: true, sessionId: "queued-native-child" };
  const host = mockOmp(options);
  const ctx = extensionContext(branch, options);
  let runtime;
  createOmpExtension({ onSessionReady(info) { runtime = info.runtime; } })(host.api);
  t.after(() => host.emit("session_shutdown", {}, ctx.context));
  await startSession(host, ctx);
  const notice = { role: "custom", customType: "xdev-mount-notice",
    content: "NATIVE-QUEUED-MOUNT-NOTICE", display: false, attribution: "agent", timestamp: nextTs() };
  const assignment = user("CHILD-ASSIGNMENT-AFTER-NOTICE");
  // Native injects durable custom notices before the admitted user in context,
  // then emits/persists them in that same order when the main turn opens.
  await host.emit("context", { type: "context",
    messages: [...branch.flatMap((entry) => entry.message ? [entry.message] : []), notice, assignment] }, ctx.context);
  branch.push({ type: "custom_message", id: `notice-${nextTs()}`, parentId: branch.at(-1).id,
    customType: notice.customType, content: notice.content, display: notice.display,
    attribution: notice.attribution, timestamp: new Date(notice.timestamp).toISOString() });
  pushMessage(branch, assignment);
  await host.emit("message_end", { message: notice }, ctx.context);
  await host.emit("message_end", { message: assignment }, ctx.context);
  const reply = await runReplyTurn(host, ctx, branch, "QUEUED-NOTICE-REPLY");
  const source = (await runtime.client.execute({ type: "source_snapshot" })).source;
  assert.deepEqual(source.cells.slice(-3).map((cell) => cell.item.Message.message.content),
    [notice.content, assignment.content, reply.content[0].text]);
  assert.deepEqual(faults(host), []);
  await host.emit("session_shutdown", {}, ctx.context);
  const restored = mockOmp(options);
  const restoredCtx = extensionContext(branch, options);
  let restoredRuntime;
  createOmpExtension({ onSessionReady(info) { restoredRuntime = info.runtime; } })(restored.api);
  t.after(() => restored.emit("session_shutdown", {}, restoredCtx.context));
  await startSession(restored, restoredCtx);
  assert.deepEqual((await restoredRuntime.client.execute({ type: "source_snapshot" })).source, source);
  sees(await modelPrompt(restored, restoredCtx, branch), 'summary="QUEUED-NOTICE-OWNER"');
  assert.deepEqual(faults(restored), []);
});

test("user message_end before context drains queued native notice and user in exact durable Source order", async (t) => {
  const branch = [];
  const host = mockOmp({ branch });
  const ctx = extensionContext(branch);
  let runtime;
  createOmpExtension({ onSessionReady(info) { runtime = info.runtime; } })(host.api);
  t.after(() => host.emit("session_shutdown", {}, ctx.context));
  await startSession(host, ctx);
  const notice = { role: "custom", customType: "tool-roster-notice",
    content: "LATE-PERSISTED-NATIVE-NOTICE", display: false, attribution: "agent", timestamp: nextTs() };
  const request = user("USER-AFTER-LATE-NOTICE");
  // The native synchronous sinks are queued before extension delivery, but
  // neither entry is durable when the user message_end handler is entered.
  const persistence = Promise.resolve().then(() => {
    branch.push({ type: "custom_message", id: "queued-notice", parentId: null,
      customType: notice.customType, content: notice.content, display: notice.display,
      attribution: notice.attribution, timestamp: new Date(notice.timestamp).toISOString() });
  }).finally(() => {}).catch(() => {}).then(() => pushMessage(branch, request));
  assert.deepEqual(branch, []);
  await host.emit("message_end", { message: request }, ctx.context);
  await persistence;
  const admitted = (await runtime.client.execute({ type: "source_snapshot" })).source;
  assert.deepEqual(admitted.cells.map((cell) => cell.item.Message.message.content),
    [notice.content, request.content]);
  await host.emit("context", { type: "context", messages: [notice, request] }, ctx.context);
  assert.deepEqual((await runtime.client.execute({ type: "source_snapshot" })).source, admitted);
  const opened = await runToolTurn(host, ctx, branch, "spine_open", { goal: "ORDERED-NATIVE-NODE" });
  assert.equal(opened.admission, undefined);
  const live = (await runtime.client.execute({ type: "source_snapshot" })).source;
  assert.deepEqual(live.cells.map((cell) => cell.item.Message.message.content),
    [notice.content, request.content, ""]);
  await host.emit("session_tree", { type: "session_tree" }, ctx.context);
  assert.deepEqual((await runtime.client.execute({ type: "source_snapshot" })).source, live);
  sees(await modelPrompt(host, ctx, branch), 'summary="ORDERED-NATIVE-NODE"');
  assert.deepEqual(faults(host), []);
});

test("child sampling admission drains the pending primary assignment before its start archive", async (t) => {
  const branch = [];
  const host = mockOmp({ branch, childFlag: true });
  const ctx = extensionContext(branch);
  let runtime;
  createOmpExtension({ onSessionReady(info) { runtime = info.runtime; } })(host.api);
  t.after(() => host.emit("session_shutdown", {}, ctx.context));
  await startSession(host, ctx);
  await admitUser(host, ctx, branch, "inherited parent constraint");
  await modelPrompt(host, ctx, branch);
  await host.emit("turn_start", { type: "turn_start", turnIndex: 0 }, ctx.context);
  const assignment = user("DURABLE-PRIMARY-CHILD-ASSIGNMENT");
  const persisted = new Promise((resolve) => setImmediate(() => {
    pushMessage(branch, assignment);
    resolve();
  }));
  await host.emit("before_provider_request", {
    type: "before_provider_request", payload: { model: MOCK_MODEL_ID },
  }, ctx.context);
  await persisted;
  assert.equal(samplingRecords(host).at(-1).record.pre_boundary.ordinal, 1);
  await runReplyTurn(host, ctx, branch, "queued assignment complete");
  const source = (await runtime.client.execute({ type: "source_snapshot" })).source;
  assert.deepEqual(source.cells.slice(0, 2).map((cell) => cell.item.Message.message.content),
    ["inherited parent constraint", assignment.content]);
  await host.emit("session_switch", { type: "session_switch" }, ctx.context);
  assert.deepEqual((await runtime.client.execute({ type: "source_snapshot" })).source, source);
  assert.deepEqual(faults(host), []);
});

test("Spine can open a task without native Agent Hub observation", async (t) => {
  const branch = [];
  const host = mockOmp({ branch });
  const ctx = extensionContext(branch);
  delete host.api.pi.startExternalAgentObservation;
  delete host.api.pi.observeExternalAgentSession;
  createOmpExtension()(host.api);
  t.after(() => host.emit("session_shutdown", {}, ctx.context));
  await startSession(host, ctx);
  await admitUser(host, ctx, branch, "start a task");
  await runToolTurn(host, ctx, branch, "spine_open", { goal: "plugin-owned task" });
  assert.deepEqual(faults(host), []);
});
