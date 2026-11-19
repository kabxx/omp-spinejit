import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createNativeFixture, readJournal, spineCall, visibleText } from "./fixture.mjs";
import { assertFoldedMemory, assertPendingFold } from "./fold-assertions.mjs";

const bridge = new URL("./nativeownership.bridge.mjs", import.meta.url);
const competitor = new URL("./nativeownership-competitor.bridge.mjs", import.meta.url);
const defaultExtension = new URL("../../dist/omp/extension.js", import.meta.url);

async function inspect(rpc) {
  const start = rpc.frames.length;
  await rpc.prompt("/ownership-inspect");
  const frame = await rpc.event((item) => rpc.frames.indexOf(item) >= start
    && item.type === "extension_ui_request" && item.method === "notify"
    && typeof item.message === "string" && item.message.startsWith("OWNERSHIP-STATE:"), "public native ownership metadata");
  return JSON.parse(frame.message.slice("OWNERSHIP-STATE:".length));
}

async function assertRejected(fixture, rpc, expectedExtensions) {
  const state = await rpc.command("get_state");
  const result = await rpc.prompt("Open Spine work; ownership must reject before any model can answer.");
  assert.equal(result.status, "error", JSON.stringify(result));
  assert.equal(fixture.requests.length, 0, "Native ownership conflicts must never enter a provider");
  const ownership = await inspect(rpc);
  assert.equal(ownership.initialized, 0, "No Spine runtime or recovered memory was installed");
  for (const expected of expectedExtensions) {
    assert.ok(ownership.extensions.some((extension) => extension.path === fileURLToPath(expected) && extension.active));
  }
  const entries = await readJournal(state.sessionFile);
  const faults = entries.filter((entry) => entry.customType === "spine.fault.v1");
  assert.ok(faults.length > 0, "Conflict must be explicitly recorded, not silently ignore an instance");
  assert.equal(entries.filter((entry) => entry.type === "custom" && entry.customType.startsWith("spine.") && entry.customType !== "spine.fault.v1").length, 0,
    "Rejected composition must not install Spine operations or Source/compact memory");
  assert.equal(entries.filter((entry) => entry.type === "compaction").length, 0);
  await rpc.close();
}

for (const hook of ["context", "session_before_compact"]) {
  for (const order of ["first", "last"]) {
    test(`native ownership: competing ${hook} loaded ${order} rejects before provider and memory installation`, { timeout: 180_000 }, async (t) => {
      const fixture = await createNativeFixture(t, {
        label: `ownership-${hook}-${order}`, bridge: order === "first" ? competitor : bridge,
        onRequest() { assert.fail("A conflicting native composition entered the model provider"); },
      });
      const rpc = await fixture.start({
        env: { OMP_OWNERSHIP_HOOK: hook },
        args: ["--extension", fileURLToPath(order === "first" ? bridge : competitor)],
      });
      await assertRejected(fixture, rpc, [bridge, competitor]);
    });
  }
}

test("native ownership: two activations within one extension explicitly reject both instances", { timeout: 180_000 }, async (t) => {
  const fixture = await createNativeFixture(t, {
    label: "ownership-duplicate-composed", bridge,
    onRequest() { assert.fail("Duplicate Spine instances entered the model provider"); },
  });
  const rpc = await fixture.start({ env: { OMP_OWNERSHIP_DUPLICATE: "true" } });
  await assertRejected(fixture, rpc, [bridge]);
});

test("native ownership: independently loaded Spine extensions cannot silently override each other", { timeout: 180_000 }, async (t) => {
  const fixture = await createNativeFixture(t, {
    label: "ownership-duplicate-modules", bridge,
    onRequest() { assert.fail("Independent Spine owners entered the model provider"); },
  });
  const rpc = await fixture.start({ args: ["--extension", fileURLToPath(defaultExtension)] });
  await assertRejected(fixture, rpc, [bridge, defaultExtension]);
});

for (const order of ["first", "last"]) {
  test(`native ownership: competing compaction loaded ${order} cancels real compact before either summary installs`, { timeout: 180_000 }, async (t) => {
    const fixture = await createNativeFixture(t, {
      label: `ownership-compact-cancel-${order}`, bridge,
      onRequest(request, { index, send }) {
        if (index === 1) send(spineCall("spine_open", { goal: "OWNERSHIP-BEFORE-CONFLICT" }));
        else if (index === 2) {
          assert.ok(visibleText(request.messages).includes('summary="OWNERSHIP-BEFORE-CONFLICT"'));
          send("OWNERSHIP-BEFORE-CONFLICT-READY");
        } else assert.fail("A conflicting compact entered the real summary provider");
      },
    });
    let rpc = await fixture.start();
    const state = await rpc.command("get_state");
    assert.equal((await rpc.prompt("Seed a real live owner before changing the extension composition.")).status, "completed");
    await rpc.close();
    const before = await readJournal(state.sessionFile);
    const archives = before.filter((entry) => entry.customType === "spine.archive.v1").map((entry) => entry.id);
    assert.ok(archives.length > 0);
    if (order === "first") {
      fixture.invocation.args[fixture.invocation.args.indexOf("--extension") + 1] = fileURLToPath(competitor);
    }
    rpc = await fixture.restart(state.sessionFile, {
      env: { OMP_OWNERSHIP_HOOK: "session_before_compact" },
      args: ["--extension", fileURLToPath(order === "first" ? bridge : competitor)],
    });
    assert.equal((await inspect(rpc)).initialized, 0);
    const id = `ownership-cancelled-compact-${order}`;
    const response = rpc.event((frame) => frame.type === "response" && frame.id === id, "native cancelled compact");
    rpc.send({ id, type: "compact", customInstructions: "Do not mix competing compaction providers." });
    assert.equal((await response).success, false, "Native must reject, not accept either extension's compaction");
    assert.equal(fixture.requests.length, 2, "The rejected composition never calls a summary model");
    const after = await readJournal(state.sessionFile);
    assert.deepEqual(after.filter((entry) => entry.customType === "spine.archive.v1").map((entry) => entry.id), archives);
    assert.equal(after.filter((entry) => entry.customType === "spine.compact.v1" || entry.type === "compaction").length, 0);
    await rpc.close();
  });
}

