import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createNativeFixture, spineCall, visibleText, readJournal } from "./fixture.mjs";

for (const withSpine of [false, true]) {
  test(`native automatic compaction preserves default todo work and finishes without another user prompt ${withSpine ? "with Spine" : "without extensions"}`, { timeout: 180_000 }, async (t) => {
    const first = "Write the first actual output before compaction";
    const second = "Write the remaining actual output after compaction";
    const summary = `COMPACT-TODO-SUMMARY: ${first} is completed; ${second} remains in progress. Continue and finish the actual second output.`;
    const finished = "COMPACT-TODO-ALL-WORK-FINISHED";
    let agentStep = 0;
    const fixture = await createNativeFixture(t, {
      label: `auto-compaction-todo-${withSpine ? "spine" : "native"}`,
      ...(withSpine ? {} : { bridge: false }),
      model: { contextWindow: 131072, maxTokens: 4096 },
      settings: {
        todo: { enabled: true, reminders: true, remindersMax: 1 },
        compaction: {
          enabled: true, thresholdPercent: 75, thresholdTokens: -1, modelThresholds: {},
          reserveTokens: 8192, keepRecentTokens: 128, methodOrder: ["soft"],
          autoContinue: true, asyncEnabled: false, midTurnEnabled: false,
          supersedeReads: false, dropUseless: false,
        },
        contextPromotion: { enabled: false },
      },
      onRequest(request, { send }) {
        const text = visibleText(request.messages);
        if (!request.tools?.length || visibleText(request.messages.at(-1)).startsWith("Create a concise structured continuation summary")) {
          assert.ok(text.includes(first) && text.includes(second));
          return send(summary, { inputTokens: 800, outputTokens: 80 });
        }
        switch (++agentStep) {
          case 1: return send([
            ...(withSpine ? [spineCall("spine_open", { goal: "Complete both actual outputs" })] : []),
            spineCall("todo", { op: "init", items: [first, second] }),
          ]);
          case 2: return send([
            { name: "write", arguments: { i: "Writing actual first task output", path: "before-compact.txt", content: first } },
            spineCall("todo", { op: "done", task: first }),
          ]);
          case 3: return send("The first output exists; the second output is still unfinished.", { inputTokens: 100352, outputTokens: 20 });
          case 4: {
            assert.ok(text.includes("COMPACT-TODO-SUMMARY"), "Automatic continuation must consume the actual compacted context");
            return send([
              ...(withSpine ? [spineCall("spine_open", { goal: "Finish the remaining output after compaction" })] : []),
              { name: "write", arguments: { i: "Writing actual remaining task output", path: "after-compact.txt", content: second } },
              spineCall("todo", { op: "done", task: second }),
            ]);
          }
          case 5: return send(withSpine ? spineCall("spine_close", { memory: finished }) : finished);
          case 6:
            assert.ok(withSpine);
            assert.ok(text.includes(finished));
            return send(finished);
          default: assert.fail(`Unexpected automatic todo continuation step ${agentStep}`);
        }
      },
    });
    let rpc;
    try {
      rpc = await fixture.start({ autoCompaction: true });
      assert.equal((await rpc.prompt("Complete both actual output files; do not stop after the progress update.")).status, "completed");
      const end = await rpc.event((frame) => frame.type === "auto_compaction_end", "actual automatic compaction");
      assert.equal(end.aborted, false);
      const afterCompaction = await rpc.command("get_state");
      assert.deepEqual(afterCompaction.todoPhases.flatMap((phase) => phase.tasks).map((task) => task.content), [first, second],
        "Successful compaction must not erase the task list before native continuation can run");
      await rpc.event((frame) => frame.type === "message_end" && frame.message?.role === "assistant"
        && visibleText(frame.message) === finished, "actual completion without another user prompt");
      const state = await rpc.command("get_state");
      assert.deepEqual(state.todoPhases.flatMap((phase) => phase.tasks).map((task) => [task.content, task.status]),
        [[first, "completed"], [second, "completed"]]);
      assert.equal(await readFile(join(fixture.workspace, "before-compact.txt"), "utf8"), first);
      assert.equal(await readFile(join(fixture.workspace, "after-compact.txt"), "utf8"), second);
      const rows = await readJournal(state.sessionFile);
      assert.equal(rows.filter((row) => row.type === "compaction").length, 1);
      assert.equal(rows.filter((row) => row.type === "custom" && row.customType === "spine.fault.v1").length, 0);
      assert.equal(rows.filter((row) => row.message?.role === "user" && visibleText(row.message)
        === "Complete both actual output files; do not stop after the progress update.").length, 1);
      await rpc.close();
      rpc = await fixture.restart(state.sessionFile);
      assert.deepEqual((await rpc.command("get_state")).todoPhases, state.todoPhases);
      await rpc.close();
    } finally {
      if (rpc && !rpc.closing) await rpc.close();
    }
  });
}
