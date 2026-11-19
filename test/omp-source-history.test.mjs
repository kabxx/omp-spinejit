import assert from "node:assert/strict";
import test from "node:test";

import { createNodeSpineRuntime } from "@spinejit/spine-sdk/node";

import { buildCompactBarrier } from "../dist/omp/lifecycle.js";
import { OMP_ADAPTER_ID, OMP_SOURCE_ENTRY_TYPE } from "../dist/omp/protocol.js";
import {
  buildOmpSourceCheckpoint,
  decodeOmpSourceEntry,
  OmpSourceHistory,
  OmpSourceHistoryError,
} from "../dist/omp/source-history.js";

function entry(characters, epoch = 0, thread = "canonical") {
  return {
    schema: OMP_ADAPTER_ID, thread, epoch, characters,
    nativeKeys: characters.map((character) => character.type === "message" || character.type === "arrival"
      ? nativeKey(character.boundary) : null),
  };
}

function message(boundary, content = "original", role = "user") {
  return { type: "message", boundary, role, content };
}

function nativeKey(boundary) {
  return JSON.stringify({ timestamp: boundary + 1 });
}

function snapshotNativeKey(source) {
  return (sourceId) => {
    const cell = source.cells.find((candidate) =>
      candidate.source_id.thread === sourceId.thread && candidate.source_id.epoch === sourceId.epoch &&
      candidate.source_id.ordinal === sourceId.ordinal);
    assert.ok(cell && "Message" in cell.item, "only real message cells request native producer identity");
    return nativeKey(cell.boundary);
  };
}

async function snapshot(runtime) {
  const result = await runtime.client.execute({ type: "source_snapshot" });
  assert.equal(result.type, "source_snapshot");
  return result.source;
}

test("real WASM snapshot checkpoints round-trip every message role, opaque and synthetic source", async () => {
  const runtime = createNodeSpineRuntime({ thread: "canonical", features: ["jit", "spawn"] });
  const replay = createNodeSpineRuntime({ thread: "canonical", features: ["jit", "spawn"] });
  try {
    const empty = await snapshot(runtime);
    assert.equal(buildOmpSourceCheckpoint(empty, new OmpSourceHistory("canonical"), snapshotNativeKey(empty)), null);
    const characters = [
      message(0, "USER-ORIGINAL-FENCE", "user"),
      message(1, "CONTEXTUAL-ORIGINAL-FENCE", "contextual_user"),
      message(2, "ASSISTANT-ORIGINAL-FENCE", "assistant"),
      message(3, "DEVELOPER-ORIGINAL-FENCE", "developer"),
      message(4, "SYSTEM-ORIGINAL-FENCE", "system"),
      { type: "opaque", boundary: 5 },
      { type: "synthetic", boundary: 6, item: { SourceSpan: { span: { start: 0, end: 1 } } } },
    ];
    await runtime.client.execute({ type: "observe_sources", characters });
    const original = await snapshot(runtime);
    assert.deepEqual(original.cells.slice(0, 5).map((cell) => cell.item.Message.message.role),
      ["User", "ContextualUser", "Assistant", "Developer", "System"]);
    assert.deepEqual(original.cells[5].item, { Native: { source: { Rollout: { ordinal: 5 } } } });

    const history = new OmpSourceHistory("canonical");
    assert.equal(OMP_SOURCE_ENTRY_TYPE, "spine.source.v1");
    const checkpoint = buildOmpSourceCheckpoint(original, history, snapshotNativeKey(original));
    assert.deepEqual(checkpoint, entry(characters));
    assert.deepEqual(decodeOmpSourceEntry(JSON.parse(JSON.stringify(checkpoint)), "canonical"), checkpoint);
    // Building a delta is pure; unsuccessful durable writes must not suppress a retry.
    assert.deepEqual(buildOmpSourceCheckpoint(original, history, snapshotNativeKey(original)), checkpoint);
    history.add(checkpoint);
    assert.equal(buildOmpSourceCheckpoint(original, history, snapshotNativeKey(original)), null);
    assert.equal(history.hasNativeKey(0, nativeKey(3), 0, 2), false,
      "a late developer cannot be attributed to an earlier archive prefix");
    assert.equal(history.hasNativeKey(0, nativeKey(3), 0, 3), true);
    assert.equal(history.hasNativeKey(0, nativeKey(3), 4, 6), false);
    assert.equal(history.hasNativeKey(1, nativeKey(3), 0, 6), false,
      "checkpoint identities do not cross compact epochs");
    assert.throws(() => history.assertReplayComplete(), /no native source/,
      "identity lookahead must not supply or mark a native source resolved");

    const restored = await replay.client.execute({
      type: "replay",
      inputs: characters.map((character) => ({
        type: "source",
        character: history.resolve(0, character.boundary, character,
          character.type === "message" ? nativeKey(character.boundary) : null),
      })),
    });
    assert.equal(restored.type, "replay_installed");
    assert.deepEqual(restored.source, original);
    history.assertReplayComplete();

    await runtime.client.execute({ type: "observe_sources", characters: [message(7, "NEXT", "assistant")] });
    const extended = await snapshot(runtime);
    const delta = buildOmpSourceCheckpoint(extended, history, snapshotNativeKey(extended));
    assert.deepEqual(delta, entry([message(7, "NEXT", "assistant")]));
    history.add(delta);
    assert.equal(buildOmpSourceCheckpoint(extended, history, snapshotNativeKey(extended)), null);
  } finally {
    runtime.dispose();
    replay.dispose();
  }
});

