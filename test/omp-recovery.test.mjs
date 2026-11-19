import assert from "node:assert/strict";
import test from "node:test";

import { createNodeSpineRuntime } from "@spinejit/spine-sdk/node";

import { buildOmpSourceCheckpoint, OmpSourceHistory } from "../dist/omp/source-history.js";
import { mergeHostTranscripts } from "../dist/omp/context.js";
import { assertOmpV3ReplayBranch } from "../dist/omp/recovery.js";
import { ompArrivalOf, SPINE_ARRIVAL_CUSTOM_TYPE } from "../dist/omp/messages.js";
import {
  buildCompactBarrier,
  buildOmpReplayPlan,
  createOmpSpineAdapter,
  materializeOmpContext,
  OMP_ADAPTER_ID,
  OMP_ARCHIVE_ENTRY_TYPE,
  OMP_COMPACT_ENTRY_TYPE,
  OMP_SOURCE_ENTRY_TYPE,
  ompNativeMessageKey,
  recoverOmpSession,
  ompRewindLeaf,
  sourceObservation,
} from "../dist/omp/index.js";

test("omp replay skips native compaction without a Spine barrier", () => {
  const plan = buildOmpReplayPlan({
    currentSessionId: "s1",
    branch: [
      { type: "model_change", id: "m1" },
      {
        type: "message",
        id: "u1",
      },
      { type: "compaction", id: "c1", fromExtension: false },
    ],
    messagesForEntry(entry) {
      if (entry.id !== "u1") return [];
      return [{ role: "user", content: "hello", timestamp: 1 }];
    },
  });
  assert.equal(plan.sources.length, 1);
  assert.equal(plan.sources[0].message.content, "hello");
});

test("omp replay admits in-flight extra messages missing from the branch", () => {
  const plan = buildOmpReplayPlan({
    currentSessionId: "s1",
    branch: [{ type: "thinking_level_change", id: "t1" }],
    messagesForEntry() {
      return [];
    },
    extraMessages: [{ role: "user", content: "Say only: hi", timestamp: 2 }],
  });
  assert.equal(plan.sources.length, 1);
  assert.equal(plan.sources[0].message.content, "Say only: hi");
  assert.equal(plan.sources[0].entryId, null);
});


test("omp replay skips toolResult host transcript", () => {
  const plan = buildOmpReplayPlan({
    currentSessionId: "s1",
    branch: [
      { type: "message", id: "u1" },
      { type: "message", id: "a1" },
      { type: "message", id: "t1" },
    ],
    messagesForEntry(entry) {
      if (entry.id === "u1") return [{ role: "user", content: "open", timestamp: 1 }];
      if (entry.id === "a1") {
        return [{
          role: "assistant",
          content: [{ type: "toolCall", id: "c1", name: "write", arguments: { path: "xd://spine_open" } }],
          timestamp: 2,
        }];
      }
      return [{
        role: "toolResult",
        toolCallId: "c1",
        toolName: "write",
        content: [{ type: "text", text: "spine_open done" }],
        isError: false,
        timestamp: 3,
      }];
    },
  });
  assert.deepEqual(plan.sources.map((source) => source.message.role), ["user", "assistant"]);
});

test("recovery retains repeated requests and custom message identities from the live host tail", async () => {
  const first = { role: "user", content: "repeat", timestamp: 1 };
  const repeated = { role: "user", content: "repeat", timestamp: 2 };
  const customA = { role: "custom", customType: "a", content: "same", display: true, timestamp: 3 };
  const customB = { ...customA, customType: "b" };
  const plan = buildOmpReplayPlan({
    currentSessionId: "repeated-host-tail",
    branch: [{ type: "message", id: "u1" }, { type: "custom_message", id: "c1" }],
    messagesForEntry(entry) { return entry.id === "u1" ? [first] : [customA]; },
    extraMessages: [repeated, repeated, customB],
  });
  const runtime = createNodeSpineRuntime({ thread: plan.runtimeThread, features: ["jit", "spawn"] });
  const publications = [];
  try {
    const recovered = await recoverOmpSession({
      plan,
      runtimeFactory() { return runtime.client; },
      async adapterFactory(client, bindings) {
        return createOmpSpineAdapter({
          enabled: true,
          runtime: client,
          host: {
            async claimOwnership() {},
            async appendCustomEntry() {},
            async materializeContext(context) { return materializeOmpContext(context, bindings); },
            async replaceContext(context) { publications.push(context); },
          },
        });
      },
    });
    const messages = recovered.source.cells.map((cell) => recovered.bindings.resolve(cell.source_id));
    assert.deepEqual(messages, [first, customA, repeated, repeated, customB]);
    assert.deepEqual(recovered.source.cells.map((cell) => cell.boundary), [0, 1, 2, 3, 4]);
    assert.deepEqual(messages.map((_, index) => plan.sources[index].entryId), ["u1", "c1", null, null, null]);
    assert.equal(publications.length, 1);
  } finally {
    runtime.dispose();
  }
});


const queuedOperations = [
  { type: "open", summary: "Investigate queued input" },
  { type: "next", closed_memory: "FIRST-QUEUED-MEMORY", next_summary: "Handle follow-up" },
];
const spawnOperation = {
  type: "spawn",
  tasks: [{ summary: "Compute", prompt: "5+6" }, { summary: "Compute again", prompt: "7+8" }],
};

function replayPlan(branch, extraMessages, currentSessionId = "queued-history") {
  return buildOmpReplayPlan({
    currentSessionId,
    branch,
    messagesForEntry: (entry) => entry.message ? [entry.message] : [],
    extraMessages: extraMessages === undefined ? undefined
      : mergeHostTranscripts([], extraMessages, branch.flatMap((entry) => entry.message ? [entry.message] : [])),
  });
}

function messageEntry(id, message) {
  return { type: "message", id, message };
}

