import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createNativeFixture, readJournal, spineCall, visibleText } from "./fixture.mjs";

for (const midTurn of [false, true]) {
  test(
    `native Spine compaction owner can finish past the observer deadline without native fallback or fault (${midTurn ? "mid-turn" : "post-turn"})`,
    { timeout: 180_000 },
    async (t) => {
      const summary =
        "SLOW-OWNER-SUMMARY: Continue the unfinished real output after safely committing the compact barrier.";
      let summaryCalls = 0;
      let step = 0;
      const fixture = await createNativeFixture(t, {
        label: `slow-compaction-owner-${midTurn ? "mid-turn" : "post-turn"}`,
        model: { contextWindow: 131072, maxTokens: 4096 },
        settings: {
          compaction: {
            enabled: true,
            thresholdPercent: 75,
            thresholdTokens: -1,
            modelThresholds: {},
            reserveTokens: 8192,
            keepRecentTokens: 128,
            methodOrder: ["snapcompact", "soft"],
            autoContinue: false,
            asyncEnabled: false,
            midTurnEnabled: midTurn,
          },
          contextPromotion: { enabled: false },
        },
        async onRequest(request, { send }) {
          const text = visibleText(request.messages);
          if (
            !request.tools?.length ||
            visibleText(request.messages.at(-1)).startsWith(
              "Create a concise structured continuation summary",
            )
          ) {
            assert.equal(
              ++summaryCalls,
              1,
              "The native host must not start a second summary after abandoning its owner",
            );
            // Deliberately cross the real child process's former 30-second deadline;
            // parent fake timers cannot exercise that native platform-clock race.
            await new Promise((resolve) => setTimeout(resolve, 32_000));
            return send(summary, { inputTokens: 800, outputTokens: 80 });
          }
          switch (++step) {
            case 1:
              return send(
                spineCall("spine_open", {
                  goal: "Finish the output across slow automatic compaction",
                }),
              );
            case 2:
              return send(
                midTurn
                  ? spineCall("spine_open", {
                      goal: "Continue the same turn across slow compaction",
                    })
                  : "Work remains unfinished; the summary must not bypass its owner.",
                { inputTokens: 100352, outputTokens: 20 },
              );
            case 3:
              assert.ok(
                text.includes("SLOW-OWNER-SUMMARY"),
                "The continued work must consume the actual owner summary",
              );
              return send([
                spineCall("spine_open", { goal: "Complete output after slow compaction" }),
                {
                  name: "write",
                  arguments: {
                    i: "Writing actual post-compaction output",
                    path: "slow-owner-output.txt",
                    content: "SLOW-OWNER-OUTPUT",
                  },
                },
              ]);
            case 4:
              return send(spineCall("spine_close", { memory: "SLOW-OWNER-COMPLETE" }));
            case 5:
              return send("SLOW-OWNER-COMPLETE");
            case 6:
              return send(
                spineCall("spine_open", { goal: "Verify the physically resumed compacted owner" }),
              );
            case 7:
              return send(spineCall("spine_close", { memory: "SLOW-OWNER-RESTART-COMPLETE" }));
            case 8:
              return send("SLOW-OWNER-RESTART-COMPLETE");
            default:
              assert.fail(`Unexpected slow-owner continuation ${step}`);
          }
        },
      });
      let rpc;
      try {
        rpc = await fixture.start({ autoCompaction: true });
        assert.equal(
          (
            await rpc.prompt(
              "Do the work across the automatic compaction and keep its durable state consistent.",
            )
          ).status,
          "completed",
        );
        const end = await rpc.event(
          (frame) => frame.type === "auto_compaction_end",
          "real slow automatic compaction",
        );
        assert.equal(end.aborted, false);
        const state = await rpc.command("get_state");
        const rows = await readJournal(state.sessionFile);
        assert.equal(
          rows.filter((row) => row.type === "custom" && row.customType === "spine.fault.v1").length,
          0,
        );
        assert.equal(
          rows.filter((row) => row.type === "custom" && row.customType === "spine.compact.v1")
            .length,
          1,
        );
        const native = rows.filter((row) => row.type === "compaction");
        assert.equal(native.length, 1);
        assert.equal(
          native[0].fromExtension,
          true,
          "Even the snapcompact preference must acknowledge the actual owner",
        );
        assert.equal(native[0].summary, summary);
        if (!midTurn) {
          assert.equal(
            (await rpc.prompt("Complete the actual output in the safely compacted epoch.")).status,
            "completed",
          );
        }
        assert.equal(
          await readFile(join(fixture.workspace, "slow-owner-output.txt"), "utf8"),
          "SLOW-OWNER-OUTPUT",
        );
        await rpc.close();
        rpc = await fixture.restart(state.sessionFile);
        const restored = await rpc.command("get_state");
        const restoredRows = await readJournal(restored.sessionFile);
        assert.equal(
          restoredRows.filter((row) => row.type === "custom" && row.customType === "spine.fault.v1")
            .length,
          0,
        );
        assert.equal(
          await readFile(join(fixture.workspace, "slow-owner-output.txt"), "utf8"),
          "SLOW-OWNER-OUTPUT",
        );
        assert.equal(
          (await rpc.prompt("Exercise actual Spine Open/Close after physical restart.")).status,
          "completed",
        );
        const afterRestart = await readJournal(restored.sessionFile);
        assert.equal(afterRestart.filter((row) => row.customType === "spine.fault.v1").length, 0);
        assert.equal(
          afterRestart.filter((row) => row.type === "compaction").length,
          1,
          "Resume must not compact twice",
        );
        await rpc.close();
      } finally {
        if (rpc && !rpc.closing) await rpc.close();
      }
    },
  );
}
