import assert from "node:assert/strict";
import test from "node:test";
import { createNativeFixture, spineCall, visibleText, readJournal } from "./fixture.mjs";

const owner = "MODES-ACTIVE-OWNER";
const constraint = "MODES-CONSTRAINT: retain the customer's compatibility contract and unfinished owner";
const pressureChild = "MODES-MIDTURN-CHILD";
const freshOwner = "MODES-NEW-EPOCH-OWNER";
const nextOwner = "MODES-NEXT-OWNER";
const summaryMarker = "MODES-REAL-CONTINUATION-SUMMARY";
const summary = `${summaryMarker}. Active work: ${owner}; ${pressureChild}. User constraint: ${constraint}. Work remains unfinished.`;
const pressureText = "MODES-PRESSURE-ANSWER";
const incompleteText = "MODES-LENGTH-TRUNCATED";
const contextWindow = 131072;
const thresholdTokens = 98304;
const pressureTokens = thresholdTokens + 2048;
const bridge = new URL("./compaction-modes.bridge.mjs", import.meta.url);

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function completed(result) { assert.equal(result.status, "completed", JSON.stringify(result)); }
function notifications(rpc, text) {
  return rpc.event((frame) => frame.type === "extension_ui_request" && frame.method === "notify"
    && frame.message === text, text);
}
function assertOwner(messages, goal = owner) {
  const text = visibleText(messages);
  assert.ok(text.includes(`<spine_node`) && text.includes(`summary="${goal}"`), `Missing live owner ${goal}`);
}
function entriesOf(entries, type) { return entries.filter((entry) => entry.type === "custom" && entry.customType === type); }
function assertHealthy(entries) {
  assert.equal(entriesOf(entries, "spine.fault.v1").length, 0, "No hidden adapter lifecycle fault");
  const commits = entriesOf(entries, "spine.archive.v1").filter((entry) => entry.data.record.type === "sampling_commit");
  const ids = commits.map((entry) => JSON.stringify(entry.data.record.record.commit_id));
  assert.equal(new Set(ids).size, ids.length, "A sampling must never commit twice");
}
function settings(overrides = {}) {
  return {
    compaction: {
      enabled: true, thresholdPercent: 75, thresholdTokens: -1, modelThresholds: {},
      reserveTokens: 8192, keepRecentTokens: 128, methodOrder: ["soft"],
      autoContinue: false, asyncEnabled: false, midTurnEnabled: false,
      supersedeReads: false, dropUseless: false, ...overrides,
    },
    contextPromotion: { enabled: false },
    // Keep the goal alive only to exercise compaction.autoContinue. No independent
    // goal RPC continuation producer may account for a post-summary request.
    goal: { continuationModes: [] },
  };
}

async function assertOneCommittedCompact(rpc, state, fixture, expectedReason, expectedRetry) {
  const start = await rpc.event((frame) => frame.type === "auto_compaction_start", "automatic mode start");
  const end = await rpc.event((frame) => frame.type === "auto_compaction_end", "automatic mode end");
  assert.equal(start.reason, expectedReason);
  assert.equal(end.aborted, false, JSON.stringify(end));
  assert.equal(end.willRetry, expectedRetry);
  assert.equal(end.result?.summary, summary);
  assert.equal(rpc.frames.filter((frame) => frame.type === "auto_compaction_start").length, 1);
  assert.equal(rpc.frames.filter((frame) => frame.type === "auto_compaction_end").length, 1);
  const callback = rpc.frames.findIndex((frame) => typeof frame.message === "string" && frame.message.startsWith("MODES-SUMMARY-CALLBACK:"));
  const returned = rpc.frames.findIndex((frame) => frame.message === "MODES-SUMMARY-RETURNED:stop");
  assert.ok(callback >= 0 && returned > callback && rpc.frames.indexOf(end) > returned,
    "Actual summary callback must return before Native acknowledges completion");
  const entries = await readJournal(state.sessionFile);
  assertHealthy(entries);
  const barriers = entriesOf(entries, "spine.compact.v1");
  const native = entries.filter((entry) => entry.type === "compaction");
  assert.equal(barriers.length, 1);
  assert.equal(native.length, 1);
  const barrier = barriers[0].data.barrier;
  assert.equal(barrier.next_epoch, barrier.previous_epoch + 1);
  assert.equal(barriers[0].data.replacementMessages[0].summary, summary);
  assert.equal(native[0].summary, summary);
  assert.equal(native[0].firstKeptEntryId, end.result.firstKeptEntryId);
  assert.ok(entries.indexOf(native[0]) > entries.indexOf(barriers[0]), "Native ack must follow the durable Source barrier");
  const beforeBarrier = entries.slice(0, entries.indexOf(barriers[0]));
  const lastCommit = entriesOf(beforeBarrier, "spine.archive.v1")
    .filter((entry) => entry.data.record.type === "sampling_commit").at(-1);
  assert.ok(lastCommit, "Automatic producer must settle real sampling before its barrier");
  assert.equal(lastCommit.data.record.record.epoch, barrier.previous_epoch);
  assert.equal(fixture.requests.filter((request) => visibleText(request.messages.at(-1)).includes("Create a concise structured continuation summary")).length, 1);
  return barrier;
}