test("checkpoint decoding preserves v3 Reply, typed arrival and labelled source spans", () => {
  const characters = [
    message(0, "reply text", "reply"),
    { type: "arrival", boundary: 1, arrival: { producer: [0, 1], outcome: "completed", memory: "result" } },
    { type: "synthetic", boundary: 2, item: { SourceSpan: { span: { start: 0, end: 1 }, without_reasoning: true } } },
  ];
  const history = new OmpSourceHistory("canonical");
  history.add(entry(characters));
  const copy = history.get(0, 1);
  copy.arrival.producer.push(2);
  assert.deepEqual(history.get(0, 1), characters[1]);
  assert.throws(() => history.resolve(0, 1), /requires its native source/);
  assert.throws(() => history.resolve(0, 1, { ...characters[1], arrival: { ...characters[1].arrival, memory: "different" } },
    nativeKey(1)), /does not match/);
  for (const character of characters) {
    assert.deepEqual(history.resolve(0, character.boundary, character,
      character.type === "synthetic" ? null : nativeKey(character.boundary)), character);
  }
  history.assertReplayComplete();
});

test("native shake text stays edited while checkpoint source survives an exact WASM replay", async () => {
  const runtime = createNodeSpineRuntime({ thread: "canonical", features: ["jit", "spawn"] });
  const replay = createNodeSpineRuntime({ thread: "canonical", features: ["jit", "spawn"] });
  try {
    const characters = [message(0, "USER-RAW-FENCE"), message(1, "ASSISTANT-RAW-FENCE", "assistant")];
    await runtime.client.execute({ type: "observe_sources", characters });
    const original = await snapshot(runtime);
    const history = new OmpSourceHistory("canonical");
    history.add(buildOmpSourceCheckpoint(original, history, snapshotNativeKey(original)));
    const native = [
      { role: "user", content: "[shaken content: artifact://0]", timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "[shaken content: artifact://1]" }], timestamp: 2 },
    ];
    const editedBefore = structuredClone(native);
    const restored = await replay.client.execute({
      type: "replay",
      inputs: native.map((current, boundary) => ({
        type: "source",
        character: history.resolve(0, boundary, message(boundary,
          typeof current.content === "string" ? current.content : current.content[0].text, current.role),
          JSON.stringify({ timestamp: current.timestamp })),
      })),
    });
    history.assertReplayComplete();
    assert.deepEqual(restored.source, original);
    assert.deepEqual(native, editedBefore, "canonical checkpoints must not rewrite native model projection");
    assert.doesNotMatch(JSON.stringify(native), /RAW-FENCE/);
    assert.deepEqual(Object.keys(history.get(0, 1)).sort(), ["boundary", "content", "role", "type"]);
  } finally {
    runtime.dispose();
    replay.dispose();
  }
});

