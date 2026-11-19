import assert from "node:assert/strict";
import test from "node:test";
import { createNativeFixture, readJournal, spineCall, visibleText } from "./fixture.mjs";
import { assertFoldedMemory, assertPendingFold } from "./fold-assertions.mjs";

const bridge = new URL("./reset.bridge.mjs", import.meta.url);
let commandSerial = 0;

async function bridgeCall(rpc, action, fields = {}) {
  const token = `reset-command-${++commandSerial}`;
  const result = await rpc.prompt(`/native-reset-case ${JSON.stringify({ action, token, ...fields })}`);
  assert.equal(result.status, "completed", JSON.stringify(result));
  const frame = await rpc.event((frame) => frame.type === "extension_ui_request"
    && frame.method === "notify" && frame.message.startsWith("CASE-RESULT:")
    && JSON.parse(frame.message.slice("CASE-RESULT:".length)).token === token, action);
  return JSON.parse(frame.message.slice("CASE-RESULT:".length));
}

function assertIdentity(before, after) {
  for (const key of ["sessionId", "sessionFile", "title", "cwd", "model", "autoRetry", "autoCompaction"]) {
    assert.deepEqual(after[key], before[key], `native reset changed ${key}`);
  }
}

function assertOldAbsent(text) {
  for (const sentinel of ["RESET-OLD-USER", "RESET-OLD-CLOSED", "RESET-OLD-LIVE", "RESET-OLD-MEMORY", "RESET-OLD-READY"]) {
    assert.ok(!text.includes(sentinel), `pre-reset context leaked ${sentinel}`);
  }
}

function assertHealthyJournal(rows) {
  assert.equal(rows.filter((entry) => entry.customType === "spine.fault.v1").length, 0);
}

async function completed(rpc, prompt) {
  const result = await rpc.prompt(prompt);
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.equal(result.agentInvoked, true);
}