// Every successful mode also exercises real Native tool consumption in the new
// Source epoch, then physical process restart. No snapshot/state echo replaces it.
async function exerciseAfterCompact(fixture, rpc, state, stage, barrier) {
  stage.value = "fresh-open";
  completed(await rpc.prompt("Open fresh work after the actual automatic compact."));
  stage.value = "next";
  completed(await rpc.prompt("Finish that work and move to the next owner."));
  await rpc.close();
  const restored = await fixture.restart(state.sessionFile);
  assert.equal((await restored.command("get_state")).sessionId, state.sessionId);
  stage.value = "restored-close";
  completed(await restored.prompt("Close the physically resumed next owner."));
  const entries = await readJournal(state.sessionFile);
  assertHealthy(entries);
  assert.equal(entriesOf(entries, "spine.compact.v1").length, 1, "Restart must not double-commit the compact");
  assert.equal(entries.filter((entry) => entry.type === "compaction").length, 1);
  const newStarts = entries.slice(entries.findIndex((entry) => entry.customType === "spine.compact.v1") + 1)
    .filter((entry) => entry.customType === "spine.archive.v1" && entry.data.record.type === "sampling_started");
  assert.ok(newStarts.length >= 6);
  assert.ok(newStarts.every((entry) => entry.data.record.record.epoch === barrier.next_epoch));
  assert.equal(restored.frames.filter((frame) => frame.type === "auto_compaction_start").length, 0);
  await restored.close();
}

function respondLifecycle(request, send, stage) {
  const text = visibleText(request.messages);
  switch (stage.value) {
    case "seed-open":
      assert.ok(text.includes(constraint));
      stage.value = "seed-answer";
      send(spineCall("spine_open", { goal: owner }), { inputTokens: 500 });
      return true;
    case "seed-answer":
      assertOwner(request.messages);
      stage.value = "ready";
      send("MODES-OWNER-OPEN", { inputTokens: 500 });
      return true;
    case "fresh-open":
      assert.ok(text.includes(summaryMarker) && text.includes(owner) && text.includes(constraint));
      stage.value = "fresh-answer";
      send(spineCall("spine_open", { goal: freshOwner }), { inputTokens: 600 });
      return true;
    case "fresh-answer":
      assertOwner(request.messages, freshOwner);
      stage.value = "ready";
      send("MODES-FRESH-OPENED", { inputTokens: 600 });
      return true;
    case "next":
      assertOwner(request.messages, freshOwner);
      stage.value = "next-answer";
      send(spineCall("spine_next", { memory: "MODES-FRESH-MEMORY", goal: nextOwner }), { inputTokens: 650 });
      return true;
    case "next-answer":
      assertOwner(request.messages, nextOwner);
      stage.value = "ready";
      send("MODES-NEXT-OPENED", { inputTokens: 650 });
      return true;
    case "restored-close":
      assertOwner(request.messages, nextOwner);
      assert.ok(text.includes(summaryMarker) && text.includes(constraint));
      stage.value = "close-answer";
      send(spineCall("spine_close", { memory: "MODES-RESTORED-CLOSED" }), { inputTokens: 650 });
      return true;
    case "close-answer":
      assert.match(text, /RootEpoch/);
      assert.ok(text.includes("MODES-RESTORED-CLOSED"));
      stage.value = "done";
      send("MODES-RESUME-COMPLETE", { inputTokens: 650 });
      return true;
    default: return false;
  }
}