// These records come from real runtime transactions, including source and record
// digests. The queued user is admitted before finish but durably written after it.
async function canonicalQueuedHistory(operations = queuedOperations) {
  const node = createNodeSpineRuntime({ thread: "queued-history", features: ["jit", "spawn"] });
  const branch = [];
  const characters = [];
  const messages = [];
  let boundary = 0;
  const host = {
    async claimOwnership() {},
    async appendCustomEntry(customType, data) { branch.push({ type: "custom", customType, data }); },
    async materializeContext() { return []; },
    async replaceContext() {},
  };
  try {
    const adapter = await createOmpSpineAdapter({ enabled: true, runtime: node.client, host });
    const admit = async (message) => {
      const character = sourceObservation(message, boundary++).character;
      characters.push(character);
      messages.push(message);
      await adapter.observeSources([character]);
    };
    const first = { role: "user", content: "INITIAL-REQUEST", timestamp: 1 };
    await admit(first);
    branch.push(messageEntry("u0", first));
    for (const [index, operation] of operations.entries()) {
      await adapter.beginSampling();
      const key = `control-${index}`;
      const assistant = {
        role: "assistant",
        content: [
          { type: "text", text: `ASSISTANT-${index}` },
          { type: "toolCall", id: key, name: `spine_${operation.type}`, arguments: {} },
        ],
        timestamp: index + 2,
      };
      await admit(assistant);
      branch.push(messageEntry(`a${index}`, assistant));
      await adapter.registerExecution(key);
      await adapter.stageExecution(key, key, operation);
      await adapter.finishExecution(key, true);
      // Identical occurrences are intentional: live-tail matching cannot dedupe
      // repeated admissions merely by their message value.
      const queued = { role: "user", content: "REPEATED-QUEUED-REQUEST", timestamp: 10 };
      await admit(queued);
      await adapter.finishSampling("completed");
      branch.push(messageEntry(`u${index + 1}`, queued));
    }
    const source = await adapter.sourceSnapshot();
    const context = await adapter.previewAndPublish();
    return { branch, characters, messages, source, context };
  } finally {
    node.dispose();
  }
}

async function recoverPlan(plan, run) {
  const node = createNodeSpineRuntime({ thread: plan.runtimeThread, features: ["jit", "spawn"] });
  const publications = [];
  const archives = [];
  try {
    const recovered = await recoverOmpSession({
      plan,
      runtimeFactory() { return node.client; },
      async adapterFactory(runtime, bindings) {
        return createOmpSpineAdapter({
          enabled: true,
          runtime,
          host: {
            async claimOwnership() {},
            async appendCustomEntry(customType, data) { archives.push({ customType, data }); },
            async materializeContext(context) { return materializeOmpContext(context, bindings); },
            async replaceContext(context) { publications.push(context); },
          },
        });
      },
    });
    await run(recovered, publications, archives);
  } finally {
    node.dispose();
  }
}

function assertCanonicalRecovery(fixture, plan, recovered, publications, archives) {
  assert.deepEqual(plan.inputs.filter((item) => item.type === "source").map((item) => item.character),
    fixture.characters);
  assert.deepEqual(recovered.source, fixture.source);
  assert.deepEqual(recovered.source.cells.map((cell) => recovered.bindings.resolve(cell.source_id)),
    fixture.messages);
  assert.deepEqual(recovered.source.cells.map((cell) => recovered.bindings.entryId(cell.source_id)),
    fixture.branch.filter((entry) => entry.type === "message").map((entry) => entry.id));
  assert.deepEqual(publications.at(-1).projection, fixture.context.projection);
  assert.deepEqual(publications.at(-1).contextPlan, fixture.context.contextPlan);
  assert.deepEqual(archives, [], "replay must not repersist, skip, or fabricate commits");
}

test("OMP recovery refuses a Pi archive even when its Core record and native sources are valid", async () => {
  const fixture = await canonicalQueuedHistory();
  const foreign = structuredClone(fixture.branch);
  for (const entry of foreign) {
    if (entry.customType === OMP_ARCHIVE_ENTRY_TYPE) entry.data.schema = "spine-plugin/pi/v1";
  }
  assert.throws(() => replayPlan(foreign), { name: "OmpSessionRecoveryError" });
  const start = foreign.find((entry) => entry.data?.record?.type === "sampling_started");
  assert.throws(() => ompRewindLeaf([start]), { name: "OmpSessionRecoveryError" });
  await recoverPlan(replayPlan(fixture.branch), async (recovered, publications, archives) => {
    assertCanonicalRecovery(fixture, replayPlan(fixture.branch), recovered, publications, archives);
  });
});

test("queued user persisted after canonical commit replays exact state and supports subsequent Spawn", async () => {
  const fixture = await canonicalQueuedHistory();
  const plan = replayPlan(fixture.branch);
  assert.deepEqual(plan.inputs.map((item) => item.type === "archive" ? item.record.type : item.type),
    ["source", "sampling_started", "source", "source", "sampling_commit",
      "sampling_started", "source", "source", "sampling_commit"]);
  assert.deepEqual(plan.inputs.filter((item) => item.type === "archive").map((item) => item.record),
    fixture.branch.filter((entry) => entry.customType === OMP_ARCHIVE_ENTRY_TYPE)
      .map((entry) => entry.data.record));
  await recoverPlan(plan, async (recovered, publications, archives) => {
    assertCanonicalRecovery(fixture, plan, recovered, publications, archives);
    assert.ok(fixture.context.projection.nodes.some((node) => node.status === "Closed"));
    assert.ok(JSON.stringify(fixture.context.projection).includes("FIRST-QUEUED-MEMORY"));
    await recovered.adapter.beginSampling();
    const nextAssistant = {
      role: "assistant",
      content: [{ type: "text", text: "SPAWN-AFTER-RECOVERY" }],
      timestamp: 30,
    };
    const [sourceId] = await recovered.adapter.observeSources([
      sourceObservation(nextAssistant, 5).character,
    ]);
    recovered.bindings.bind(sourceId, nextAssistant);
    await recovered.adapter.registerExecution("control-2");
    await recovered.adapter.stageExecution("control-2", "control-2", spawnOperation);
    await recovered.adapter.finishExecution("control-2", true);
    const finished = await recovered.adapter.finishSampling("completed");
    assert.equal(finished.type, "committed");
    assert.equal(recovered.adapter.fault, null);
    assert.deepEqual(archives.map((entry) => entry.data.record.type),
      ["sampling_started", "sampling_commit"]);
    const committed = archives.at(-1).data.record.record;
    assert.deepEqual(committed.executions[0].operation, spawnOperation);
    assert.equal(committed.pre_boundary.ordinal, 4);
    assert.equal(committed.post_boundary.ordinal, 5);
    assert.equal(committed.previous_commit_id.value,
      plan.inputs.at(-1).record.record.commit_id.value);
  });
});