test("real compact epochs retain nonzero replacement boundaries and emit only the new source delta", async () => {
  const runtime = createNodeSpineRuntime({ thread: "canonical", features: ["jit", "spawn"] });
  const replay = createNodeSpineRuntime({ thread: "canonical", features: ["jit", "spawn"] });
  try {
    const old = [message(0), message(1, "old reply", "assistant")];
    await runtime.client.execute({ type: "observe_sources", characters: old });
    const before = await snapshot(runtime);
    const history = new OmpSourceHistory("canonical");
    history.add(buildOmpSourceCheckpoint(before, history, snapshotNativeKey(before)));
    const barrier = buildCompactBarrier(before, 2);
    await runtime.client.execute({ type: "compact", barrier });
    const compacted = await snapshot(runtime);
    assert.equal(compacted.epoch, 1);
    assert.deepEqual(compacted.cells.map((cell) => cell.boundary), barrier.replacement_boundaries);
    assert.ok(barrier.replacement_boundaries[0] > barrier.boundary, "barrier consumes a gap, not a source cell");
    const replacementCheckpoint = buildOmpSourceCheckpoint(compacted, history, snapshotNativeKey(compacted));
    assert.equal(replacementCheckpoint.epoch, 1);
    history.add(replacementCheckpoint);
    assert.equal(buildOmpSourceCheckpoint(compacted, history, snapshotNativeKey(compacted)), null);

    const nextBoundary = barrier.replacement_boundaries.at(-1) + 1;
    const next = message(nextBoundary, "AFTER-COMPACT");
    await runtime.client.execute({ type: "observe_sources", characters: [next] });
    const after = await snapshot(runtime);
    const delta = buildOmpSourceCheckpoint(after, history, snapshotNativeKey(after));
    assert.deepEqual(delta, entry([next], 1));
    history.add(delta);
    assert.equal(history.hasNativeKey(0, nativeKey(0), 0, nextBoundary), true);
    assert.equal(history.hasNativeKey(1, nativeKey(0), 0, nextBoundary), false);
    assert.equal(history.hasNativeKey(1, nativeKey(nextBoundary), 0, nextBoundary - 1), false);
    assert.equal(history.hasNativeKey(1, nativeKey(nextBoundary), nextBoundary, nextBoundary), true);
    const inputs = old.map((character) => ({
      type: "source", character: history.resolve(0, character.boundary, character, nativeKey(character.boundary)),
    }));
    inputs.push({ type: "compact", barrier });
    for (const character of replacementCheckpoint.characters) history.resolve(1, character.boundary, character, null);
    inputs.push({ type: "source", character: history.resolve(1, nextBoundary, next, nativeKey(nextBoundary)) });
    history.assertReplayComplete();
    const restored = await replay.client.execute({ type: "replay", inputs });
    assert.deepEqual(restored.source, after);

    history.add(entry([{ type: "opaque", boundary: barrier.boundary }], 1));
    assert.throws(() => history.assertReplayComplete(), /no native source/,
      "an epoch's barrier gap must not masquerade as a replacement source");
    assert.throws(() => buildOmpSourceCheckpoint(after, history, snapshotNativeKey(after)), /missing from the snapshot/);
  } finally {
    runtime.dispose();
    replay.dispose();
  }
});

test("checkpoint decoding rejects malformed identities, roles, types and duplicate boundaries", () => {
  for (const malformed of [
    null, [], {}, entry([]), { ...entry([message(0)]), schema: "spine.source.snapshot.v1" },
    entry([message(0)], 0, ""), entry([message(0)], -1), entry([message(0)], 0.5),
    entry([message(0)], Number.MAX_SAFE_INTEGER + 1),
    { ...entry([message(0)]), nativeKeys: undefined },
    { ...entry([message(0)]), nativeKeys: [] },
    { ...entry([message(0)]), nativeKeys: [null] },
    { ...entry([message(0)]), nativeKeys: [""] },
    { ...entry([message(0)]), nativeKeys: [12] },
    { ...entry([{ type: "opaque", boundary: 0 }]), nativeKeys: ["unexpected"] },
    { ...entry([{ type: "synthetic", boundary: 0, item: { SourceSpan: { span: { start: 0, end: 1 } } } }]), nativeKeys: ["unexpected"] },
    entry([message(-1)]), entry([message(0.5)]), entry([message(Number.MAX_SAFE_INTEGER + 1)]),
    entry([message(0, "text", "User")]), entry([message(0, 12)]),
    entry([{ type: "rollout", boundary: 0 }]), entry([{ type: "opaque", boundary: 0, content: "not minimal" }]),
    entry([{ ...message(0), usage: { input: 1 } }]),
    entry([message(0), message(0)]), entry([message(2), message(1)]),
    entry([{ type: "synthetic", boundary: 0, item: { Native: { source: { Opaque: { ordinal: 0 } } } } }]),
    entry([{ type: "synthetic", boundary: 0, item: { Native: { source: { Rollout: { ordinal: -1 } } } } }]),
    entry([{ type: "synthetic", boundary: 0, item: { Message: { message: { boundary: 0, role: "user", content: "bad" }, user_anchor: null } } }]),
    entry([{ type: "synthetic", boundary: 0, item: { SourceSpan: { span: { start: 2, end: 1 } } } }]),
    entry([{ type: "synthetic", boundary: 0, item: { MemorySlot: { User: null } } }]),
  ]) {
    assert.throws(() => decodeOmpSourceEntry(malformed), OmpSourceHistoryError, JSON.stringify(malformed));
  }
  assert.throws(() => decodeOmpSourceEntry(entry([message(0)], 0, "foreign"), "canonical"), /thread/);
  assert.throws(() => new OmpSourceHistory(""), /thread/);
});

