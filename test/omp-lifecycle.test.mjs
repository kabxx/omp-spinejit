import assert from "node:assert/strict";
import test from "node:test";

import { createNodeSpineRuntime } from "@spinejit/spine-sdk/node";

import {
  OmpSamplingLifecycle,
  createOmpSpineAdapter,
  materializeOmpContext,
  OmpSpineToolLimitError,
  OmpSourceBindings,
} from "../dist/omp/index.js";
import { ompArrivalMessage } from "../dist/omp/messages.js";

const SOURCE = {
  schema: "spine.source.snapshot.v1",
  thread: "session",
  epoch: 0,
  cells: [],
};

function harness(lifecycleOptions = {}) {
  const log = [];
  const adapter = {
    fault: null,
    async observeSources(characters) {
      log.push(["observe", characters]);
      return characters.map((character) => ({
        thread: "session",
        epoch: 0,
        ordinal: character.boundary,
      }));
    },
    async previewAndPublish() { log.push(["preview"]); },
    async beginSampling(digest) { log.push(["begin", digest]); },
    async registerExecution(key) { log.push(["register", key]); },
    async stageExecution(key, executionRef, operation) {
      log.push(["stage", key, executionRef, operation]);
    },
    async finishExecution(key, succeeded) { log.push(["finish-execution", key, succeeded]); },
    async finishSampling(terminal, inputTokens) {
      log.push(["finish-sampling", terminal, inputTokens]);
      return { type: "orphaned" };
    },
  };
  const bindings = new OmpSourceBindings();
  return { log, bindings, lifecycle: new OmpSamplingLifecycle(adapter, bindings, SOURCE, lifecycleOptions) };
}

test("omp lifecycle does not start sampling before any source is admitted", async () => {
  const { log, lifecycle } = harness();
  await lifecycle.ensureSampling({ n: 0 });
  assert.deepEqual(log, []);
  await lifecycle.observeMessage({ role: "user", content: "request", timestamp: 1 });
  await lifecycle.ensureSampling({ n: 1 });
  assert.deepEqual(log.map(([kind]) => kind), ["observe", "begin"]);
});

test("omp lifecycle treats a second beginSampling as identity", async () => {
  const { log, lifecycle } = harness();
  await lifecycle.observeMessage({ role: "user", content: "request", timestamp: 1 });
  await lifecycle.previewContext();
  await lifecycle.beginSampling({ n: 1 });
  await lifecycle.ensureSampling({ n: 2 });
  await lifecycle.finishTurn({
    aborted: false,
    message: { role: "assistant", content: [], stopReason: "stop", timestamp: 2 },
  });
  assert.deepEqual(log.map(([kind]) => kind), ["observe", "preview", "begin", "finish-sampling"]);
});

test("omp lifecycle admits developer and fileMention sources", async () => {
  const { bindings, lifecycle } = harness();
  await lifecycle.observeMessage({ role: "developer", content: "note", timestamp: 1 });
  await lifecycle.observeMessage({ role: "fileMention", timestamp: 2 });
  assert.equal(bindings.resolve({ thread: "session", epoch: 0, ordinal: 0 }).role, "developer");
  assert.equal(bindings.resolve({ thread: "session", epoch: 0, ordinal: 1 }).role, "fileMention");
});

test("omp lifecycle serializes overlapping persisted tails", async () => {
  const { lifecycle, bindings } = harness();
  const user = { role: "user", content: "hello", timestamp: 1 };
  const assistant = { role: "assistant", content: [], timestamp: 2 };
  await Promise.all([
    lifecycle.observePersistedSources([{ boundary: 0, message: user }]),
    lifecycle.observePersistedSources([
      { boundary: 0, message: user },
      { boundary: 1, message: assistant },
    ]),
  ]);
  assert.deepEqual([0, 1].map((ordinal) =>
    bindings.resolve({ thread: "session", epoch: 0, ordinal })), [user, assistant]);
});

test("omp lifecycle registers spine_spawn after xdev decode, not write", async () => {
  const { log, lifecycle } = harness();
  await lifecycle.observeMessage({ role: "user", content: "spawn", timestamp: 1 });
  await lifecycle.ensureSampling();
  const registered = await lifecycle.registerToolCall("call-1", "spine_spawn", {
    tasks: [{ summary: "a", prompt: "p" }, { summary: "b", prompt: "q" }],
  });
  assert.equal(registered, true);
  assert.equal(await lifecycle.registerToolCall("call-write", "write", { path: "xd://spine_spawn" }), false);
  assert.deepEqual(log.map(([kind]) => kind), ["observe", "begin", "register", "stage"]);
  assert.deepEqual(log.at(-1), ["stage", "call-1", "call-1", {
    type: "spawn", tasks: [{ summary: "a", prompt: "p" }, { summary: "b", prompt: "q" }],
  }]);
});