function nativeBranch(entries) {
  return entries.map((entry, index) => ({
    ...entry,
    id: entry.id ?? `native-${index}`,
    parentId: index === 0 ? null : (entries[index - 1].id ?? `native-${index - 1}`),
  }));
}

test("native rewind before a delayed user restores the previous owner and admits a fresh operation", async () => {
  const fixture = await canonicalQueuedHistory();
  const laterUser = { role: "user", content: "CUT-LATER-REQUEST", timestamp: 40 };
  let delayedStart;
  await recoverPlan(replayPlan(fixture.branch), async (recovered, publications, archives) => {
    assertCanonicalRecovery(fixture, replayPlan(fixture.branch), recovered, publications, archives);
    await recovered.adapter.observeSources([
      sourceObservation(laterUser, fixture.characters.length).character,
    ]);
    await recovered.adapter.beginSampling();
    assert.equal(archives.length, 1);
    delayedStart = { type: "custom", ...archives[0] };
  });
  const branch = nativeBranch([
    ...fixture.branch, delayedStart, messageEntry("later-user", laterUser),
  ]);
  const originalBranch = structuredClone(branch);
  assert.equal(ompRewindLeaf(branch), null);
  const laterEntry = branch.at(-1);
  const cut = branch.slice(0, branch.findIndex((entry) => entry.id === laterEntry.parentId) + 1);
  assert.throws(() => replayPlan(cut), { name: "OmpSessionRecoveryError" });
  const rewind = ompRewindLeaf(cut);
  assert.deepEqual(rewind, { leafId: branch.at(-3).id });
  const prefix = cut.slice(0, cut.findIndex((entry) => entry.id === rewind.leafId) + 1);
  const plan = replayPlan(prefix);
  let continuedBranch;
  let continuedSource;
  let continuedContext;
  const freshUser = { role: "user", content: "FRESH-REWIND-REQUEST", timestamp: 41 };
  const freshAssistant = {
    role: "assistant", content: [{ type: "text", text: "FRESH-REWIND-CLOSE" }], timestamp: 42,
  };
  await recoverPlan(plan, async (recovered, publications, archives) => {
    assertCanonicalRecovery(fixture, plan, recovered, publications, archives);
    assert.equal(recovered.bindings.entryId(recovered.source.cells.at(-1).source_id), "u2");
    const [userId] = await recovered.adapter.observeSources([
      sourceObservation(freshUser, fixture.characters.length).character,
    ]);
    recovered.bindings.bind(userId, freshUser, "fresh-user");
    await recovered.adapter.beginSampling();
    const [assistantId] = await recovered.adapter.observeSources([
      sourceObservation(freshAssistant, fixture.characters.length + 1).character,
    ]);
    recovered.bindings.bind(assistantId, freshAssistant, "fresh-assistant");
    await recovered.adapter.registerExecution("fresh-close");
    await recovered.adapter.stageExecution("fresh-close", "fresh-close", {
      type: "close", memory: "FRESH-REWIND-MEMORY",
    });
    await recovered.adapter.finishExecution("fresh-close", true);
    const result = await recovered.adapter.finishSampling("completed");
    assert.equal(result.type, "committed");
    assert.equal(recovered.adapter.fault, null);
    assert.deepEqual(archives.map((entry) => entry.data.record.type),
      ["sampling_started", "sampling_commit"]);
    assert.equal(archives[0].data.record.record.pre_boundary.ordinal, fixture.characters.length);
    continuedSource = await recovered.adapter.sourceSnapshot();
    continuedContext = await recovered.adapter.previewAndPublish();
    continuedBranch = nativeBranch([
      ...prefix,
      messageEntry("fresh-user", freshUser),
      { type: "custom", ...archives[0] },
      messageEntry("fresh-assistant", freshAssistant),
      { type: "custom", ...archives[1] },
    ]);
  });
  assert.equal(ompRewindLeaf(continuedBranch), null);
  await recoverPlan(replayPlan(continuedBranch), async (recovered, publications, archives) => {
    assert.deepEqual(recovered.source, continuedSource);
    assert.deepEqual(recovered.source.cells.map((cell) => recovered.bindings.resolve(cell.source_id)),
      [...fixture.messages, freshUser, freshAssistant]);
    assert.deepEqual(publications.at(-1).projection, continuedContext.projection);
    assert.deepEqual(publications.at(-1).contextPlan, continuedContext.contextPlan);
    assert.deepEqual(archives, []);
  });
  assert.deepEqual(branch, originalBranch);
});

test("native rewind removes only decoded tail starts and preserves all other durable boundaries", async () => {
  const fixture = await canonicalQueuedHistory();
  const branch = nativeBranch(fixture.branch);
  const start = branch.find((entry) => entry.data?.record?.type === "sampling_started");
  assert.equal(ompRewindLeaf(branch), null);
  const missingCommitSource = branch.slice(0, -1);
  assert.equal(ompRewindLeaf(missingCommitSource), null);
  assert.throws(() => replayPlan(missingCommitSource), { name: "OmpSessionRecoveryError" });
  assert.throws(() => replayPlan([start]), { name: "OmpSessionRecoveryError" });
  assert.deepEqual(ompRewindLeaf([start]), { leafId: null });
  const starts = nativeBranch([
    ...branch, { ...start, id: "cut-start-1" }, { ...start, id: "cut-start-2" },
  ]);
  assert.deepEqual(ompRewindLeaf(starts), { leafId: branch.at(-1).id });
  const visible = messageEntry("visible-after-start", {
    role: "assistant", content: [{ type: "text", text: "VISIBLE-AFTER-START" }], timestamp: 50,
  });
  assert.equal(ompRewindLeaf(nativeBranch([...starts, visible])), null);
  for (const boundary of [
    { type: "custom", customType: OMP_COMPACT_ENTRY_TYPE },
    { type: "compaction", fromExtension: true },
    branch.find((entry) => entry.data?.record?.type === "sampling_commit"),
  ]) {
    const stopped = nativeBranch([...starts, { ...boundary, id: "preserved-boundary" }]);
    assert.equal(ompRewindLeaf(stopped), null);
    assert.deepEqual(ompRewindLeaf(nativeBranch([...stopped, { ...start, id: "new-tail-start" }])),
      { leafId: "preserved-boundary" });
  }
  for (const mutate of [
    (entry) => { entry.data.schema = "unknown"; },
    (entry) => { entry.data.durabilityId = "not-the-canonical-attempt"; },
    (entry) => { entry.data.record.record.schema = "unknown"; },
    (entry) => { delete entry.data.record.record.pre_boundary; },
    (entry) => { delete entry.data.record.record.previous_commit_id; },
    (entry) => { entry.data.record.record.pre_boundary.ordinal = -1; },
  ]) {
    const malformed = structuredClone(start);
    mutate(malformed);
    assert.throws(() => ompRewindLeaf([malformed]), { name: "OmpSessionRecoveryError" });
    assert.throws(() => replayPlan([malformed]), { name: "OmpSessionRecoveryError" });
  }
});

