import assert from "node:assert/strict";
import test from "node:test";

import {
  extractOmpArrival,
  isOmpSourceMessage,
  ompArrivalMessage,
  ompNativeMessageKey,
  sourceObservation,
  SPINE_ARRIVAL_CUSTOM_TYPE,
  SPINE_ARRIVAL_WAKE_CUSTOM_TYPE,
  isOmpSpineProjection,
  OMP_PROJECTION_SCHEMA,
  materializeOmpContext,
  OmpSourceBindings,
} from "../dist/omp/index.js";
import { projectOmpSession } from "../dist/omp/host-projection.js";

const SOURCE_ID = { thread: "omp-session", epoch: 0, ordinal: 0 };

function context(cells) {
  return {
    transactionId: "preview:plan-1",
    contextPlan: {
      schema: "spine.context.plan.v2",
      thread: "omp-session",
      epoch: 0,
      source_snapshot_digest: "source",
      cells,
      plan_digest: "plan-1",
    },
    projection: { nodes: [], cursor: [0], visible_context: [], last_boundary: 0 },
  };
}

test("omp user anchors prefix the bound user message", () => {
  const bindings = new OmpSourceBindings();
  const original = { role: "user", content: "request", timestamp: 42 };
  bindings.bind(SOURCE_ID, original);
  assert.deepEqual(
    materializeOmpContext(
      context([{ type: "source", source_id: SOURCE_ID, labels: [{ UserAnchor: 3 }] }]),
      bindings,
    ),
    [{ role: "user", content: "[U3]\nrequest", timestamp: 42 }],
  );
  assert.deepEqual(original, { role: "user", content: "request", timestamp: 42 });
});

test("omp user anchors recover the bound user when host projection swapped a non-user", () => {
  const bindings = new OmpSourceBindings();
  const original = { role: "user", content: "spawn试试，做点加法就行", timestamp: 3 };
  bindings.bind(SOURCE_ID, original, "u3");
  const projected = new Map([
    ["u3", [{
      role: "assistant",
      content: [{ type: "text", text: "host replaced the user turn" }],
      timestamp: 4,
    }]],
  ]);
  assert.deepEqual(
    materializeOmpContext(
      context([{ type: "source", source_id: SOURCE_ID, labels: [{ UserAnchor: 3 }] }]),
      bindings,
      { projectedMessages: projected },
    ),
    [{ role: "user", content: "[U3]\nspawn试试，做点加法就行", timestamp: 3 }],
  );
});

test("omp user anchors skip a non-user source instead of faulting publish", () => {
  const bindings = new OmpSourceBindings();
  const original = {
    role: "assistant",
    content: [{ type: "text", text: "not a user" }],
    timestamp: 1,
  };
  bindings.bind(SOURCE_ID, original);
  assert.deepEqual(
    materializeOmpContext(
      context([{ type: "source", source_id: SOURCE_ID, labels: [{ UserAnchor: 3 }] }]),
      bindings,
    ),
    [original],
  );
});

test("omp user anchors skip a projected toolResult instead of throwing", () => {
  const bindings = new OmpSourceBindings();
  bindings.bind(SOURCE_ID, {
    role: "toolResult",
    toolCallId: "c1",
    toolName: "write",
    content: [{ type: "text", text: "spine_open done" }],
    isError: false,
    timestamp: 2,
  }, "t1");
  const projected = new Map([
    ["t1", [{
      role: "toolResult",
      toolCallId: "c1",
      toolName: "write",
      content: [{ type: "text", text: "spine_open done" }],
      isError: false,
      timestamp: 2,
    }]],
  ]);
  const messages = materializeOmpContext(
    context([{ type: "source", source_id: SOURCE_ID, labels: [{ UserAnchor: 3 }] }]),
    bindings,
    { projectedMessages: projected },
  );
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, "toolResult");
});

test("omp user anchors recover a bound user when host projection swapped a toolResult", () => {
  const bindings = new OmpSourceBindings();
  const original = { role: "user", content: "spawn试试", timestamp: 3 };
  bindings.bind(SOURCE_ID, original, "u3");
  const projected = new Map([
    ["u3", [{
      role: "toolResult",
      toolCallId: "c1",
      toolName: "write",
      content: [{ type: "text", text: "spine_open done" }],
      isError: false,
      timestamp: 4,
    }]],
  ]);
  assert.deepEqual(
    materializeOmpContext(
      context([{ type: "source", source_id: SOURCE_ID, labels: [{ UserAnchor: 3 }] }]),
      bindings,
      { projectedMessages: projected },
    ),
    [{ role: "user", content: "[U3]\nspawn试试", timestamp: 3 }],
  );
});