test("omp lifecycle treats a second register of the same toolCallId as identity", async () => {
  const { log, lifecycle } = harness();
  await lifecycle.observeMessage({ role: "user", content: "open", timestamp: 1 });
  await lifecycle.ensureSampling();
  assert.equal(await lifecycle.registerToolCall("call-1", "spine_open", { goal: "child" }), true);
  assert.equal(await lifecycle.registerToolCall("call-1", "spine_open", { goal: "child" }), true);
  assert.equal(log.filter(([kind]) => kind === "register").length, 1);
});


async function runtimeHarness(thread) {
  const runtime = createNodeSpineRuntime({ thread, features: ["jit", "spawn"] });
  const bindings = new OmpSourceBindings();
  const adapter = await createOmpSpineAdapter({
    enabled: true,
    runtime: runtime.client,
    host: {
      async claimOwnership() {},
      async appendCustomEntry() {},
      async materializeContext(context) { return materializeOmpContext(context, bindings); },
      async replaceContext() {},
    },
  });
  const source = await adapter.sourceSnapshot();
  return { runtime, adapter, bindings, lifecycle: new OmpSamplingLifecycle(adapter, bindings, source) };
}

for (const recovered of [false, true]) {
  for (const changed of [
    { role: "assistant", content: [], timestamp: 1, stopReason: "stop" },
    { role: "user", content: "request", timestamp: 2 },
  ]) {
    test(`occupied boundary rejects a different ${changed.role} identity after recovery=${recovered}`, async () => {
      const { runtime, adapter, bindings, lifecycle } = await runtimeHarness(`boundary-identity-${recovered}-${changed.role}`);
      try {
        await lifecycle.observePersistedSources([{ boundary: 0, message: { role: "user", content: "request", timestamp: 1 } }]);
        const before = await adapter.sourceSnapshot();
        const subject = recovered ? new OmpSamplingLifecycle(adapter, bindings, before) : lifecycle;
        await assert.rejects(subject.observePersistedSources([{ boundary: 0, message: changed }]),
          (error) => error === subject.fault);
        assert.deepEqual(await adapter.sourceSnapshot(), before);
        await assert.rejects(subject.ensureSampling());
      } finally {
        runtime.dispose();
      }
    });
  }
}

function assistant(timestamp, id, name, args) {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: args }],
    stopReason: "toolUse",
    timestamp,
  };
}

test("one successful control survives provider retries and rejects a second control without faulting", async () => {
  const { runtime, lifecycle } = await runtimeHarness("control-admission");
  try {
    await lifecycle.observeMessage({ role: "user", content: "first request", timestamp: 1 });
    await lifecycle.ensureSampling();
    await lifecycle.ensureSampling({ retry: true });
    const open = assistant(2, "open", "spine_open", { goal: "first task" });
    await lifecycle.observeMessage(open);
    const pending = lifecycle.registerToolCall("open", "spine_open", { goal: "first task" });
    await assert.rejects(
      lifecycle.registerToolCall("next", "spine_next", { memory: "done", goal: "second task" }),
      OmpSpineToolLimitError,
    );
    await pending;
    assert.equal(await lifecycle.registerToolCall("open", "spine_open", { goal: "first task" }), true);
    await lifecycle.finishToolCall("open", true);
    await lifecycle.ensureSampling({ retry: "after tool result" });
    await assert.rejects(
      lifecycle.registerToolCall("close", "spine_close", { memory: "done" }),
      OmpSpineToolLimitError,
    );
    assert.equal(lifecycle.fault, null);
    const first = await lifecycle.finishTurn({ message: open, aborted: false });
    assert.equal(first.type, "committed");
    assert.deepEqual(first.projection.cursor, [1, 1]);
    assert.equal(first.record.record.executions.length, 1);

    await lifecycle.observeMessage({ role: "user", content: "next request", timestamp: 3 });
    await lifecycle.ensureSampling();
    const next = assistant(4, "next-turn", "spine_next", { memory: "first done", goal: "second task" });
    await lifecycle.observeMessage(next);
    await lifecycle.registerToolCall("next-turn", "spine_next", { memory: "first done", goal: "second task" });
    await lifecycle.finishToolCall("next-turn", true);
    const second = await lifecycle.finishTurn({ message: next, aborted: false });
    assert.equal(second.type, "committed");
    assert.deepEqual(second.projection.cursor, [1, 2]);
    assert.equal(lifecycle.fault, null);
  } finally {
    runtime.dispose();
  }
});