test("consecutive delayed starts and commits preserve causal archive order without moving sources", async () => {
  const fixture = await canonicalQueuedHistory();
  const archives = fixture.branch.filter((entry) => entry.customType === OMP_ARCHIVE_ENTRY_TYPE);
  const sources = fixture.branch.filter((entry) => entry.type === "message");
  // All four records may be ahead of the required durable source entries.
  const plan = replayPlan([...archives, ...sources]);
  await recoverPlan(plan, async (recovered, publications, persisted) => {
    assertCanonicalRecovery(fixture, plan, recovered, publications, persisted);
    assert.deepEqual(plan.inputs.filter((item) => item.type === "archive").map((item) => item.record),
      archives.map((entry) => entry.data.record));
  });
});

test("live extra messages release delayed commits while retaining duplicate occurrences", async () => {
  const fixture = await canonicalQueuedHistory();
  const lastCommitIndex = fixture.branch.findLastIndex((entry) =>
    entry.data?.record?.type === "sampling_commit");
  const archives = fixture.branch.filter((entry) => entry.customType === OMP_ARCHIVE_ENTRY_TYPE);
  for (const [branch, entryIds] of [
    [fixture.branch.slice(0, lastCommitIndex + 1), ["u0", "a0", "u1", "a1", null]],
    [[fixture.branch[0], ...archives], ["u0", null, null, null, null]],
  ]) {
    const plan = replayPlan(branch, fixture.messages);
    assert.equal(plan.sources.length, fixture.messages.length);
    assert.deepEqual(plan.sources.map((source) => source.entryId), entryIds);
    await recoverPlan(plan, async (recovered, publications, persisted) => {
      assert.deepEqual(recovered.source, fixture.source);
      assert.deepEqual(recovered.source.cells.map((cell) => recovered.bindings.resolve(cell.source_id)),
        fixture.messages);
      assert.deepEqual(publications.at(-1).projection, fixture.context.projection);
      assert.deepEqual(persisted, []);
    });
  }
});

test("missing genuine sources and already-passed archive tails remain hard recovery errors", async () => {
  const fixture = await canonicalQueuedHistory();
  const archives = fixture.branch.filter((entry) => entry.customType === OMP_ARCHIVE_ENTRY_TYPE);
  const sources = fixture.branch.filter((entry) => entry.type === "message");
  assert.throws(() => replayPlan([archives[0]]), /missing its pre-sampling source/);
  assert.throws(() => replayPlan(fixture.branch.slice(0, -1)), /missing its post-sampling source/);
  assert.throws(() => replayPlan([sources[0], archives[0], ...sources.slice(1), archives[1]]),
    /boundary is not the source tail/);
  assert.throws(() => replayPlan([...sources, archives[0]]), /boundary is not the source tail/);
  // Later archives cannot leapfrog a waiting archive or repair descending tails.
  assert.throws(() => replayPlan([archives[2], archives[3], archives[0], archives[1], ...sources]),
    /boundary is not the source tail/);
  const malformed = structuredClone(archives[0]);
  malformed.data.durabilityId = "not-the-canonical-attempt";
  assert.throws(() => replayPlan([malformed, ...sources]), /identity is inconsistent/);
});

test("same-boundary reversed canonical archives still fail core archive-chain validation", async () => {
  const fixture = await canonicalQueuedHistory();
  const archives = fixture.branch.filter((entry) => entry.customType === OMP_ARCHIVE_ENTRY_TYPE);
  const sources = fixture.branch.filter((entry) => entry.type === "message");
  // Next start and previous commit share ordinal 2, but cannot be reordered.
  const plan = replayPlan([
    sources[0], archives[0], sources[1], archives[2], archives[1], sources[2],
    sources[3], archives[3], sources[4],
  ]);
  await assert.rejects(recoverPlan(plan, async () => assert.fail("invalid archive order recovered")));
});

test("delayed Spawn commit replays from its canonical birth without staged results", async () => {
  const fixture = await canonicalQueuedHistory([...queuedOperations, spawnOperation]);
  const plan = replayPlan(fixture.branch);
  await recoverPlan(plan, async (recovered, publications, archives) => {
    assertCanonicalRecovery(fixture, plan, recovered, publications, archives);
    assert.equal(publications.at(-1).projection.nodes.filter((node) => node.spawn === "pending").length, 2);
  });
});

test("same-branch native arrival replays by producer and retains its native receipt ID", async () => {
  const fixture = await canonicalQueuedHistory([...queuedOperations, spawnOperation]);
  const prefix = replayPlan(fixture.branch);
  await recoverPlan(prefix, async (live, publications) => {
    const producer = publications.at(-1).projection.nodes.find((node) => node.spawn === "pending").id;
    const arrival = { producer, outcome: "completed", memory: "DURABLE-CHILD-MEMORY" };
    const receipt = { type: "custom", customType: SPINE_ARRIVAL_CUSTOM_TYPE, data: arrival,
      timestamp: "2026-01-01T00:00:00.000Z", id: "native-arrival" };
    const branch = [...fixture.branch, receipt];
    const plan = replayPlan(branch);
    const boundary = prefix.sources.at(-1).boundary + 1;
    assert.deepEqual(plan.inputs.at(-1), { type: "source", character: { type: "arrival", boundary, arrival } });
    const [arrivalId] = await live.adapter.observeSources([plan.inputs.at(-1).character]);
    live.bindings.bind(arrivalId, plan.sources.at(-1).message, receipt.id);
    const liveSource = await live.adapter.sourceSnapshot();
    const checkpoint = buildOmpSourceCheckpoint(liveSource, new OmpSourceHistory(prefix.runtimeThread),
      (id) => ompNativeMessageKey(live.bindings.resolve(id)), prefix.runtimeThread,
      (id) => ompArrivalOf(live.bindings.resolve(id)));
    assert.deepEqual(checkpoint.characters.at(-1), plan.inputs.at(-1).character);
    const checkpointEntry = { type: "custom", customType: OMP_SOURCE_ENTRY_TYPE, data: checkpoint };
    assert.throws(() => replayPlan([...fixture.branch, checkpointEntry]), /no native source/);
    await recoverPlan(replayPlan([...branch, checkpointEntry]), async (restored) => {
      assert.deepEqual(restored.source, liveSource);
      assert.equal(restored.bindings.entryId(arrivalId), receipt.id);
      assert.deepEqual(ompArrivalOf(restored.bindings.resolve(arrivalId)), arrival);
    });
  });
});