test("native reset preserves transcript identity but clears open Spine ownership, memory and model context across resume", { timeout: 180_000 }, async (t) => {
  const fixture = await createNativeFixture(t, {
    label: "native-reset-owner",
    bridge,
    onRequest(request, { send, index }) {
      const text = visibleText(request.messages);
      switch (index) {
        case 1:
          assert.ok(text.includes("RESET-OLD-USER"));
          send(spineCall("spine_open", { goal: "RESET-OLD-CLOSED" }));
          break;
        case 2:
          assert.match(text, /<spine_node id="1\.1"/);
          assert.ok(text.includes("RESET-OLD-CLOSED"));
          send(spineCall("spine_next", { memory: "RESET-OLD-MEMORY", goal: "RESET-OLD-LIVE" }));
          break;
        case 3:
          assert.match(text, /<spine_node id="1\.2"/);
          assert.ok(text.includes("RESET-OLD-LIVE"));
          assertPendingFold(request, "1.1", "RESET-OLD-MEMORY");
          send("RESET-OLD-READY");
          break;
        case 4:
          assertOldAbsent(text);
          assert.ok(text.includes("RESET-NEW-USER"));
          send(spineCall("spine_open", { goal: "RESET-NEW-OWNER" }));
          break;
        case 5:
          assertOldAbsent(text);
          assert.match(text, /<spine_node id="1\.1"/);
          assert.ok(text.includes("RESET-NEW-OWNER"));
          assert.doesNotMatch(text, /<spine_node id="1\.2\.1"/);
          send(spineCall("spine_close", { memory: "RESET-NEW-MEMORY" }));
          break;
        case 6:
          assertOldAbsent(text);
          assertPendingFold(request, "1.1", "RESET-NEW-MEMORY");
          send("RESET-NEW-DONE");
          break;
        case 7:
          assertOldAbsent(text);
          assertFoldedMemory(request, "1.1", "RESET-NEW-MEMORY");
          assert.ok(text.includes("RESET-RESUMED-USER"));
          send(spineCall("spine_open", { goal: "RESET-RESUMED-OWNER" }));
          break;
        case 8:
          assertOldAbsent(text);
          assert.match(text, /<spine_node id="1\.2"/);
          assert.ok(text.includes("RESET-RESUMED-OWNER"));
          send(spineCall("spine_close", { memory: "RESET-RESUMED-MEMORY" }));
          break;
        case 9:
          assertOldAbsent(text);
          assertFoldedMemory(request, "1.1", "RESET-NEW-MEMORY");
          assertPendingFold(request, "1.2", "RESET-RESUMED-MEMORY");
          send("RESET-RESUMED-DONE");
          break;
        case 10:
          assertOldAbsent(text);
          assertFoldedMemory(request, "1.2", "RESET-RESUMED-MEMORY");
          send("RESET-RESUMED-MEMORY-VERIFIED");
          break;
        default:
          assert.fail(`Unexpected native reset request ${index}`);
      }
    },
  });
  const rpc = await fixture.start();
  await completed(rpc, "RESET-OLD-USER");
  const { snapshot: original } = await bridgeCall(rpc, "snapshot", { title: "Native reset retains this title" });
  assert.ok(original.messages.length > 0);
  assert.equal(original.cwd, fixture.workspace);
  const originalRows = await readJournal(original.sessionFile);
  assert.ok(originalRows.some((entry) => entry.message?.role === "user" && visibleText(entry.message).includes("RESET-OLD-USER")));
  assert.ok(originalRows.some((entry) => entry.customType === "spine.archive.v1"));

  const reset = await bridgeCall(rpc, "reset");
  assertIdentity(reset.before, reset.after);
  assert.equal(reset.result.droppedCount, reset.before.messages.length);
  assert.ok(reset.result.droppedCount > 0);
  assert.deepEqual(reset.after.messages, []);
  assert.deepEqual(reset.after.events, reset.before.events, "context reset must not masquerade as a session start/switch");
  const resetRows = await readJournal(original.sessionFile);
  assert.deepEqual(resetRows.slice(0, originalRows.length), originalRows, "native reset erased historical records");
  assert.equal(resetRows.filter((entry) => entry.type === "reset_boundary").length, 1);
  assert.equal(reset.after.entries.at(-1).type, "reset_boundary");

  await completed(rpc, "RESET-NEW-USER");
  assert.equal(fixture.requests.length, 6);
  const { snapshot: beforeRestart } = await bridgeCall(rpc, "snapshot");
  assertIdentity(original, beforeRestart);
  assertOldAbsent(visibleText(beforeRestart.messages));
  await rpc.close();

  const resumed = await fixture.restart(original.sessionFile);
  const { snapshot: restored } = await bridgeCall(resumed, "snapshot");
  assertIdentity(beforeRestart, restored);
  assertOldAbsent(visibleText(restored.messages));
  assert.ok(visibleText(restored.messages).includes("RESET-NEW-DONE"));
  await completed(resumed, "RESET-RESUMED-USER");
  await completed(resumed, "Recall the new memory after its Fold.");
  assert.equal(fixture.requests.length, 10);
  await bridgeCall(resumed, "snapshot");
  const finalRows = await readJournal(original.sessionFile);
  assert.deepEqual(finalRows.slice(0, originalRows.length), originalRows);
  assert.equal(finalRows.filter((entry) => entry.type === "reset_boundary").length, 1);
  assertHealthyJournal(finalRows);
  await resumed.close();
});

