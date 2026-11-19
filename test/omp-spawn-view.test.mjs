import assert from "node:assert/strict";
import test from "node:test";
import {
  applySpawnTerminal,
  createSpawnBatchView,
  describeSpawnResult,
  renderSpawnResult,
  settleSpawnView,
  spawnModelText,
} from "../dist/omp/spawn-view.js";

const theme = { fg: (_token, value) => value, bold: (value) => value };

function nativeText(node) {
  if (!node) return "";
  if (Array.isArray(node)) return node.map(nativeText).join("\n");
  const own = node.p?.text ?? node.p?.spans?.map((span) => span.t).join("") ?? "";
  return [own, nativeText(node.c)].filter(Boolean).join("\n");
}

function bothSurfaces(view, expanded) {
  return [
    renderSpawnResult(view, expanded, theme).render(120).join("\n"),
    nativeText(describeSpawnResult(view, expanded).body),
  ];
}

test("Spawn keeps each child's current state inline, with terminal memory only on expansion", () => {
  const view = createSpawnBatchView([
    { summary: "Inspect the protocol", prompt: "protocol" },
    { summary: "Inspect the UI", prompt: "ui" },
  ]);
  applySpawnTerminal(view, 0, { outcome: "completed", memory: "Protocol memory" });
  // The same details survive persistence; no live callback or process handle is required to read them.
  const restored = JSON.parse(JSON.stringify(view));
  for (const output of bothSurfaces(restored, false)) {
    assert.match(output, /✓.*Inspect the protocol/);
    assert.match(output, /◐.*Inspect the UI/);
    assert.doesNotMatch(output, /Protocol memory/);
  }
  for (const output of bothSurfaces(restored, true)) {
    assert.match(output, /Protocol memory/);
    assert.match(output, /◐.*Inspect the UI/);
  }
});

test("Spawn failure/cancellation settles unfinished rows without overwriting completed siblings", () => {
  const view = createSpawnBatchView([
    { summary: "Finished sibling", prompt: "done" },
    { summary: "Interrupted sibling", prompt: "wait" },
  ]);
  applySpawnTerminal(view, 0, { outcome: "completed", memory: "Keep this result" });
  for (const outcome of ["errored", "aborted"]) {
    const settled = settleSpawnView(view, outcome, "The child was interrupted");
    for (const output of bothSurfaces(settled, true)) {
      assert.match(output, /✓.*Finished sibling/);
      assert.match(output, outcome === "errored" ? /×.*Interrupted sibling/ : /!.*Interrupted sibling/);
      assert.match(output, /Keep this result/);
      assert.match(output, /The child was interrupted/);
      assert.doesNotMatch(output, /◐/);
    }
  }
  assert.equal(view.tasks[1].status, "running", "Presentation must not rewrite durable runtime state");
});

test("Spawn expansion shows bounded terminal detail and the failure diagnostic rather than a stale memory", () => {
  const view = createSpawnBatchView([
    { summary: "Detailed child", prompt: "details" },
    { summary: "Failed child", prompt: "failure" },
  ]);
  applySpawnTerminal(view, 0, { outcome: "completed", memory: "one\ntwo\nthree\nfour\nfive hidden" });
  applySpawnTerminal(view, 1, { outcome: "errored", memory: "stale partial memory", diagnostic: "Provider denied this child" });
  assert.equal(view.tasks[1].memoryBody, null);
  for (const output of bothSurfaces(view, true)) {
    assert.match(output, /four/);
    assert.doesNotMatch(output, /five hidden|stale partial memory/);
    assert.match(output, /Provider denied this child/);
  }
});

test("Spawn model text counts only successful children while peers still run", () => {
  const view = createSpawnBatchView(["success", "failure", "running"].map((summary) => ({ summary, prompt: summary })));
  applySpawnTerminal(view, 0, { outcome: "completed", memory: "finished" });
  applySpawnTerminal(view, 1, { outcome: "errored", diagnostic: "failed" });
  assert.equal(spawnModelText(view), "Spine Spawn 1/3 completed");
});
