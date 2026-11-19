import assert from "node:assert/strict";
import test from "node:test";

import { createNodeSpineRuntime } from "@spinejit/spine-sdk/node";

import { spineToolRefusal, spineToolResult } from "@spinejit/spine-sdk/host";
import { isControlToolName } from "../dist/omp/control-cursor.js";

async function commit(runtime, key, operation, boundary) {
  const staged = await stage(runtime, key, operation, boundary);
  await runtime.client.execute({ type: "finish_execution", key, succeeded: true });
  const prepared = await runtime.client.execute({ type: "prepare_finish", terminal: "completed" });
  const installed = await runtime.client.execute({
    type: "install_prepared",
    transaction_id: prepared.transaction_id,
  });
  return { staged, committed: installed.projection };
}

async function stage(runtime, key, operation, boundary) {
  await runtime.client.execute({ type: "begin_sampling" });
  await runtime.client.execute({
    type: "observe_sources",
    characters: [{ type: "message", boundary, role: "assistant", content: key }],
  });
  await runtime.client.execute({ type: "register_execution", key });
  await runtime.client.execute({
    type: "stage_execution",
    key,
    execution_ref: key,
    operation,
  });
  return (await runtime.client.execute({ type: "preview" })).projection;
}

test("SDK controls describe the committed effect even though the staged cursor has not moved", async () => {
  const runtime = createNodeSpineRuntime({ thread: "cursor-probe", features: ["jit", "spawn"] });
  try {
    await runtime.client.execute({
      type: "observe_sources",
      characters: [{ type: "message", boundary: 0, role: "user", content: "hi" }],
    });
    let boundary = 1;

    const openA = await commit(runtime, "open-a", { type: "open", summary: "a" }, boundary++);
    assert.equal(openA.staged.cursor.join("."), "1");
    assert.deepEqual(openA.committed.cursor, [1, 1]);
    assert.match(spineToolResult(openA.staged, "spine_open", { goal: "a" }, "node prompt"),
      /<spine_node id="1\.1" summary="a" status="opened">\nnode prompt/);

    const openB = await commit(runtime, "open-b", { type: "open", summary: "b" }, boundary++);
    assert.equal(openB.staged.cursor.join("."), "1.1");
    assert.deepEqual(openB.committed.cursor, [1, 1, 1]);

    const nextNested = await commit(
      runtime,
      "next-nested",
      { type: "next", closed_memory: "b done", next_summary: "b successor" },
      boundary++,
    );
    assert.deepEqual(nextNested.staged.cursor, [1, 1, 1]);
    assert.deepEqual(nextNested.committed.cursor, [1, 1, 2]);
    assert.match(spineToolResult(nextNested.staged, "spine_next", { memory: "b done", goal: "b successor" }, ""),
      /Node 1\.1\.1 is closed.*\n\n<spine_node id="1\.1\.2" summary="b successor"/);

    const closeB = await commit(runtime, "close-b", { type: "close", memory: "nested done" }, boundary++);
    assert.equal(closeB.staged.cursor.join("."), "1.1.2");
    assert.deepEqual(closeB.committed.cursor, [1, 1]);
    assert.match(spineToolResult(closeB.staged, "spine_close", { memory: "nested done" }, ""), /back in node 1\.1/);

    const nextC = await commit(
      runtime,
      "next-c",
      { type: "next", closed_memory: "a done", next_summary: "c" },
      boundary++,
    );
    assert.equal(nextC.staged.cursor.join("."), "1.1");
    assert.deepEqual(nextC.committed.cursor, [1, 2]);
    assert.match(spineToolResult(nextC.staged, "spine_next", { memory: "a done", goal: "c" }, ""), /id="1\.2"/);

    const closeC = await commit(runtime, "close-c", { type: "close", memory: "c done" }, boundary++);
    assert.equal(closeC.staged.cursor.join("."), "1.2");
    assert.deepEqual(closeC.committed.cursor, [1]);
    assert.match(spineToolResult(closeC.staged, "spine_close", { memory: "c done" }, ""), /back at the root/);
    assert.match(spineToolRefusal(closeC.staged, "spine_close", new Set(), null, 2), /only tool call/);
    assert.match(spineToolRefusal(closeC.committed, "spine_close", new Set(), null, 1), /at the root/);
  } finally {
    runtime.dispose();
  }
});

test("only cursor-changing tools are classified as OMP controls", () => {
  for (const name of ["spine_open", "spine_close", "spine_next"]) assert.equal(isControlToolName(name), true);
  for (const name of ["spine_spawn", "spine_child_return", "write"]) assert.equal(isControlToolName(name), false);
});