test("a failed control keeps the single staging slot until the next sampling", async () => {
  const { runtime, lifecycle } = await runtimeHarness("failed-control-retry");
  try {
    await lifecycle.observeMessage({ role: "user", content: "try again", timestamp: 1 });
    await lifecycle.ensureSampling();
    const failed = assistant(2, "failed", "spine_open", { goal: "discarded" });
    await lifecycle.observeMessage(failed);
    await lifecycle.registerToolCall("failed", "spine_open", { goal: "discarded" });
    await lifecycle.finishToolCall("failed", false);
    await assert.rejects(
      lifecycle.registerToolCall("duplicate", "spine_open", { goal: "not admitted" }),
      OmpSpineToolLimitError,
    );
    const discarded = await lifecycle.finishTurn({ message: failed, aborted: false });
    assert.deepEqual(discarded.record.record.executions, []);
    await lifecycle.observeMessage({ role: "user", content: "next turn", timestamp: 3 });
    await lifecycle.ensureSampling();
    const retried = assistant(4, "retried", "spine_open", { goal: "retained" });
    await lifecycle.observeMessage(retried);
    await lifecycle.registerToolCall("retried", "spine_open", { goal: "retained" });
    await lifecycle.finishToolCall("retried", true);
    const committed = await lifecycle.finishTurn({ message: retried, aborted: false });
    assert.equal(committed.type, "committed");
    assert.deepEqual(committed.projection.cursor, [1, 1]);
    assert.deepEqual(committed.projection.nodes.map((node) => node.summary), ["root", "retained"]);
    assert.equal(committed.record.record.executions.length, 1);
    assert.equal(lifecycle.fault, null);
  } finally {
    runtime.dispose();
  }
});

test("a staged Spawn excludes both a second Spawn and a control in that sampling", async () => {
  const { runtime, lifecycle } = await runtimeHarness("failed-spawn-control-recovery");
  try {
    await lifecycle.observeMessage({ role: "user", content: "recover from spawn failure", timestamp: 1 });
    await lifecycle.ensureSampling();
    const tasks = [{ summary: "left", prompt: "left work" }, { summary: "right", prompt: "right work" }];
    await lifecycle.observeMessage(assistant(2, "spawn", "spine_spawn", { tasks }));
    await lifecycle.registerToolCall("spawn", "spine_spawn", { tasks });
    await assert.rejects(lifecycle.registerToolCall("other-spawn", "spine_spawn", { tasks }), OmpSpineToolLimitError);
    await assert.rejects(lifecycle.registerToolCall("open", "spine_open", { goal: "not admitted" }), OmpSpineToolLimitError);
    await lifecycle.finishToolCall("spawn", false);
    const committed = await lifecycle.finishTurn({ message: assistant(2, "spawn", "spine_spawn", { tasks }), aborted: false });
    assert.equal(committed.type, "committed");
    assert.deepEqual(committed.projection.cursor, [1]);
    assert.deepEqual(committed.record.record.executions, []);
    assert.equal(lifecycle.fault, null);
  } finally {
    runtime.dispose();
  }
});

test("message_end does not duplicate a user already admitted from an in-flight context", async () => {
  const { runtime, lifecycle } = await runtimeHarness("context-message-mirror");
  try {
    const request = { role: "user", content: "same request", timestamp: 1 };
    await lifecycle.observePersistedSources([{ boundary: 0, message: request }]);
    await lifecycle.observeMessage({ ...request, attribution: "user" });
    let source = await lifecycle.sourceSnapshot();
    assert.deepEqual(source.cells.map((cell) => cell.boundary), [0]);
    await lifecycle.observeMessage({ ...request, timestamp: 2 });
    source = await lifecycle.sourceSnapshot();
    assert.deepEqual(source.cells.map((cell) => cell.boundary), [0, 1]);
    assert.equal(lifecycle.fault, null);
  } finally {
    runtime.dispose();
  }
});

test("detached message events and persisted context cannot race source admission", async () => {
  for (const contextFirst of [false, true]) {
    const { runtime, lifecycle } = await runtimeHarness(`source-race-${contextFirst}`);
    try {
      const request = { role: "user", content: "admit once", timestamp: 1 };
      const context = () => lifecycle.observePersistedSources([{ boundary: 0, message: request }]);
      const event = () => lifecycle.observeMessage(request);
      await Promise.all(contextFirst ? [context(), event()] : [event(), context()]);
      const source = await lifecycle.sourceSnapshot();
      assert.deepEqual(source.cells.map((cell) => cell.boundary), [0]);
      assert.equal(lifecycle.fault, null);
    } finally {
      runtime.dispose();
    }
  }
});

