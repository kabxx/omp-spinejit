import assert from "node:assert/strict";
import test from "node:test";
import { createNativeFixture, spineCall, visibleText, readJournal } from "./fixture.mjs";

const owner = "AUTO-COMPACT-ACTIVE-OWNER";
const constraint = "AUTO-COMPACT-CONSTRAINT: preserve the customer's compatibility contract";
const nextOwner = "AUTO-COMPACT-NEXT-OWNER";
const summaryMarker = "AUTO-COMPACT-CONTINUATION-SUMMARY";
const summary = `${summaryMarker}. Active work: ${owner}. User constraint: ${constraint}. Continue the unfinished work.`;
const pressureAnswer = "AUTO-COMPACT-PRESSURE-ANSWER";
const contextWindow = 131072;
const thresholdPercent = 75;
const thresholdTokens = Math.floor(contextWindow * thresholdPercent / 100);
const reserveTokens = 8192;
const keepRecentTokens = 128;
const reportedInputTokens = thresholdTokens + 2048;
const reportedOutputTokens = 20;

function assertCompleted(result) {
  assert.equal(result.status, "completed", JSON.stringify(result));
}

function assertOwnerVisible(messages, goal) {
  const text = visibleText(messages);
  assert.ok(text.includes(goal), `Missing owner ${goal} in provider context`);
  assert.ok(text.includes(`<spine_node`) && text.includes(`summary="${goal}"`),
    `Owner ${goal} must be present as a published Spine node, not just historical tool arguments`);
}

function compactEntries(entries) {
  return entries.filter((entry) => entry.type === "custom" && entry.customType === "spine.compact.v1");
}

function assertHealthy(entries) {
  assert.equal(entries.filter((entry) => entry.type === "custom" && entry.customType === "spine.fault.v1").length, 0);
}