for (const mode of ["overflow", "incomplete", "idle", "asyncEnabled", "midTurnEnabled", "autoContinue"]) {
  test(`native ${mode}: actual automatic producer preserves owner, Source barrier and physical resume`, { timeout: 180_000 }, async (t) => {
    const stage = { value: "seed-open" };
    const autoContinued = deferred();
    const releaseContinuation = deferred();
    const override = mode === "idle" ? { idleEnabled: true, idleThresholdTokens: 1, idleTimeoutSeconds: 1 } :
      mode === "asyncEnabled" ? { asyncEnabled: true } :
        mode === "midTurnEnabled" ? { midTurnEnabled: true } :
          mode === "autoContinue" ? { autoContinue: true } : {};
    let summaryCount = 0;
    let resumedCount = 0;
    const fixture = await createNativeFixture(t, {
      label: `compaction-${mode}`, bridge, model: { contextWindow, maxTokens: 4096 }, settings: settings(override),
      async onRequest(request, { send }) {
        const text = visibleText(request.messages);
        if (respondLifecycle(request, send, stage)) return;
        if (visibleText(request.messages.at(-1)).includes("Create a concise structured continuation summary")) {
          assert.equal(++summaryCount, 1);
          assert.ok(text.includes(owner) && text.includes(constraint), "Summary must see the active owner and original constraint");
          if (mode === "midTurnEnabled") assert.ok(text.includes(pressureChild));
          if (["asyncEnabled", "autoContinue"].includes(mode)) assert.ok(text.includes(pressureText));
          stage.value = "post-summary";
          send(summary, { inputTokens: 800, outputTokens: 80 });
          return;
        }
        if (stage.value === "async-band") {
          assertOwner(request.messages);
          stage.value = "ready";
          // Native resolveSpeculationLeadTokens enters the pre-threshold band.
          // asyncEnabled cannot bypass the exclusive session_before_compact hook.
          send("MODES-ASYNC-PRETHRESHOLD", { inputTokens: thresholdTokens - 1024 });
          return;
        }
        if (stage.value === "pressure") {
          assertOwner(request.messages);
          if (mode === "overflow") {
            send("", { reasoningText: "MODES-OVERFLOW-THINKING", streamError: {
              message: "This model's maximum context length is 131072 tokens. Your messages exceed the context window.",
              type: "invalid_request_error", code: "context_length_exceeded",
            } });
          } else if (mode === "incomplete") {
            send(incompleteText, { finishReason: "length", inputTokens: pressureTokens, outputTokens: 4096 });
          } else if (mode === "midTurnEnabled") {
            send(spineCall("spine_open", { goal: pressureChild }), { inputTokens: pressureTokens });
          } else {
            send(pressureText, { inputTokens: pressureTokens });
          }
          stage.value = "await-summary";
          return;
        }
        if (stage.value === "post-summary") {
          assert.ok(text.includes(summaryMarker) && text.includes(owner) && text.includes(constraint));
          assert.equal(++resumedCount, 1, "Only one actual continuation may consume the compacted context");
          if (["overflow", "incomplete"].includes(mode)) {
            assert.ok(!text.includes(incompleteText), "Native retry must not replay its dropped truncated assistant");
            assert.ok(!text.includes("MODES-OVERFLOW-THINKING"));
          }
          if (mode === "midTurnEnabled") assert.ok(!text.includes("MODES-PRESSURE-ANSWER"));
          if (mode === "autoContinue") {
            autoContinued.resolve(request);
            await releaseContinuation.promise;
          }
          stage.value = "ready";
          send("MODES-AUTOMATIC-CONTINUATION-COMPLETE", { inputTokens: 600 });
          return;
        }
        assert.fail(`Unexpected ${mode} request in ${stage.value}: ${text}`);
      },
    });
    const hold = ["asyncEnabled", "autoContinue"].includes(mode);
    const rpc = await fixture.start({ autoCompaction: true, env: hold ? { OMP_MODE_HOLD_OBSERVER: mode === "asyncEnabled" ? "4" : "3" } : {} });
    const state = await rpc.command("get_state");
    assert.equal(state.autoCompactionEnabled, true);
    completed(await rpc.prompt(`${constraint}. Open the unfinished work owner.`));
    await notifications(rpc, "MODES-OBSERVER-SETTLED:2");
    if (mode === "asyncEnabled") {
      stage.value = "async-band";
      completed(await rpc.prompt("Report below-threshold progress without closing the owner."));
      await notifications(rpc, "MODES-OBSERVER-SETTLED:3");
      assert.equal(fixture.requests.length, 3, "Exclusive interception forbids speculative model calls despite asyncEnabled=true");
      assert.equal(rpc.frames.filter((frame) => frame.type === "auto_compaction_start").length, 0);
      const before = await readJournal(state.sessionFile);
      assert.equal(entriesOf(before, "spine.compact.v1").length, 0);
      assert.equal(before.filter((entry) => entry.type === "compaction").length, 0);
    }
    if (mode === "autoContinue") {
      // An active Native goal allows compaction's autoContinue after a terminal
      // answer. goal.continuationModes=[] removes the independent goal driver.
      const goal = await rpc.command("goal", { op: "create", objective: "Continue preserving the unfinished compatibility contract", token_budget: 2000000 });
      assert.equal(goal.goal.status, "active");
    }
    if (mode === "idle") {
      // RPC does not instantiate Interactive EventController's idle timer.
      // Use public idle maintenance, explicitly NOT a usage threshold or compact RPC.
      assert.equal(fixture.requests.length, 2);
      completed(await rpc.prompt("/modes-idle-maintenance"));
      await notifications(rpc, "MODES-IDLE-API:AgentSession.runIdleCompaction");
      await notifications(rpc, "MODES-IDLE-SETTLED");
    } else {
      stage.value = "pressure";
      const pressure = rpc.prompt("Record progress while retaining unfinished work and all constraints.");
      pressure.catch(() => {});
      if (hold) {
        await notifications(rpc, "MODES-OBSERVER-HELD");
        await rpc.event((frame) => frame.type === "auto_compaction_start", "native automatic start before observer release");
        assert.equal(summaryCount, 0, "Maintenance must not summarize before the post-commit observer settles");
        completed(await rpc.prompt("/modes-release-observer"));
      }
      if (mode === "autoContinue") {
        await autoContinued.promise;
        await rpc.command("goal", { op: "pause" });
        releaseContinuation.resolve();
      }
      completed(await pressure);
    }
    const barrier = await assertOneCommittedCompact(rpc, state, fixture,
      ["overflow", "incomplete", "idle"].includes(mode) ? mode : "threshold", ["overflow", "incomplete"].includes(mode));
    assert.equal(summaryCount, 1);
    assert.equal(resumedCount, ["overflow", "incomplete", "midTurnEnabled", "autoContinue"].includes(mode) ? 1 : 0);
    if (hold) {
      const settledText = `MODES-OBSERVER-SETTLED:${mode === "asyncEnabled" ? 4 : 3}`;
      const settledIndex = rpc.frames.findIndex((frame) => frame.message === settledText);
      const callbackIndex = rpc.frames.findIndex((frame) => typeof frame.message === "string" && frame.message.startsWith("MODES-SUMMARY-CALLBACK:"));
      assert.ok(settledIndex >= 0 && callbackIndex > settledIndex);
    }
    await exerciseAfterCompact(fixture, rpc, state, stage, barrier);
  });
}