test("overlapping checkpoints are immutable, conflict detection is transactional and reads cannot mutate them", () => {
  const history = new OmpSourceHistory("canonical");
  const saved = entry([message(0), message(2, "assistant", "assistant")]);
  history.add(saved);
  history.add(structuredClone(saved));
  saved.characters[0].content = "mutated caller";
  saved.nativeKeys[0] = "mutated caller identity";
  assert.equal(history.nativeKey(0, 0), nativeKey(0));
  const returned = history.get(0, 0);
  returned.content = "mutated result";
  assert.equal(history.get(0, 0).content, "original");
  assert.throws(() => history.add(entry([message(1, "new"), message(2, "conflict", "assistant")])), /conflict/);
  assert.equal(history.get(0, 1), undefined, "a rejected delta cannot install an earlier character");
  for (const conflicting of [message(0, "changed"), message(0, "original", "assistant"), { type: "opaque", boundary: 0 }]) {
    assert.throws(() => history.add(entry([conflicting])), /conflict/);
  }
  assert.throws(() => history.add(entry([message(3)], 0, "foreign")), /thread/);
  assert.throws(() => history.resolve(0, 0, message(0, "edited", "assistant"), nativeKey(0)), /type or role/);
  assert.throws(() => history.resolve(0, 0, { type: "opaque", boundary: 0 }, null), /type or role/);
  assert.throws(() => history.resolve(0, 0, message(1), nativeKey(1)), /boundary/);
  for (const [epoch, boundary] of [[-1, 0], [0, -1], [0.5, 0], [0, Number.MAX_SAFE_INTEGER + 1]]) {
    assert.throws(() => history.get(epoch, boundary), /position/);
  }
});

test("missing native sources, future positions and unused epochs are never restored from a checkpoint", () => {
  const history = new OmpSourceHistory("canonical");
  history.add(entry([message(0), message(2, "missing")]));
  assert.throws(() => history.assertReplayComplete(), /no native source/);
  // A pure read is not evidence that the native branch contains this source.
  assert.equal(history.get(0, 2).content, "missing");
  history.resolve(0, 0, message(0, "native rewritten"), nativeKey(0));
  history.resolve(0, 1, message(1, "real but uncheckpointed"), nativeKey(1));
  assert.throws(() => history.assertReplayComplete(), /0:2/);
  history.resolve(0, 2, message(2, "native present"), nativeKey(2));
  history.assertReplayComplete();
  history.add(entry([message(7, "future")], 1));
  assert.throws(() => history.assertReplayComplete(), /1:7/);
  assert.throws(() => history.assertSnapshotPositions(0, new Set([0, 2])), /future epoch/);
});