test("native threshold auto-compaction summarizes the active Spine owner and constraints, then survives physical restart", async (t) => {
  // OMP context-settings.ts registers these fields; compaction-threshold.ts applies
  // model overrides, so clear that map and choose an explicit percentage here.
  // pi-agent-core resolveThresholdTokens uses this percentage instead of reserve
  // inference; session-maintenance checkCompaction uses actual provider usage.
  const fixture = await createNativeFixture(t, {
    label: "auto-compaction",
    bridge: new URL("./auto-compaction.bridge.mjs", import.meta.url),
    model: { contextWindow, maxTokens: 4096 },
    settings: {
      compaction: {
        enabled: true,
        thresholdPercent,
        thresholdTokens: -1,
        modelThresholds: {},
        reserveTokens,
        keepRecentTokens,
        methodOrder: ["soft"],
        autoContinue: false,
        asyncEnabled: false,
        midTurnEnabled: false,
        supersedeReads: false,
        dropUseless: false,
      },
      contextPromotion: { enabled: false },
    },
    onRequest(request, { send, index }) {
      const text = visibleText(request.messages);
      switch (index) {
        case 1:
          assert.ok(text.includes(constraint));
          send(spineCall("spine_open", { goal: owner }), { inputTokens: 500 });
          break;
        case 2:
          assertOwnerVisible(request.messages, owner);
          assert.ok(text.includes(constraint));
          send("AUTO-COMPACT-OWNER-OPEN", { inputTokens: 500 });
          break;
        case 3:
          assertOwnerVisible(request.messages, owner);
          assert.ok(text.includes(constraint));
          // Real HTTP/SSE usage, not a fabricated transcript or maintenance call.
          send(pressureAnswer, { inputTokens: reportedInputTokens, outputTokens: reportedOutputTokens });
          break;
        case 4:
          assertOwnerVisible(request.messages, owner);
          assert.ok(text.includes(constraint), "Summarizer must see the original user constraint");
          assert.ok(text.includes(pressureAnswer), "Summarizer must see the threshold-crossing response");
          assert.match(visibleText(request.messages.at(-1)), /summary/i);
          const outputBudget = request.max_completion_tokens ?? request.max_tokens;
          assert.ok(outputBudget > 0 && outputBudget <= 4096);
          send(summary, { inputTokens: 800, outputTokens: 80 });
          break;
        case 5:
          assert.ok(text.includes(summaryMarker), "First post-compaction provider context must contain the actual summary");
          assert.ok(text.includes(owner));
          assert.ok(text.includes(constraint));
          send(spineCall("spine_open", { goal: nextOwner }), { inputTokens: 600 });
          break;
        case 6:
          assertOwnerVisible(request.messages, nextOwner);
          send("AUTO-COMPACT-NEW-EPOCH-OPEN", { inputTokens: 600 });
          break;
        case 7:
          assertOwnerVisible(request.messages, nextOwner);
          assert.ok(text.includes(summaryMarker), "Physical restart must replay the compacted summary");
          assert.ok(text.includes(constraint));
          send(spineCall("spine_close", { memory: "AUTO-COMPACT-RESTORED-OWNER-CLOSED" }), { inputTokens: 650 });
          break;
        case 8:
          assert.match(text, /RootEpoch/);
          assert.ok(text.includes("AUTO-COMPACT-RESTORED-OWNER-CLOSED"));
          send("AUTO-COMPACT-RESTART-COMPLETE", { inputTokens: 650 });
          break;
        default:
          assert.fail(`Unexpected provider request ${index}: ${text}`);
      }
    },
  });

  const rpc = await fixture.start({ autoCompaction: true });
  const initialState = await rpc.command("get_state");
  assert.equal(initialState.autoCompactionEnabled, true);
  assert.equal(initialState.model.contextWindow, contextWindow);
  assert.equal(initialState.model.maxTokens, 4096);
  assertCompleted(await rpc.prompt(`${constraint}. Open the active work owner.`));
  assert.equal(fixture.requests.length, 2);
  assert.equal(rpc.frames.filter((frame) => frame.type === "auto_compaction_start").length, 0,
    "Below-threshold provider usage must not compact");

  const pressure = rpc.prompt("Record one short progress answer while leaving the active owner open.");
  pressure.catch(() => {});
  await rpc.event((frame) => frame.type === "extension_ui_request" && frame.method === "notify"
    && frame.message === "AUTO-COMMIT-OBSERVER-HELD", "held native post-commit observer");
  const start = await rpc.event((frame) => frame.type === "auto_compaction_start", "native threshold compaction start");
  assertCompleted(await rpc.prompt("/auto-release-observer"));
  assertCompleted(await pressure);
  const end = await rpc.event((frame) => frame.type === "auto_compaction_end", "native threshold compaction end");
  assert.equal(start.reason, "threshold");
  assert.equal(start.action, "context-full");
  assert.equal(end.action, start.action);
  assert.equal(end.aborted, false);
  assert.equal(end.willRetry, false);
  assert.equal(end.result.summary, summary);
  assert.equal(end.result.tokensBefore, reportedInputTokens + reportedOutputTokens);
  assert.ok(end.result.tokensBefore > thresholdTokens);
  assert.ok(end.result.tokensBefore < contextWindow - reserveTokens,
    "This is proactive threshold pressure, not an overflow/retry scenario");
  assert.equal(fixture.requests.length, 4, "One real summary request, with no automatic continuation");
  assert.equal(rpc.frames.filter((frame) => frame.type === "auto_compaction_start").length, 1);
  assert.ok(rpc.frames.indexOf(end) > rpc.frames.indexOf(start));

  const state = await rpc.command("get_state");
  const compactedJournal = await readJournal(state.sessionFile);
  assertHealthy(compactedJournal);
  const barriers = compactEntries(compactedJournal);
  const nativeCompacts = compactedJournal.filter((entry) => entry.type === "compaction");
  assert.equal(barriers.length, 1);
  assert.equal(nativeCompacts.length, 1);
  const barrierEntry = barriers[0];
  const barrier = barrierEntry.data.barrier;
  assert.equal(barrier.next_epoch, barrier.previous_epoch + 1);
  assert.ok(barrier.replacement_boundaries.length > 0);
  assert.equal(barrierEntry.data.replacementMessages.length, barrier.replacement_boundaries.length);
  assert.equal(barrierEntry.data.replacementMessages[0].summary, summary);
  assert.equal(nativeCompacts[0].summary, summary);
  assert.equal(nativeCompacts[0].firstKeptEntryId, end.result.firstKeptEntryId);
  assert.ok(compactedJournal.indexOf(nativeCompacts[0]) > compactedJournal.indexOf(barrierEntry),
    "Native compaction acknowledgement must follow the durable Spine barrier");
  const usageEntry = compactedJournal.find((entry) => entry.type === "message" && entry.message.role === "assistant" &&
    visibleText(entry.message) === pressureAnswer);
  assert.equal(usageEntry.message.usage.input, reportedInputTokens);
  assert.equal(usageEntry.message.usage.output, reportedOutputTokens);
  const pressureCommit = compactedJournal.find((entry) => entry.type === "custom"
    && entry.customType === "spine.archive.v1" && entry.data.record.type === "sampling_commit"
    && entry.data.record.record.input_tokens === reportedInputTokens);
  assert.ok(pressureCommit, "Threshold-crossing sampling must be durably committed");
  assert.ok(compactedJournal.indexOf(pressureCommit) > compactedJournal.indexOf(usageEntry));
  assert.ok(compactedJournal.indexOf(pressureCommit) < compactedJournal.indexOf(barrierEntry),
    "Automatic compact must wait for the current sampling archive, not discard its pending tail");
  assert.equal(pressureCommit.data.record.record.epoch, barrier.previous_epoch);
  assert.equal(barrier.boundary, pressureCommit.data.record.record.post_boundary.ordinal + 1,
    "Compact barrier must use the durable Source after the threshold-crossing sampling");

  assertCompleted(await rpc.prompt("Open a fresh Spine owner in the compacted epoch."));
  assert.equal(fixture.requests.length, 6);
  const postCompactJournal = await readJournal(state.sessionFile);
  const newEpochStarts = postCompactJournal.slice(postCompactJournal.findIndex((entry) => entry.id === barrierEntry.id) + 1)
    .filter((entry) => entry.customType === "spine.archive.v1" && entry.data.record.type === "sampling_started");
  assert.ok(newEpochStarts.length > 0);
  assert.ok(newEpochStarts.every((entry) => entry.data.record.record.epoch === barrier.next_epoch));
  assertHealthy(postCompactJournal);

  await rpc.close();
  const restored = await fixture.restart(state.sessionFile, { autoCompaction: true });
  assert.equal((await restored.command("get_state")).sessionId, state.sessionId);
  assertCompleted(await restored.prompt("Close the restored active Spine owner and report completion."));
  assert.equal(fixture.requests.length, 8);
  const restoredJournal = await readJournal(state.sessionFile);
  assertHealthy(restoredJournal);
  assert.equal(compactEntries(restoredJournal).length, 1, "Restart must replay, not duplicate, the compact barrier");
  assert.equal(restoredJournal.filter((entry) => entry.type === "compaction").length, 1);
  assert.equal(restored.frames.filter((frame) => frame.type === "auto_compaction_start").length, 0);
  await restored.close();
});