test("native reset accepts an empty context repeatedly and resumes a usable fresh Root", { timeout: 120_000 }, async (t) => {
  const fixture = await createNativeFixture(t, {
    label: "native-reset-empty",
    bridge,
    onRequest(request, { send, index }) {
      const text = visibleText(request.messages);
      if (index === 1) {
        assert.ok(text.includes("RESET-EMPTY-NEW-USER"));
        send(spineCall("spine_open", { goal: "RESET-EMPTY-OWNER" }));
      } else if (index === 2) {
        assert.match(text, /<spine_node id="1\.1"/);
        assert.ok(text.includes("RESET-EMPTY-OWNER"));
        send(spineCall("spine_close", { memory: "RESET-EMPTY-MEMORY" }));
      } else if (index === 3) {
        assertPendingFold(request, "1.1", "RESET-EMPTY-MEMORY");
        send("RESET-EMPTY-DONE");
      } else if (index === 4) {
        assertFoldedMemory(request, "1.1", "RESET-EMPTY-MEMORY");
        send("RESET-EMPTY-MEMORY-VERIFIED");
      } else assert.fail(`Unexpected empty-reset request ${index}`);
    },
  });
  const rpc = await fixture.start();
  const first = await bridgeCall(rpc, "reset", { title: "Empty reset title" });
  assertIdentity(first.before, first.after);
  assert.equal(first.result.droppedCount, 0);
  assert.deepEqual(first.after.messages, []);
  assert.deepEqual(first.after.events, first.before.events);
  const second = await bridgeCall(rpc, "reset");
  assertIdentity(first.after, second.after);
  assert.equal(second.result.droppedCount, 0);
  assert.equal(second.after.entries.filter((entry) => entry.type === "reset_boundary").length, 2);
  // Native cold sessions are not written until an assistant response exists.
  await completed(rpc, "RESET-EMPTY-NEW-USER");
  await rpc.close();
  const resumed = await fixture.restart(second.after.sessionFile);
  const { snapshot: restored } = await bridgeCall(resumed, "snapshot");
  assertIdentity(second.after, restored);
  assert.ok(visibleText(restored.messages).includes("RESET-EMPTY-DONE"));
  await completed(resumed, "Recall the folded memory after empty reset and restart.");
  assert.equal(fixture.requests.length, 4);
  const rows = await readJournal(restored.sessionFile);
  assert.equal(rows.filter((entry) => entry.type === "reset_boundary").length, 2);
  assertHealthyJournal(rows);
  await resumed.close();
});

test("native reset refuses an active provider turn without altering its context or transcript", { timeout: 120_000 }, async (t) => {
  const fixture = await createNativeFixture(t, {
    label: "native-reset-busy",
    bridge,
    onRequest(request, { send, index }) {
      const text = visibleText(request.messages);
      if (index === 1) {
        assert.ok(text.includes("RESET-BUSY-USER"));
        send(spineCall("spine_open", { goal: "RESET-BUSY-OWNER" }));
      } else if (index === 2) {
        assert.match(text, /<spine_node id="1\.1"/);
        assert.ok(text.includes("RESET-BUSY-OWNER"));
        send(spineCall("spine_close", { memory: "RESET-BUSY-MEMORY" }));
      } else if (index === 3) {
        assertPendingFold(request, "1.1", "RESET-BUSY-MEMORY");
        send("RESET-BUSY-DONE");
      } else if (index === 4) {
        assertFoldedMemory(request, "1.1", "RESET-BUSY-MEMORY");
        send("RESET-BUSY-MEMORY-VERIFIED");
      } else assert.fail(`Unexpected busy-reset request ${index}`);
    },
  });
  const rpc = await fixture.start();
  const armed = await bridgeCall(rpc, "arm-busy-reset");
  assert.equal(armed.armed, true);
  await completed(rpc, "RESET-BUSY-USER");
  const frame = await rpc.event((frame) => frame.type === "extension_ui_request"
    && frame.method === "notify" && frame.message.startsWith("CASE-RESULT:")
    && JSON.parse(frame.message.slice("CASE-RESULT:".length)).token === `${armed.token}:busy`, "busy native reset refusal");
  const refused = JSON.parse(frame.message.slice("CASE-RESULT:".length));
  assert.equal(refused.streaming, true);
  assert.equal(refused.result, null);
  assert.deepEqual(refused.after, refused.before, "busy reset must not mutate native session state");
  assert.ok(visibleText(refused.before.messages).includes("RESET-BUSY-USER"));
  const { snapshot } = await bridgeCall(rpc, "snapshot");
  const rows = await readJournal(snapshot.sessionFile);
  assert.equal(rows.filter((entry) => entry.type === "reset_boundary").length, 0);
  assertHealthyJournal(rows);
  await completed(rpc, "Recall the memory after the busy reset refusal.");
  assert.equal(fixture.requests.length, 4);
  await rpc.close();
});