test("OMP projection classification does not grant Pi metadata the native projection role", () => {
  const projection = {
    role: "custom", customType: "spine.node", content: "projection body", display: false, timestamp: 1,
    details: { schema: OMP_PROJECTION_SCHEMA, kind: "node", nodeId: "0", renderer: "xml" },
  };
  assert.equal(isOmpSpineProjection(projection, "spine.node"), true);
  assert.equal(isOmpSpineProjection({
    ...projection, details: { ...projection.details, schema: "spine.pi.projection/v1" },
  }, "spine.node"), false);
  assert.equal(isOmpSpineProjection(projection, "spine.memory"), false);
});

test("a durable arrival survives the native kept range with its entry id and a typed Source", () => {
  const timestamp = "2026-01-01T00:00:00.000Z";
  const arrival = { producer: [1, 2], outcome: "completed", memory: "work complete", execution_ref: "child-session" };
  const entry = { type: "custom", id: "arrival", parentId: null, timestamp, customType: SPINE_ARRIVAL_CUSTOM_TYPE, data: arrival };
  assert.deepEqual(extractOmpArrival(entry), arrival);
  assert.throws(() => extractOmpArrival({ ...entry, data: { producer: [1, -1], outcome: "completed" } }), /Malformed durable OMP Spawn arrival/);
  const projection = projectOmpSession([entry]);
  const [message] = projection.messages;
  assert.deepEqual(projection.entries, [{ sourceEntry: entry, messages: [message] }]);
  assert.deepEqual(projection.generatedMessages, []);
  assert.match(message.content, /<spine_arrival node_id="1\.2" outcome="completed">\nwork complete/);
  assert.equal(isOmpSourceMessage(message), true);
  assert.equal(isOmpSourceMessage({ ...message, customType: SPINE_ARRIVAL_WAKE_CUSTOM_TYPE }), false);
  assert.deepEqual(sourceObservation(message, 3).character, { type: "arrival", boundary: 3, arrival });
  assert.equal(ompNativeMessageKey(message), ompNativeMessageKey(ompArrivalMessage(arrival, 12)));
  const reset = { type: "reset_boundary", id: "reset", parentId: "arrival", timestamp };
  assert.deepEqual(projectOmpSession([entry, reset]).entries[0].messages, []);
});

test("Birth is only a descriptor; Spawn assignment is not repeated to the parent", () => {
  const task = { summary: "job", prompt: "private assignment" };
  const item = { MemorySlot: { Birth: { owner_node: [1, 2], source: { start: 1, end: 1 }, task } } };
  const [message] = materializeOmpContext(context([{ type: "projection", projection_id: SOURCE_ID, item }]), new OmpSourceBindings());
  assert.match(message.content, /<spine_spawn node_id="1\.2" summary="job">/);
  assert.doesNotMatch(message.content, /private assignment/);
  assert.equal(isOmpSourceMessage(message), false);
});

for (const api of ["openai-responses", "google-generative-ai"]) {
  test(`Fold applies reasoning and call identity policy for ${api}`, () => {
    const bindings = new OmpSourceBindings();
    const replyId = { ...SOURCE_ID, ordinal: 1 };
    const assistant = {
      role: "assistant", api, timestamp: 7, providerPayload: { opaque: "old-prefix" },
      content: [
        { type: "thinking", thinking: "private", thinkingSignature: "signature" },
        { type: "redactedThinking", data: "opaque" },
        { type: "text", text: "said", textSignature: "signed-text" },
        { type: "toolCall", id: "call|item", name: "read", arguments: {}, thoughtSignature: "signed-call" },
      ],
    };
    const reply = { role: "toolResult", toolName: "read", toolCallId: "call|item", content: [], isError: false, timestamp: 8 };
    bindings.bind(SOURCE_ID, assistant, "assistant");
    bindings.bind(replyId, reply, "result");
    const plan = context([
      { type: "source", source_id: SOURCE_ID, labels: ["WithoutReasoning"] },
      { type: "source", source_id: replyId, labels: [] },
    ]);
    const [output, result] = materializeOmpContext(plan, bindings);
    if (api.startsWith("google-")) {
      assert.deepEqual(output, assistant);
      assert.deepEqual(result, reply);
    } else {
      assert.deepEqual(output.content, [
        { type: "text", text: "said" },
        { type: "toolCall", id: "call", name: "read", arguments: {} },
      ]);
      assert.equal(output.providerPayload, undefined);
      assert.equal(result.toolCallId, "call");
      assert.equal(ompNativeMessageKey(output), ompNativeMessageKey(assistant));
    }
    assert.deepEqual(bindings.resolve(SOURCE_ID), assistant);
  });
}
