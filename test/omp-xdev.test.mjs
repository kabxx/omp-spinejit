import assert from "node:assert/strict";
import test from "node:test";

import { decodeHostToolCall, decodeHostToolResult } from "../dist/omp/xdev.js";

test("write xd://spine_open JSON body becomes spine_open", () => {
  assert.deepEqual(
    decodeHostToolCall("write", {
      path: "xd://spine_open",
      content: JSON.stringify({ goal: "demo child" }),
    }),
    { toolName: "spine_open", input: { goal: "demo child" } },
  );
});

test("write xd://spine_spawn object body is passed through", () => {
  const tasks = [{ summary: "a", prompt: "p" }, { summary: "b", prompt: "q" }];
  assert.deepEqual(
    decodeHostToolCall("write", { path: "xd://spine_spawn", content: { tasks } }),
    { toolName: "spine_spawn", input: { tasks } },
  );
});

test("plain write is unchanged", () => {
  assert.deepEqual(
    decodeHostToolCall("write", { path: "/tmp/a.txt", content: "hi" }),
    { toolName: "write", input: { path: "/tmp/a.txt", content: "hi" } },
  );
});

test("native spine tool name is unchanged", () => {
  assert.deepEqual(
    decodeHostToolCall("spine_close", { memory: "done" }),
    { toolName: "spine_close", input: { memory: "done" } },
  );
});

test("toolResult details.xdev.tool is the Spine name", () => {
  assert.equal(
    decodeHostToolResult("write", { xdev: { tool: "spine_spawn", args: { tasks: [] } } }),
    "spine_spawn",
  );
});

test("the retired child return device is not routed as Spine", () => {
  const input = { path: "xd://spine_child_return", content: "{\"memory\":\"old\"}" };
  assert.deepEqual(decodeHostToolCall("write", input), { toolName: "write", input });
  assert.equal(decodeHostToolResult("write", { xdev: { tool: "spine_child_return" } }), "write");
});