test("SDK v2 journals cannot silently fall back, even across a reset boundary", async () => {
  const fixture = await canonicalQueuedHistory();
  const legacy = structuredClone(fixture.branch.find((entry) => entry.customType === OMP_ARCHIVE_ENTRY_TYPE));
  legacy.data.schema = "spine-plugin/omp/v1";
  const cases = [legacy,
    { type: "custom", customType: "spine.source.v1", data: { schema: legacy.data.schema } },
    { type: "compaction", details: { [OMP_COMPACT_ENTRY_TYPE]: { schema: legacy.data.schema } } },
    { type: "custom", customType: "spine.spawn-terminal.v1" }];
  for (const entry of cases) {
    const branch = nativeBranch([entry, { type: "reset_boundary" }]);
    assert.throws(() => assertOmpV3ReplayBranch(branch), /SDK v2/);
    assert.throws(() => ompRewindLeaf(branch), /SDK v2/);
    assert.throws(() => replayPlan(branch), /SDK v2/);
  }
});

test("queued archives drain before compact epoch barriers and cannot borrow replacement sources", async () => {
  const fixture = await canonicalQueuedHistory();
  const node = createNodeSpineRuntime({ thread: "queued-history", features: ["jit", "spawn"] });
  const epochArchives = [];
  try {
    const adapter = await createOmpSpineAdapter({
      enabled: true,
      runtime: node.client,
      host: {
        async claimOwnership() {},
        async appendCustomEntry(customType, data) {
          epochArchives.push({ type: "custom", customType, data });
        },
        async materializeContext() { return []; },
        async replaceContext() {},
      },
    });
    await adapter.replay(replayPlan(fixture.branch).inputs);
    const summary = { role: "compactionSummary", summary: "QUEUED-CHECKPOINT", tokensBefore: 5, timestamp: 20 };
    const kept = fixture.messages.at(-1);
    const barrier = buildCompactBarrier(await adapter.sourceSnapshot(), 2);
    const compact = {
      type: "custom", customType: OMP_COMPACT_ENTRY_TYPE,
      data: {
        schema: OMP_ADAPTER_ID, barrier, replacementMessages: [summary, kept],
        replacementEntryIds: [null, "u2"],
      },
    };
    await adapter.compact(barrier, { metadata: { messages: [summary, kept], entryIds: [null, "u2"] } });
    const expectedSource = await adapter.sourceSnapshot();
    const expectedContext = await adapter.previewAndPublish();
    const acknowledgement = { type: "compaction", id: "compact-summary", fromExtension: true };
    const piAcknowledgement = { type: "compaction", id: "foreign-summary", fromHook: true };
    assert.throws(() => replayPlan([...fixture.branch, compact, piAcknowledgement]),
      { name: "OmpSessionRecoveryError" });
    const atomicReceipt = { ...acknowledgement, summary: summary.summary, tokensBefore: summary.tokensBefore,
      firstKeptEntryId: "u2", parentId: "u2", details: { [OMP_COMPACT_ENTRY_TYPE]: { ...compact.data,
        preparedLeafId: "u2", nativeAcknowledgement: { firstKeptEntryId: "u2", tokensBefore: summary.tokensBefore } } } };
    const plan = replayPlan([...fixture.branch, atomicReceipt]);
    assert.throws(() => replayPlan([...fixture.branch, { ...atomicReceipt, parentId: "wrong" }]), /does not match/);
    await recoverPlan(plan, async (recovered, publications) => {
      assert.deepEqual(recovered.source, expectedSource);
      assert.equal(recovered.source.epoch, 1);
      assert.deepEqual(recovered.source.cells.map((cell) => recovered.bindings.resolve(cell.source_id)),
        [summary, kept]);
      assert.deepEqual(recovered.source.cells.map((cell) => recovered.bindings.entryId(cell.source_id)),
        ["compact-summary", "u2"]);
      assert.deepEqual(publications.at(-1).projection, expectedContext.projection);
      await recovered.adapter.beginSampling();
      const nextAssistant = {
        role: "assistant",
        content: [{ type: "text", text: "POST-COMPACT-ANSWER" }],
        timestamp: 31,
      };
      const [sourceId] = await recovered.adapter.observeSources([
        sourceObservation(nextAssistant, barrier.replacement_boundaries.at(-1) + 1).character,
      ]);
      recovered.bindings.bind(sourceId, nextAssistant);
      assert.equal((await recovered.adapter.finishSampling("completed")).type, "committed");
      assert.equal(recovered.adapter.fault, null);
    });
    epochArchives.length = 0;
    const epochUser = { role: "user", content: "NEW-EPOCH-USER", timestamp: 40 };
    const epochAssistant = {
      role: "assistant", content: [{ type: "text", text: "NEW-EPOCH-ANSWER" }], timestamp: 41,
    };
    const epochQueued = { role: "user", content: "NEW-EPOCH-QUEUED", timestamp: 42 };
    const firstBoundary = barrier.replacement_boundaries.at(-1) + 1;
    await adapter.observeSources([sourceObservation(epochUser, firstBoundary).character]);
    await adapter.beginSampling();
    await adapter.observeSources([sourceObservation(epochAssistant, firstBoundary + 1).character]);
    await adapter.observeSources([sourceObservation(epochQueued, firstBoundary + 2).character]);
    await adapter.finishSampling("completed");
    const epochSource = await adapter.sourceSnapshot();
    const epochContext = await adapter.previewAndPublish();
    const epochPlan = replayPlan([
      ...fixture.branch, compact, acknowledgement,
      epochArchives[0], messageEntry("epoch-user", epochUser),
      messageEntry("epoch-assistant", epochAssistant),
      epochArchives[1], messageEntry("epoch-queued", epochQueued),
    ]);
    await recoverPlan(epochPlan, async (recovered, publications) => {
      assert.deepEqual(recovered.source, epochSource);
      assert.deepEqual(publications.at(-1).projection, epochContext.projection);
      assert.deepEqual(recovered.source.cells.map((cell) => recovered.bindings.resolve(cell.source_id)),
        [summary, kept, epochUser, epochAssistant, epochQueued]);
      assert.deepEqual(recovered.source.cells.map((cell) => recovered.bindings.entryId(cell.source_id)),
        ["compact-summary", "u2", "epoch-user", "epoch-assistant", "epoch-queued"]);
      assert.equal(recovered.adapter.fault, null);
    });
    assert.throws(() => replayPlan([...fixture.branch.slice(0, -1), compact, acknowledgement]),
      /compact archive precedes a missing sampling source/);
    assert.throws(() => replayPlan([...fixture.branch, compact]),
      /missing its native compaction acknowledgement/);
    assert.throws(() => replayPlan([...fixture.branch, compact, fixture.branch.at(-1)]),
      /not immediately acknowledged/);
  } finally {
    node.dispose();
  }
});