for (const mode of ["midTurnEnabled", "asyncEnabled", "incomplete"]) {
  test(`native ${mode}: aborting the real automatic summary rolls back without a barrier or double commit`, { timeout: 180_000 }, async (t) => {
    const stage = { value: "seed-open" };
    const summaryRequested = deferred();
    const releaseSummary = deferred();
    const fixture = await createNativeFixture(t, {
      label: `compaction-${mode}-cancel`, bridge, model: { contextWindow, maxTokens: 4096 },
      settings: settings({ midTurnEnabled: mode === "midTurnEnabled", asyncEnabled: mode === "asyncEnabled" }),
      async onRequest(request, { send, incoming, response }) {
        if (respondLifecycle(request, send, stage)) return;
        const text = visibleText(request.messages);
        if (visibleText(request.messages.at(-1)).includes("Create a concise structured continuation summary")) {
          assert.ok(text.includes(owner) && text.includes(constraint));
          // Hold the real HTTP response. Native abort propagates to completeSimple's
          // actual AbortSignal; the provider never supplies a fabricated aborted result.
          summaryRequested.resolve();
          await releaseSummary.promise;
          if (!response.destroyed && !incoming.destroyed) send(summary);
          return;
        }
        if (stage.value === "pressure") {
          assertOwner(request.messages);
          stage.value = "await-summary";
          send(mode === "midTurnEnabled" ? spineCall("spine_open", { goal: pressureChild }) :
            mode === "incomplete" ? incompleteText : pressureText,
          { inputTokens: pressureTokens, ...(mode === "incomplete" ? { finishReason: "length", outputTokens: 4096 } : {}) });
          return;
        }
        if (stage.value === "cancel-recovery") {
          assertOwner(request.messages, mode === "midTurnEnabled" ? pressureChild : owner);
          assert.ok(text.includes(constraint));
          assert.ok(!text.includes(summaryMarker), "Cancelled summary must not leak into Native context");
          if (mode === "incomplete") {
            assert.equal(text.split(incompleteText).length - 1, 1,
              "Native recovery rollback must restore the truncated assistant exactly once");
          }
          stage.value = "cancel-next-answer";
          send(spineCall("spine_next", { memory: "MODES-CANCEL-OWNER-PRESERVED", goal: nextOwner }), { inputTokens: 600 });
          return;
        }
        if (stage.value === "cancel-next-answer") {
          assertOwner(request.messages, nextOwner);
          stage.value = "ready";
          send("MODES-CANCEL-NEXT-COMPLETE", { inputTokens: 600 });
          return;
        }
        if (stage.value === "cancel-restored-close") {
          assertOwner(request.messages, nextOwner);
          assert.ok(text.includes(constraint) && !text.includes(summaryMarker));
          stage.value = "cancel-close-answer";
          send(spineCall("spine_close", { memory: "MODES-CANCEL-RESTORED-CLOSED" }), { inputTokens: 600 });
          return;
        }
        if (stage.value === "cancel-close-answer") {
          assert.ok(text.includes("MODES-CANCEL-RESTORED-CLOSED"));
          stage.value = "done";
          send("MODES-CANCEL-RESUME-COMPLETE", { inputTokens: 600 });
          return;
        }
        assert.fail(`Unexpected cancelled-mode request ${stage.value}: ${text}`);
      },
    });
    t.after(() => releaseSummary.resolve());
    const rpc = await fixture.start({ autoCompaction: true });
    const state = await rpc.command("get_state");
    completed(await rpc.prompt(`${constraint}. Open unfinished work.`));
    await notifications(rpc, "MODES-OBSERVER-SETTLED:2");
    const before = await readJournal(state.sessionFile);
    const epoch = entriesOf(before, "spine.source.v1").at(-1).data.epoch;
    stage.value = "pressure";
    const pressure = rpc.prompt("Continue unfinished work until automatic maintenance begins.");
    pressure.catch(() => {});
    await summaryRequested.promise;
    await notifications(rpc, "MODES-SUMMARY-CALLBACK:3");
    await rpc.command("abort");
    await notifications(rpc, "MODES-SUMMARY-ABORTED");
    releaseSummary.resolve();
    const result = await pressure;
    assert.ok(["completed", "aborted"].includes(result.status), JSON.stringify(result));
    const end = await rpc.event((frame) => frame.type === "auto_compaction_end", "cancelled automatic summary end");
    assert.equal(end.aborted, true);
    assert.equal(end.result, undefined);
    assert.equal(end.willRetry, false);
    assert.equal(rpc.frames.filter((frame) => frame.type === "auto_compaction_start").length, 1);
    const cancelled = await readJournal(state.sessionFile);
    assertHealthy(cancelled);
    assert.equal(entriesOf(cancelled, "spine.compact.v1").length, 0);
    assert.equal(cancelled.filter((entry) => entry.type === "compaction").length, 0);
    assert.equal(entriesOf(cancelled, "spine.source.v1").at(-1).data.epoch, epoch);
    await rpc.command("set_auto_compaction", { enabled: false });
    stage.value = "cancel-recovery";
    completed(await rpc.prompt("Move the preserved owner to the next work item."));
    await rpc.close();
    const restored = await fixture.restart(state.sessionFile);
    stage.value = "cancel-restored-close";
    completed(await restored.prompt("Close the next owner after physical restart."));
    const final = await readJournal(state.sessionFile);
    assertHealthy(final);
    assert.equal(entriesOf(final, "spine.compact.v1").length, 0);
    assert.equal(final.filter((entry) => entry.type === "compaction").length, 0);
    assert.ok(entriesOf(final, "spine.source.v1").every((entry) => entry.data.epoch === epoch));
    await restored.close();
  });
}
