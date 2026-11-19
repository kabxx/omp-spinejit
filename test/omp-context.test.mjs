import assert from "node:assert/strict";
import test from "node:test";

import { mergeHostTranscripts, spliceLiveHostTranscript } from "../dist/omp/context.js";

test("appends dropped tool results after last user", () => {
  const projected = [
    { role: "user", content: "read spawn docs", timestamp: 1 },
  ];
  const host = [
    { role: "user", content: "read spawn docs", timestamp: 1 },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "xd://spine_spawn" } }],
      timestamp: 2,
    },
    {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "read",
      content: [{ type: "text", text: "# spine_spawn\n## Schema" }],
      isError: false,
      timestamp: 3,
    },
  ];
  const spliced = spliceLiveHostTranscript(projected, host);
  assert.equal(spliced.at(-1)?.role, "toolResult");
  assert.equal(spliced.at(-1)?.toolCallId, "c1");
  assert.match(spliced.at(-1)?.content?.[0]?.text ?? "", /spine_spawn/);
});

test("does not duplicate tool results already in the plan", () => {
  const host = [
    { role: "user", content: "go", timestamp: 1 },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "c1", name: "read", arguments: {} }],
      timestamp: 2,
    },
    {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "read",
      content: [{ type: "text", text: "docs" }],
      isError: false,
      timestamp: 3,
    },
  ];
  const spliced = spliceLiveHostTranscript(host, host);
  assert.equal(spliced.filter((message) => message.role === "toolResult").length, 1);
});

test("restores results before later assistant tool calls", () => {
  const user = { role: "user", content: "inspect", timestamp: 1 };
  const call = (id, timestamp) => ({
    role: "assistant",
    content: [{ type: "toolCall", id, name: "read", arguments: {} }],
    timestamp,
  });
  const result = (id, timestamp) => ({
    role: "toolResult", toolCallId: id, toolName: "read",
    content: [{ type: "text", text: id }], isError: false, timestamp,
  });
  const firstCall = call("c1", 2);
  const secondCall = call("c2", 4);
  const host = [user, firstCall, result("c1", 3), secondCall, result("c2", 5)];
  const messages = spliceLiveHostTranscript([user, firstCall, secondCall], host);
  assert.deepEqual(messages, host);
});

test("retained calls from a previous user turn keep their matching result", () => {
  const earlier = { role: "user", content: "open", timestamp: 1 };
  const call = {
    role: "assistant", timestamp: 2,
    content: [{ type: "toolCall", id: "open", name: "write", arguments: {} }],
  };
  const result = {
    role: "toolResult", toolCallId: "open", toolName: "write", timestamp: 3,
    content: [{ type: "text", text: "opened" }], isError: false,
  };
  const later = { role: "user", content: "continue", timestamp: 4 };
  assert.deepEqual(
    spliceLiveHostTranscript([earlier, call, later], [earlier, call, result, later]),
    [earlier, call, result, later],
  );
});

test("transient merge subtracts persisted occurrences, not every message sharing their identity", () => {
  const original = { role: "user", content: "Repeat the request", timestamp: 8 };
  const repeated = structuredClone(original);
  const fresh = { role: "custom", customType: "host-resource", content: "A new resource", display: false, timestamp: 9 };
  assert.deepEqual(mergeHostTranscripts([], [original, repeated, fresh], [original]), [repeated, fresh]);
  assert.deepEqual(mergeHostTranscripts([original], [original, repeated, fresh], [original]), [original, repeated, fresh]);
  assert.deepEqual(mergeHostTranscripts([original, repeated], [original, repeated, fresh], [original]),
    [original, repeated, fresh]);
});

test("custom live/persisted clock drift reconciles copies without losing new payloads or repeated occurrences", () => {
  const persisted = { role: "custom", customType: "native-resource", content: "resource", display: false, timestamp: 1048 };
  const live = { ...persisted, timestamp: 1047 };
  const changed = { ...live, content: "different resource" };
  const detailed = { ...live, details: { producer: "different" } };
  assert.deepEqual(mergeHostTranscripts([], [live, { ...live, timestamp: 1049 }, changed, detailed], [persisted]),
    [{ ...live, timestamp: 1049 }, changed, detailed]);
  assert.deepEqual(mergeHostTranscripts([persisted], [live], [persisted]), [persisted]);
});

test("restoring a current custom suffix retains an identical earlier conversation occurrence", () => {
  const older = { role: "custom", customType: "resource", content: "repeat", display: false, timestamp: 1 };
  const user = { role: "user", content: "Continue with the repeated resource", timestamp: 2 };
  for (const timestamp of [1, 3]) {
    const newer = { ...older, timestamp };
    const host = [older, user, newer];
    assert.deepEqual(spliceLiveHostTranscript(host, host), host);
  }
});

test("live suffix does not resurrect a folded call and restores a retained call under its projected id", () => {
  const user = { role: "user", content: "start", timestamp: 1 };
  const call = (id, timestamp) => ({
    role: "assistant", api: "openai-responses", timestamp,
    content: [
      { type: "thinking", thinking: "signed reasoning", thinkingSignature: "signature" },
      { type: "toolCall", id, name: "read", arguments: {} },
    ],
  });
  const reply = (id, timestamp) => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [], isError: false, timestamp });
  const closed = call("closed", 2);
  const closedReply = reply("closed", 3);
  const retained = call("retained|item", 4);
  const retainedReply = reply("retained|item", 5);
  const settledHost = [user, closed, closedReply, retained, retainedReply];
  const folded = { ...retained, content: [{ ...retained.content[1], id: "retained" }] };
  const transient = call("live", 6);
  const transientReply = reply("live", 7);
  assert.deepEqual(
    spliceLiveHostTranscript([user, folded], [...settledHost, transient, transientReply], settledHost),
    [user, folded, { ...retainedReply, toolCallId: "retained" }, transient, transientReply],
  );
});

test("restores native eval context before the last user without restoring older discarded sources", () => {
  const discarded = { role: "custom", customType: "native-resource", content: "old", display: false, timestamp: 1 };
  const evalState = { role: "custom", customType: "eval-state-context", content: "live", display: false, timestamp: 2 };
  const user = { role: "user", content: "current request", timestamp: 3 };
  assert.deepEqual(spliceLiveHostTranscript([user], [discarded, evalState, user], [discarded, user]), [user, evalState]);
});