test("Spawn child namespace can inherit delayed parent commits without changing source origins", async () => {
  const fixture = await canonicalQueuedHistory();
  const plan = replayPlan(fixture.branch, undefined, "queued-child");
  await recoverPlan(plan, async (recovered, publications, archives) => {
    assert.equal(plan.runtimeThread, "queued-history");
    assert.equal(recovered.source.thread, "queued-child");
    assert.deepEqual(recovered.source.cells, fixture.source.cells);
    assert.deepEqual(recovered.source.cells.map((cell) => recovered.bindings.resolve(cell.source_id)),
      fixture.messages);
    assert.deepEqual(archives, []);
    assert.deepEqual(publications.at(-1).projection, fixture.context.projection);
    await recovered.adapter.beginSampling();
    const assistant = {
      role: "assistant", content: [{ type: "text", text: "CHILD-CONTROL" }], timestamp: 32,
    };
    const [sourceId] = await recovered.adapter.observeSources([sourceObservation(assistant, 5).character]);
    recovered.bindings.bind(sourceId, assistant);
    await recovered.adapter.registerExecution("child-close");
    await recovered.adapter.stageExecution("child-close", "child-close", {
      type: "close", memory: "CHILD-COMPLETED-MEMORY",
    });
    await recovered.adapter.finishExecution("child-close", true);
    const result = await recovered.adapter.finishSampling("completed");
    assert.equal(result.type, "committed");
    assert.equal(recovered.adapter.fault, null);
    const commit = archives.at(-1).data.record.record;
    assert.equal(commit.attempt_id.thread, "queued-child");
    assert.equal(commit.previous_commit_id.thread, "queued-history");
    assert.equal(commit.executions[0].origin.execution_ref, "child-close");
    assert.ok(JSON.stringify(result.projection).includes("CHILD-COMPLETED-MEMORY"));
  });
});

test("native eval state context is not a source but authored custom context remains canonical", () => {
  const human = { role: "user", content: "current request", timestamp: 1 };
  const content = "runtime notice contents are not conversation history";
  const runtimeNotice = { role: "custom", customType: "eval-state-context", content,
    display: false, attribution: "agent", timestamp: 2 };
  const authoredContext = { ...runtimeNotice, customType: "authored-context", timestamp: 3 };
  const plan = buildOmpReplayPlan({
    currentSessionId: "runtime-context",
    branch: [{ type: "message", id: "human" }],
    messagesForEntry() { return [human]; },
    extraMessages: [runtimeNotice, authoredContext],
  });
  assert.deepEqual(plan.sources.map((source) => source.message), [human, authoredContext]);
  assert.deepEqual(plan.inputs.map((input) => input.character), [
    sourceObservation(human, 0).character,
    sourceObservation(authoredContext, 1).character,
  ]);
});

test("native reset starts only after the latest durable boundary and preserves strict recovery within it", async () => {
  const before = await canonicalQueuedHistory();
  const original = structuredClone(before.branch);
  const branch = [
    ...before.branch,
    { type: "reset_boundary", id: "reset-old" },
    messageEntry("discarded-user", { role: "user", content: "discarded intermediate context", timestamp: 61 }),
    { type: "custom", id: "discarded-bad-archive", customType: OMP_ARCHIVE_ENTRY_TYPE, data: {} },
    { type: "reset_boundary", id: "reset-current" },
    messageEntry("fresh-user", { role: "user", content: "fresh reset work", timestamp: 62 }),
  ];
  const plan = replayPlan(branch, undefined, "native-session");
  assert.equal(plan.currentSessionId, "native-session");
  assert.equal(plan.currentThread, "native-session-reset-reset-current");
  assert.equal(plan.runtimeThread, plan.currentThread);
  await recoverPlan(plan, async (recovered, publications) => {
    assert.equal(recovered.source.thread, plan.currentThread);
    assert.deepEqual(recovered.source.cells.map((cell) => cell.item.Message.message.content), ["fresh reset work"]);
    assert.deepEqual(publications.at(-1).projection.cursor, [1]);
    assert.equal(recovered.adapter.fault, null);
  });
  assert.deepEqual(before.branch, original, "reset recovery must not delete the original transcript");
  assert.throws(() => replayPlan([...branch, {
    type: "custom", id: "current-bad-archive", customType: OMP_ARCHIVE_ENTRY_TYPE, data: {},
  }]), /archive|schema|malformed/i);
});