for (const first of ["turn", "result"]) {
  test(`cancelled sampling and late tool receipt settle once when ${first} starts first`, async () => {
    const { runtime, adapter, lifecycle } = await runtimeHarness(`cancel-settlement-${first}`);
    const marked = Promise.withResolvers();
    const release = Promise.withResolvers();
    const originalFinish = adapter.finishExecution.bind(adapter);
    adapter.finishExecution = async (key, succeeded) => {
      await originalFinish(key, succeeded);
      if (key === "pending-spawn") {
        marked.resolve();
        await release.promise;
      }
    };
    try {
      await lifecycle.observeMessage({ role: "user", content: "cancel while recovery waits", timestamp: 1 });
      await lifecycle.ensureSampling();
      const pending = assistant(2, "pending-spawn", "spine_spawn", {
        tasks: [{ summary: "one", prompt: "one" }, { summary: "two", prompt: "two" }],
      });
      await lifecycle.observeMessage(pending);
      await lifecycle.registerToolCall("pending-spawn", "spine_spawn", pending.content[0].arguments);
      const turn = () => lifecycle.finishTurn({
        message: { ...pending, stopReason: "aborted" }, aborted: true,
      });
      const result = () => lifecycle.finishToolCall("pending-spawn", false);
      const firstSettlement = first === "turn" ? turn() : result();
      await marked.promise;
      const secondSettlement = first === "turn" ? result() : turn();
      release.resolve();
      const values = await Promise.all([firstSettlement, secondSettlement]);
      assert.equal(values[first === "turn" ? 1 : 0], first === "result");
      assert.equal(values[first === "turn" ? 0 : 1].type, "committed");
      assert.equal(lifecycle.fault, null);
      await lifecycle.observeMessage({ role: "user", content: "continue after cancellation", timestamp: 3 });
      await lifecycle.ensureSampling();
      const opened = assistant(4, "new-open", "spine_open", { goal: "fresh work" });
      await lifecycle.observeMessage(opened);
      await lifecycle.registerToolCall("new-open", "spine_open", { goal: "fresh work" });
      assert.equal(await lifecycle.finishToolCall("pending-spawn", false), false);
      await lifecycle.finishToolCall("new-open", true);
      const committed = await lifecycle.finishTurn({ message: opened, aborted: false });
      assert.deepEqual(committed.projection.cursor, [1, 1]);
      assert.deepEqual(committed.record.record.executions.map((item) => item.origin.execution_ref), ["new-open"]);
      assert.equal(lifecycle.fault, null);
    } finally {
      release.resolve();
      runtime.dispose();
    }
  });
}

test("responseCalls counts all calls in the current assistant response and resets on begin", async () => {
  const { lifecycle } = harness();
  await lifecycle.observeMessage({ role: "user", content: "close", timestamp: 1 });
  await lifecycle.ensureSampling();
  const message = assistant(2, "close", "spine_close", { memory: "done" });
  message.content.push({ type: "toolCall", id: "read", name: "read", arguments: { path: "x" } });
  await lifecycle.observePersistedSources([{ boundary: 1, message, entryId: "assistant-entry" }]);
  assert.equal(lifecycle.responseCalls, 2);
  await lifecycle.ensureSampling({ retry: true });
  assert.equal(lifecycle.responseCalls, 2);
  await lifecycle.finishTurn({ message, aborted: false });
  await lifecycle.ensureSampling();
  assert.equal(lifecycle.responseCalls, 0);
});

test("durable Spawn arrives once with its entry ID and active producer", async () => {
  const { bindings, lifecycle, log } = harness();
  const arrival = { producer: [1, 2], outcome: "completed", memory: "child result" };
  const message = ompArrivalMessage(arrival, 1);
  const source = [{ boundary: 0, message, entryId: "arrival-entry" }];
  await lifecycle.observePersistedSources(source);
  await lifecycle.observePersistedSources(source);
  assert.deepEqual(log, [["observe", [{ type: "arrival", boundary: 0, arrival }]]]);
  assert.equal(bindings.entryId({ thread: "session", epoch: 0, ordinal: 0 }), "arrival-entry");
  assert.deepEqual([...lifecycle.enteredArrivals], ["1.2"]);
  await assert.rejects(
    lifecycle.observePersistedSources([{ boundary: 0, message, entryId: "different-entry" }]),
    (error) => error === lifecycle.fault,
  );
});