for (const composed of [false, true]) {
  test(`native ownership: ${composed ? "same-extension observers and public session reload" : "default packaged extension"} preserve compaction and physical restart`, { timeout: 180_000 }, async (t) => {
    const summary = "OWNERSHIP-NATIVE-SUMMARY: preserve the original constraint and continue unfinished work.";
    const owner = "OWNERSHIP-ORIGINAL-OWNER";
    const nextOwner = "OWNERSHIP-NEW-EPOCH-OWNER";
    let stage = "open";
    let summaryCalls = 0;
    const fixture = await createNativeFixture(t, {
      label: composed ? "ownership-observers-reload" : "ownership-default", ...(composed ? { bridge } : {}),
      onRequest(request, { send }) {
        const text = visibleText(request.messages);
        if (visibleText(request.messages.at(-1)).includes("Create a concise structured continuation summary")) {
          assert.equal(++summaryCalls, 1);
          assert.ok(text.includes(owner) && text.includes("OWNERSHIP-CONSTRAINT"));
          send(summary);
          return;
        }
        if (stage === "open") { stage = "opened"; send(spineCall("spine_open", { goal: owner })); }
        else if (stage === "opened") {
          assert.ok(text.includes(`summary="${owner}"`));
          stage = "ready"; send("OWNERSHIP-OPENED");
        } else if (stage === "reload") {
          assert.ok(text.includes(`summary="${owner}"`));
          stage = "ready"; send("OWNERSHIP-RELOAD-HEALTHY");
        } else if (stage === "fresh") {
          assert.ok(text.includes(summary));
          stage = "fresh-opened"; send(spineCall("spine_open", { goal: nextOwner }));
        } else if (stage === "fresh-opened") {
          assert.ok(text.includes(`summary="${nextOwner}"`));
          stage = "ready"; send("OWNERSHIP-FRESH-OPENED");
        } else if (stage === "close") {
          assert.ok(text.includes(summary) && text.includes(`summary="${nextOwner}"`));
          stage = "closed"; send(spineCall("spine_close", { memory: "OWNERSHIP-RESTART-MEMORY" }));
        } else if (stage === "closed") {
          assertPendingFold(request, "2.1", "OWNERSHIP-RESTART-MEMORY");
          stage = "recall"; send("OWNERSHIP-CLOSE-ACKNOWLEDGED");
        } else if (stage === "recall") {
          assertFoldedMemory(request, "2.1", "OWNERSHIP-RESTART-MEMORY");
          stage = "done"; send("OWNERSHIP-RESTART-COMPLETE");
        } else assert.fail(`Unexpected native ownership request in ${stage}: ${text}`);
      },
    });
    let rpc = await fixture.start();
    const state = await rpc.command("get_state");
    assert.equal((await rpc.prompt("OWNERSHIP-CONSTRAINT: open and retain unfinished work.")).status, "completed");
    if (composed) {
      const before = await inspect(rpc);
      assert.equal(before.initialized, 1);
      assert.ok(before.contextObservations > 0);
      await rpc.prompt("/ownership-reload");
      const after = await inspect(rpc);
      assert.equal(after.sessionId, before.sessionId);
      assert.equal(after.initialized, 2, "Reload must recover once and replace the old gate, not retain a stale claim");
      stage = "reload";
      assert.equal((await rpc.prompt("Continue after native session reload without changing the owner.")).status, "completed");
    }
    const compact = await rpc.command("compact", { customInstructions: "Preserve OWNERSHIP-CONSTRAINT and unfinished work." });
    assert.equal(compact.summary, summary);
    assert.equal(summaryCalls, 1);
    if (composed) assert.ok((await inspect(rpc)).compactObservations > 0);
    stage = "fresh";
    assert.equal((await rpc.prompt("Open fresh work in the compacted Source epoch.")).status, "completed");
    await rpc.close();
    rpc = await fixture.restart(state.sessionFile);
    assert.equal((await rpc.command("get_state")).sessionId, state.sessionId);
    stage = "close";
    assert.equal((await rpc.prompt("Close the physically recovered unfinished owner.")).status, "completed");
    assert.equal((await rpc.prompt("Verify the folded memory in the compacted epoch.")).status, "completed");
    const entries = await readJournal(state.sessionFile);
    assert.equal(entries.filter((entry) => entry.customType === "spine.fault.v1").length, 0);
    const compactions = entries.filter((entry) => entry.type === "compaction");
    assert.equal(compactions.length, 1);
    assert.equal(compactions[0].details?.["spine.compact.v1"]?.replacementMessages[0]?.summary, summary);
    await rpc.close();
  });
}