test("snapshot identity, immutable content and opaque provenance are validated before emitting a delta", async () => {
  const runtime = createNodeSpineRuntime({ thread: "canonical", features: ["jit", "spawn"] });
  try {
    await runtime.client.execute({ type: "observe_sources", characters: [message(0), { type: "opaque", boundary: 1 }] });
    const source = await snapshot(runtime);
    const history = new OmpSourceHistory("canonical");
    history.add(buildOmpSourceCheckpoint(source, history, snapshotNativeKey(source)));
    assert.throws(() => buildOmpSourceCheckpoint(source, history, () => null), /identity/);
    assert.throws(() => buildOmpSourceCheckpoint(source, history, () => "different native identity"), /conflicts/);
    const changed = structuredClone(source);
    changed.cells[0].item.Message.message.content = "edited source is not canonical";
    assert.throws(() => buildOmpSourceCheckpoint(changed, history, snapshotNativeKey(changed)), /conflicts/);
    for (const mutate of [
      (copy) => { copy.schema = "wrong"; },
      (copy) => { copy.thread = "foreign"; },
      (copy) => { copy.epoch = 0.5; },
      (copy) => { copy.cells[0].source_id.thread = ""; },
      (copy) => { copy.cells[0].source_id.epoch = 1; },
      (copy) => { copy.cells[0].source_id.ordinal = Number.MAX_SAFE_INTEGER + 1; },
      (copy) => { copy.cells[0].item.Message.message.boundary = 8; },
      (copy) => { copy.cells[1].item.Native.source.Rollout.ordinal = 8; },
      (copy) => { copy.cells[1].source_id.ordinal = copy.cells[0].source_id.ordinal; },
      (copy) => { copy.cells[1].boundary = copy.cells[0].boundary; },
      (copy) => { copy.cells.pop(); },
    ]) {
      const invalid = structuredClone(source);
      mutate(invalid);
      assert.throws(() => buildOmpSourceCheckpoint(invalid, history, snapshotNativeKey(invalid)), OmpSourceHistoryError);
    }
  } finally {
    runtime.dispose();
  }
});

test("synthetic duplicates compare meaning rather than JSON key order and never lend stored references", () => {
  const history = new OmpSourceHistory("canonical");
  const character = {
    type: "synthetic", boundary: 7,
    item: { Native: { source: { CompactReplacement: { compact_boundary: 6, index: 0 } } } },
  };
  history.add(entry([character], 1));
  history.add(entry([{
    boundary: 7, type: "synthetic",
    item: { Native: { source: { CompactReplacement: { index: 0, compact_boundary: 6 } } } },
  }], 1));
  character.item.Native.source.CompactReplacement.index = 9;
  const resolved = history.resolve(1, 7);
  resolved.item.Native.source.CompactReplacement.index = 8;
  assert.equal(history.get(1, 7).item.Native.source.CompactReplacement.index, 0);
  assert.throws(() => history.add(entry([character], 1)), /conflict/);
  history.assertReplayComplete();
});

test("a different native user occupying the same epoch, boundary and role cannot borrow canonical source", () => {
  const history = new OmpSourceHistory("canonical");
  const checkpoint = entry([message(0, "OLD-USER-FENCE")]);
  checkpoint.nativeKeys[0] = JSON.stringify({ role: "user", timestamp: 10, attribution: "human" });
  history.add(checkpoint);
  const differentUserKey = JSON.stringify({ role: "user", timestamp: 20, attribution: "human" });
  assert.throws(() => history.resolve(0, 0, message(0, "NEW-USER"), differentUserKey), /identity/);
  assert.throws(() => history.assertReplayComplete(), /no native source/);
  assert.throws(() => history.resolve(0, 0), /requires its native source identity/);
  assert.throws(() => history.resolve(0, 0, message(0), null), /identity/);
  assert.throws(() => history.resolve(0, 0, message(0)), /identity/);
  assert.throws(() => history.add({ ...checkpoint, nativeKeys: [differentUserKey] }), /conflict/);
  assert.equal(history.resolve(0, 0, message(0, "[shaken artifact://0]"), checkpoint.nativeKeys[0]).content, "OLD-USER-FENCE");
  history.assertReplayComplete();
});