// Only native persistence timing is varied. All checkpoints, archive digests,
// context and compact barriers are produced by the actual WASM consumer.
async function canonicalLateHostHistory({
  included = false, spawn = false, followup = true, delayThroughFollowup = false,
} = {}) {
  const thread = "late-host-history";
  const node = createNodeSpineRuntime({ thread, features: ["jit", "spawn"] });
  const branch = [];
  const messages = [];
  const history = new OmpSourceHistory(thread);
  const developer = { role: "developer", content: "DURABLE-HOST-INSTRUCTION", timestamp: 71 };
  const custom = { role: "custom", customType: "host-reminder", display: true,
    content: [{ type: "text", text: "DURABLE-CUSTOM-CONTEXT" }], timestamp: 72,
    details: { origin: "native-extension" } };
  const hostEntries = [messageEntry("developer", developer),
    { ...messageEntry("custom", custom), type: "custom_message" }];
  const host = {
    async claimOwnership() {},
    async appendCustomEntry(customType, data) { branch.push({ type: "custom", customType, data }); },
    async materializeContext() { return []; },
    async replaceContext() {},
  };
  try {
    const adapter = await createOmpSpineAdapter({ enabled: true, runtime: node.client, host });
    const admit = async (message) => {
      await adapter.observeSources([sourceObservation(message, messages.length).character]);
      messages.push(message);
    };
    const checkpoint = async () => {
      const snapshot = await adapter.sourceSnapshot();
      const saved = buildOmpSourceCheckpoint(snapshot, history, (id) => {
        const cell = snapshot.cells.find((cell) => cell.source_id.ordinal === id.ordinal);
        return ompNativeMessageKey(messages[cell.boundary]);
      });
      if (saved !== null) {
        branch.push({ type: "custom", customType: OMP_SOURCE_ENTRY_TYPE, data: saved });
        history.add(saved);
      }
    };
    const user = { role: "user", content: "INITIAL-HOST-REQUEST", timestamp: 69 };
    await admit(user);
    branch.push(messageEntry("user", user));
    await checkpoint();
    await adapter.beginSampling();
    const assistant = { role: "assistant", timestamp: 70,
      content: [{ type: "text", text: "HOST-CONTROL" },
        { type: "toolCall", id: "host-control", name: spawn ? "spine_spawn" : "spine_open", arguments: {} }] };
    await admit(assistant);
    branch.push(messageEntry("assistant", assistant), ...hostEntries);
    if (included) {
      await admit(developer);
      await admit(custom);
    }
    await checkpoint();
    await adapter.registerExecution("host-control");
    await adapter.stageExecution("host-control", "host-control",
      spawn ? spawnOperation : { type: "open", summary: "Handle native host context" });
    await adapter.finishExecution("host-control", true);
    await adapter.finishSampling("completed");
    if (!included && !delayThroughFollowup) {
      await admit(developer);
      await admit(custom);
    }
    if (followup) {
      await checkpoint();
      await adapter.beginSampling();
      const answer = { role: "assistant", timestamp: 73,
        content: [{ type: "text", text: "AFTER-HOST-INSTRUCTION" }] };
      await admit(answer);
      branch.push(messageEntry("followup", answer));
      await checkpoint();
      await adapter.finishSampling("completed");
    }
    if (delayThroughFollowup) {
      await admit(developer);
      await admit(custom);
    }
    const source = await adapter.sourceSnapshot();
    const context = await adapter.previewAndPublish();
    return { branch, messages, source, context, hostEntries };
  } finally {
    node.dispose();
  }
}

async function assertLateHostRecovery(fixture, plan) {
  await recoverPlan(plan, async (recovered, publications, archives) => {
    const expected = { ...fixture.source, thread: plan.currentThread };
    assert.deepEqual(recovered.source, expected);
    assert.deepEqual(recovered.source.cells.map((cell) => recovered.bindings.resolve(cell.source_id)),
      fixture.messages);
    assert.deepEqual(publications.at(-1).projection, fixture.context.projection);
    const restoredPlan = publications.at(-1).contextPlan;
    assert.equal(restoredPlan.thread, plan.currentThread, "fork context belongs to the active namespace");
    assert.deepEqual(restoredPlan.cells.filter((cell) => cell.type === "source"),
      fixture.context.contextPlan.cells.filter((cell) => cell.type === "source"),
      "fork retains the canonical producer identities of inherited source cells");
    assert.ok(restoredPlan.cells.filter((cell) => cell.type === "projection")
      .every((cell) => cell.projection_id.thread === plan.currentThread),
      "projection slots cannot alias another session namespace");
    const provider = publications.at(-1).messages;
    assert.ok(provider.some((message) => message.role === "developer" && message.content === "DURABLE-HOST-INSTRUCTION"));
    assert.ok(provider.some((message) => message.role === "custom"
      && message.customType === "host-reminder" && message.content[0].text === "DURABLE-CUSTOM-CONTEXT"));
    assert.deepEqual(archives, [], "recovery must not fabricate or repersist history");
  });
}

test("canonical checkpoints schedule late developer and custom sources after their excluded commit", async () => {
  for (const followup of [false, true]) {
    const fixture = await canonicalLateHostHistory({ followup });
    const original = structuredClone(fixture.branch);
    const plan = replayPlan(fixture.branch, fixture.messages, "late-host-history");
    const firstCommit = plan.inputs.findIndex((item) => item.type === "archive" && item.record.type === "sampling_commit");
    assert.deepEqual(plan.inputs.slice(firstCommit + 1, firstCommit + 3).map((item) => item.character),
      fixture.messages.slice(2, 4).map((message, index) => sourceObservation(message, index + 2).character));
    assert.deepEqual(plan.sources.map((source) => source.entryId),
      fixture.branch.filter((entry) => entry.message).map((entry) => entry.id));
    await assertLateHostRecovery(fixture, plan);
    assert.deepEqual(fixture.branch, original, "read-only recovery cannot edit the native journal");
  }
});

test("new checkpoints including host sources preserve native source order before commit", async () => {
  const fixture = await canonicalLateHostHistory({ included: true });
  const plan = replayPlan(fixture.branch, fixture.messages, "late-host-history");
  const firstCommit = plan.inputs.findIndex((item) => item.type === "archive" && item.record.type === "sampling_commit");
  assert.deepEqual(plan.inputs.slice(firstCommit - 3, firstCommit).map((item) => item.character),
    fixture.messages.slice(1, 4).map((message, index) => sourceObservation(message, index + 1).character));
  await assertLateHostRecovery(fixture, plan);
});