test("real namespace continuation keeps replay lineage checkpoints separate from the active child namespace", async () => {
  const runtime = createNodeSpineRuntime({ thread: "canonical", features: ["jit", "spawn"] });
  const replay = createNodeSpineRuntime({ thread: "canonical", features: ["jit", "spawn"] });
  try {
    const inherited = [message(0, "PARENT-ORIGINAL"), message(1, "PARENT-REPLY", "assistant")];
    await runtime.client.execute({ type: "observe_sources", characters: inherited });
    const parent = await snapshot(runtime);
    const history = new OmpSourceHistory("canonical");
    history.add(buildOmpSourceCheckpoint(parent, history, snapshotNativeKey(parent)));
    const continued = await runtime.client.execute({ type: "continue_namespace", thread: "child" });
    assert.equal(continued.type, "namespace_continued");
    const child = continued.source;
    assert.equal(child.thread, "child");
    assert.deepEqual(child.cells.map(({ boundary, item }) => ({ boundary, item })),
      parent.cells.map(({ boundary, item }) => ({ boundary, item })));
    assert.throws(() => buildOmpSourceCheckpoint(child, history, snapshotNativeKey(child)), /identity/);
    assert.equal(buildOmpSourceCheckpoint(child, history, snapshotNativeKey(child), "child"), null);
    assert.throws(() => buildOmpSourceCheckpoint(child, history, snapshotNativeKey(child), "unrelated"), /identity/);
    assert.throws(() => buildOmpSourceCheckpoint(child, history, snapshotNativeKey(child), ""), /identity/);

    const next = message(2, "CHILD-NEW-USER");
    await runtime.client.execute({ type: "observe_sources", characters: [next] });
    const extended = await snapshot(runtime);
    assert.equal(extended.thread, "child");
    assert.deepEqual(extended.cells.slice(0, child.cells.length), child.cells,
      "admitting a child source must preserve all inherited source origins returned by the real runtime");
    assert.equal(extended.cells.at(-1).source_id.thread, "child");
    const delta = buildOmpSourceCheckpoint(extended, history, snapshotNativeKey(extended), "child");
    assert.deepEqual(delta, entry([next]), "checkpoint thread remains the original replay lineage");
    history.add(delta);
    assert.equal(buildOmpSourceCheckpoint(extended, history, snapshotNativeKey(extended), "child"), null);
    assert.throws(() => new OmpSourceHistory("child").add(delta), /thread/);

    // Explicit validation boundary: origins may be inherited, but identities are full namespace tuples.
    const mixedOrigins = structuredClone(extended);
    mixedOrigins.cells[0].source_id = structuredClone(parent.cells[0].source_id);
    mixedOrigins.cells.at(-1).source_id.ordinal = mixedOrigins.cells[0].source_id.ordinal;
    assert.equal(buildOmpSourceCheckpoint(mixedOrigins, history, snapshotNativeKey(mixedOrigins), "child"), null,
      "the same ordinal in different producer namespaces is not a duplicate source identity");
    mixedOrigins.cells.at(-1).source_id = structuredClone(mixedOrigins.cells[0].source_id);
    assert.throws(() => buildOmpSourceCheckpoint(mixedOrigins, history, snapshotNativeKey(mixedOrigins), "child"), /duplicate/);

    const restored = await replay.client.execute({
      type: "replay",
      inputs: [...inherited, next].map((character) => ({
        type: "source", character: history.resolve(0, character.boundary, character, nativeKey(character.boundary)),
      })),
    });
    history.assertReplayComplete();
    assert.equal(restored.source.thread, "canonical");
    assert.deepEqual(restored.source.cells.map(({ boundary, item }) => ({ boundary, item })),
      extended.cells.map(({ boundary, item }) => ({ boundary, item })));
    const restoredChild = await replay.client.execute({ type: "continue_namespace", thread: "child" });
    assert.equal(restoredChild.source.thread, "child");
    assert.deepEqual(restoredChild.source.cells.map(({ boundary, item }) => ({ boundary, item })),
      extended.cells.map(({ boundary, item }) => ({ boundary, item })));
    assert.equal(buildOmpSourceCheckpoint(restoredChild.source, history, snapshotNativeKey(restoredChild.source), "child"), null);
  } finally {
    runtime.dispose();
    replay.dispose();
  }
});

test("checkpoint native-key range lookup distinguishes repeated occurrences and out-of-order deltas", () => {
  const history = new OmpSourceHistory("canonical");
  for (const boundary of [4, 1, 9, 7]) {
    history.add({ ...entry([message(boundary)]), nativeKeys: ["same-native-key"] });
  }
  for (const boundary of [1, 4, 7, 9]) assert.equal(history.hasNativeKey(0, "same-native-key", boundary, boundary), true);
  for (const [start, end] of [[0, 0], [2, 3], [5, 6], [8, 8], [10, 20]]) {
    assert.equal(history.hasNativeKey(0, "same-native-key", start, end), false);
  }
  assert.equal(history.hasNativeKey(0, "same-native-key", 2, 8), true);
  assert.equal(history.hasNativeKey(1, "same-native-key", 0, 20), false);
  assert.throws(() => history.assertReplayComplete(), /no native source/);
});