test("late host source scheduling requires genuine checkpoint identities and cannot reorder user sources", async () => {
  const fixture = await canonicalLateHostHistory({ followup: false });
  assert.throws(() => replayPlan(fixture.branch.filter((entry) => entry.customType !== OMP_SOURCE_ENTRY_TYPE)),
    /boundary is not the source tail/);
  const missing = fixture.branch.filter((entry) => entry.id !== "assistant");
  assert.throws(() => replayPlan(missing), /checkpoint|missing.*source/);
  const changed = structuredClone(fixture.branch);
  changed.find((entry) => entry.id === "assistant").message.timestamp += 100;
  assert.throws(() => replayPlan(changed), /identity does not match/);
  const changedCheckpoint = structuredClone(fixture.branch);
  changedCheckpoint.find((entry) => entry.customType === OMP_SOURCE_ENTRY_TYPE && entry.data.characters[0].boundary === 1)
    .data.nativeKeys[0] = "different-native-identity";
  assert.throws(() => replayPlan(changedCheckpoint), /identity does not match/);
  const unexpectedUser = structuredClone(fixture.branch);
  unexpectedUser.find((entry) => entry.id === "developer").message.role = "user";
  assert.throws(() => replayPlan(unexpectedUser), /boundary is not the source tail/);
  const included = await canonicalLateHostHistory({ included: true });
  const wrongHost = structuredClone(included.branch);
  wrongHost.find((entry) => entry.id === "developer").message.timestamp += 100;
  assert.throws(() => replayPlan(wrongHost), /checkpoint|missing.*source/);
});

test("late host messages and Spawn births retain live-tail occurrence counts", async () => {
  const fixture = await canonicalLateHostHistory({ spawn: true, followup: false });
  await assertLateHostRecovery(fixture, replayPlan(fixture.branch, fixture.messages, "late-host-history"));
  const missingAssistant = fixture.branch.filter((entry) => entry.id !== "assistant");
  const plan = replayPlan(missingAssistant,
    [fixture.messages[0], ...fixture.messages.slice(2), fixture.messages[1]], "late-host-history");
  assert.equal(plan.sources.length, fixture.messages.length);
  assert.equal(plan.sources[1].entryId, null);
  await assertLateHostRecovery(fixture, plan);
});

test("canonical late host scheduling respects fork lineage and reset source namespaces", async () => {
  const fixture = await canonicalLateHostHistory();
  const fork = replayPlan(fixture.branch, fixture.messages, "host-fork");
  assert.equal(fork.runtimeThread, "late-host-history");
  await assertLateHostRecovery(fixture, fork);
  const reset = replayPlan([
    ...fixture.branch, { type: "reset_boundary", id: "native-reset" },
    messageEntry("fresh", { role: "user", content: "FRESH-AFTER-RESET", timestamp: 90 }),
  ], undefined, "host-reset");
  await recoverPlan(reset, async (recovered) => {
    assert.equal(recovered.source.thread, "host-reset-reset-native-reset");
    assert.deepEqual(recovered.source.cells.map((cell) => recovered.bindings.resolve(cell.source_id).content),
      ["FRESH-AFTER-RESET"]);
  });
});

test("late host admission completes before compaction and cannot cross a compact epoch to repair missing sources", async () => {
  const fixture = await canonicalLateHostHistory({ followup: false });
  await recoverPlan(replayPlan(fixture.branch, undefined, "late-host-history"), async (recovered) => {
    const summary = { role: "compactionSummary", summary: "HOST-COMPACT-SUMMARY", tokensBefore: 20, timestamp: 91 };
    const replacementMessages = [summary, fixture.messages.at(-1)];
    const barrier = buildCompactBarrier(recovered.source, replacementMessages.length);
    await recovered.adapter.compact(barrier, {
      publish: false,
      metadata: { messages: replacementMessages, entryIds: [null, "custom"] },
    });
    const expected = await recovered.adapter.sourceSnapshot();
    const compact = { type: "custom", customType: OMP_COMPACT_ENTRY_TYPE, data: {
      schema: OMP_ADAPTER_ID, barrier, replacementMessages, replacementEntryIds: [null, "custom"],
    } };
    const acknowledgement = { type: "compaction", fromExtension: true, id: "native-compact" };
    await recoverPlan(replayPlan([...fixture.branch, compact, acknowledgement], undefined, "late-host-history"),
      async (restored) => {
        assert.deepEqual(restored.source, expected);
        assert.equal(restored.source.epoch, 1);
        assert.deepEqual(restored.source.cells.map((cell) => restored.bindings.resolve(cell.source_id)), replacementMessages);
      });
    const missing = fixture.branch.filter((entry) => entry.id !== "assistant");
    assert.throws(() => replayPlan([...missing, compact, acknowledgement]), /checkpoint|compact archive precedes/);
  });
});

test("a late host admission waits through consecutive canonical archives that exclude its identity", async () => {
  const fixture = await canonicalLateHostHistory({ delayThroughFollowup: true });
  const plan = replayPlan(fixture.branch, fixture.messages, "late-host-history");
  assert.deepEqual(plan.sources.map((source) => source.entryId), ["user", "assistant", "followup", "developer", "custom"]);
  const lastCommit = plan.inputs.findLastIndex((item) => item.type === "archive" && item.record.type === "sampling_commit");
  assert.deepEqual(plan.inputs.slice(lastCommit + 1).map((item) => item.character),
    fixture.messages.slice(-2).map((message, index) => sourceObservation(message, index + 3).character));
  await assertLateHostRecovery(fixture, plan);
});

test("post-assistant host suffix preserves a new occurrence identical to an older native source", async () => {
  const notice = { role: "custom", customType: "host-repeat", content: "REPEATED-HOST-SOURCE", display: false, timestamp: 8 };
  const reply = { role: "assistant", timestamp: 9, content: [{ type: "text", text: "Before another notification" }] };
  const plan = buildOmpReplayPlan({
    currentSessionId: "repeated-post-assistant", branch: [messageEntry("first-notice", notice), messageEntry("reply", reply)],
    messagesForEntry: (entry) => entry.message ? [entry.message] : [],
    extraMessages: [structuredClone(notice)],
  });
  await recoverPlan(plan, async (recovered) => {
    const bound = recovered.source.cells.map((cell) => recovered.bindings.resolve(cell.source_id));
    assert.deepEqual(bound, [notice, reply, notice]);
    assert.deepEqual(recovered.source.cells.map((cell) => cell.boundary), [0, 1, 2]);
  });
});
