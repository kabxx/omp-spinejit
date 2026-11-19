import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { sep } from 'node:path';
import test from 'node:test';
import { createNativeFixture, readJournal, spineCall, visibleText } from './fixture.mjs';

const bridge = new URL('./usage-pressure.bridge.mjs', import.meta.url);
const threshold = 50000;
const lowUsage = { inputTokens: 1000, outputTokens: 20 };
const zeroUsage = { inputTokens: 0, outputTokens: 0 };
const largeVisible = 'LIVE-PRESSURE-BEGIN\n' + 'visible alpha beta gamma delta epsilon zeta eta theta iota kappa lambda\n'.repeat(6000) + 'LIVE-PRESSURE-END';
const owner = 'USAGE-PRESSURE-LIVE-OWNER';
const summary = 'USAGE-PRESSURE-SUMMARY: preserve the constraint and continue the current owner.';
const settings = {
  startup: { setupWizard: false, showSplash: false, checkUpdate: false },
  compaction: { enabled: true, thresholdTokens: threshold, thresholdPercent: -1, modelThresholds: {},
    reserveTokens: 4096, keepRecentTokens: 1, methodOrder: ['soft'], autoContinue: false,
    asyncEnabled: false, midTurnEnabled: true, supersedeReads: false, dropUseless: false },
  contextPromotion: { enabled: false },
};

function isSummary(request) {
  return visibleText(request.messages.at(-1)).includes('Create a concise structured continuation summary');
}
function starts(rpc) { return rpc.frames.filter((frame) => frame.type === 'auto_compaction_start'); }
function completed(result) { assert.equal(result.status, 'completed', JSON.stringify(result)); }
function healthy(rows) { assert.deepEqual(rows.filter((row) => row.customType === 'spine.fault.v1'), []); }
function assertLargeRequest(request) {
  assert.ok(visibleText(request.messages).includes(largeVisible), 'The entire large live body, not just an archive marker, must actually reach the model');
}
async function inspect(rpc, options = {}) {
  const offset = rpc.frames.length;
  await rpc.prompt('/usage-pressure-inspect ' + JSON.stringify(options));
  const frame = await rpc.event((item) => rpc.frames.indexOf(item) >= offset
    && item.type === 'extension_ui_request' && item.method === 'notify'
    && item.message?.startsWith('USAGE-PRESSURE-STATE:'), 'actual owned usage-pressure projection');
  return JSON.parse(frame.message.slice('USAGE-PRESSURE-STATE:'.length));
}
function assertLargeProjection(state) {
  assert.ok(state.projectedTokens > threshold, JSON.stringify(state));
  assert.ok(state.projectedTextLength >= largeVisible.length, JSON.stringify(state));
  assert.equal(state.markerVisible, true);
}
async function successfulCompact(rpc) {
  const end = await rpc.event((frame) => frame.type === 'auto_compaction_end', 'successful owned automatic compaction');
  assert.equal(end.aborted, false, JSON.stringify(end));
  assert.equal(end.result.summary, summary);
  return end;
}
async function assertOneDurableCompact(path) {
  const rows = await readJournal(path);
  healthy(rows);
  assert.equal(rows.filter((row) => row.type === 'compaction' && row.fromExtension === true).length, 1);
  assert.equal(rows.filter((row) => row.customType === 'spine.compact.v1').length, 1);
  return rows;
}

// The large user text remains in an OPEN owner. Closing an archive-heavy branch
// would only exercise projection filtering and cannot distinguish usage from max.
test('native Spine trusts fresh low usage over a genuinely large live projection, including tool turns and an older anchor behind zero usage', { timeout: 180000 }, async (t) => {
  let phase = 'seed', step = 0;
  const fixture = await createNativeFixture(t, {
    label: 'usage-priority-live', bridge, settings,
    onRequest(request, { send }) {
      assert.equal(isSummary(request), false, 'Valid low usage must not summarize merely because the full local projection is large');
      assertLargeRequest(request);
      if (phase === 'seed') {
        if (step++ === 0) return send(spineCall('spine_open', { goal: owner }), lowUsage);
        return send('FRESH-LOW-USAGE-ANCHOR', lowUsage);
      }
      assert.ok(visibleText(request.messages).includes(owner));
      if (phase === 'tool') {
        if (step++ === 0) return send({ name: 'write', arguments: {
          i: 'Writing isolated usage proof', path: 'usage-proof.txt', content: 'LIVE-LOW-USAGE-TOOL-RESULT',
        } }, lowUsage);
        assert.ok(JSON.stringify(request.messages).includes('LIVE-LOW-USAGE-TOOL-RESULT'), 'Actual continuation must consume the live tool exchange');
        return send('LOW-USAGE-TOOL-COMPLETE', lowUsage);
      }
      if (phase === 'zero') return send('LATEST-ALL-ZERO-USAGE', zeroUsage);
      assert.equal(phase, 'older');
      assert.ok(visibleText(request.messages).includes('LATEST-ALL-ZERO-USAGE'));
      return send('OLDER-VALID-ANCHOR-COMPLETE', lowUsage);
    },
  });
  const rpc = await fixture.start({ autoCompaction: false });
  completed(await rpc.prompt('Keep this live evidence and open the requested owner.\n' + largeVisible));
  const seeded = await inspect(rpc, { marker: largeVisible });
  assertLargeProjection(seeded);
  assert.equal(seeded.assistants.at(-1).text, 'FRESH-LOW-USAGE-ANCHOR');
  assert.equal(seeded.assistants.at(-1).usage.input, lowUsage.inputTokens);
  assert.equal(starts(rpc).length, 0);

  await rpc.command('set_auto_compaction', { enabled: true });
  phase = 'tool'; step = 0;
  completed(await rpc.prompt('Write one small result without closing the live owner.'));
  assert.ok(step >= 2, 'Exercise actual native midrun continuation, not only a final answer');
  assert.equal(starts(rpc).length, 0, 'Neither small pending input, midrun nor post-turn may use a full-projection floor');
  phase = 'zero';
  completed(await rpc.prompt('Return an all-zero provider usage sample.'));
  const zero = await inspect(rpc, { marker: largeVisible });
  assertLargeProjection(zero);
  assert.equal(zero.assistants.at(-1).text, 'LATEST-ALL-ZERO-USAGE');
  assert.equal(zero.assistants.at(-1).usage.totalTokens, 0);
  assert.ok(zero.assistants.slice(0, -1).some((message) => message.usage?.input === lowUsage.inputTokens));
  phase = 'older';
  completed(await rpc.prompt('Continue a small request using the earlier valid context anchor.'));
  assert.equal(starts(rpc).length, 0, 'Latest zero usage must search backwards, not fall back to the large full estimate');
  const rows = await readJournal(seeded.sessionFile);
  healthy(rows);
  assert.equal(rows.filter((row) => row.type === 'compaction' || row.customType === 'spine.compact.v1').length, 0);
  await rpc.close();
});

test('native Spine estimates the real large projection when a private imported journal has no valid provider usage', { timeout: 180000 }, async (t) => {
  let phase = 'seed', step = 0, summaries = 0, continued = false;
  const fixture = await createNativeFixture(t, {
    label: 'usage-unanchored-fallback', bridge, settings,
    onRequest(request, { send }) {
      if (phase === 'seed') {
        assert.equal(isSummary(request), false);
        assertLargeRequest(request);
        if (step++ === 0) return send(spineCall('spine_open', { goal: owner }), lowUsage);
        return send('IMPORT-SEED-LOW-ANCHOR', lowUsage);
      }
      if (isSummary(request)) {
        assertLargeRequest(request);
        summaries++;
        return send(summary, lowUsage);
      }
      assert.ok(summaries > 0, 'No valid anchor must compact the large projection before the next main inference');
      assert.ok(visibleText(request.messages).includes(summary));
      continued = true;
      return send('UNANCHORED-FALLBACK-COMPLETE', lowUsage);
    },
  });
  let rpc = await fixture.start({ autoCompaction: false });
  completed(await rpc.prompt('Keep this evidence live while opening the owner.\n' + largeVisible));
  const seeded = await inspect(rpc, { marker: largeVisible });
  assertLargeProjection(seeded);
  await rpc.close();

  // Edit only the fixture's isolated journal, never user sessions or Spine Source.
  assert.ok(seeded.sessionFile.startsWith(fixture.root + sep), 'Counter mutation is restricted to this private fixture');
  const rows = await readJournal(seeded.sessionFile);
  healthy(rows);
  let cleared = 0;
  for (const row of rows) {
    if (row.message?.role !== 'assistant') continue;
    row.message.usage = { ...row.message.usage, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
    delete row.message.usage.contextTokens;
    delete row.message.contextSnapshot;
    cleared++;
  }
  assert.ok(cleared > 0);
  await writeFile(seeded.sessionFile, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  phase = 'cold';
  rpc = await fixture.restart(seeded.sessionFile, { autoCompaction: true });
  const restored = await inspect(rpc, { marker: largeVisible });
  assertLargeProjection(restored);
  assert.ok(restored.assistants.length > 0);
  assert.ok(restored.assistants.every((message) => message.usage?.totalTokens === 0), 'Projection must really have no surviving valid usage anchor');
  completed(await rpc.prompt('Answer one small request after importing the counter-free journal.'));
  await successfulCompact(rpc);
  assert.equal(continued, true);
  assert.equal(summaries, 1);
  assert.equal(starts(rpc).length, 1);
  await assertOneDurableCompact(seeded.sessionFile);
  await rpc.close();
});

test('native Spine adds large newly visible pending input to low provider usage and compacts before main inference', { timeout: 180000 }, async (t) => {
  let phase = 'seed', step = 0, summaries = 0, continued = false;
  const fixture = await createNativeFixture(t, {
    label: 'usage-pending-delta', bridge, settings,
    onRequest(request, { send }) {
      if (phase === 'seed') {
        assert.equal(isSummary(request), false);
        if (step++ === 0) return send(spineCall('spine_open', { goal: owner }), lowUsage);
        return send('SMALL-PENDING-BASELINE', lowUsage);
      }
      if (isSummary(request)) {
        assert.ok(visibleText(request.messages).includes(owner), 'Summary must use the actual owned history');
        summaries++;
        return send(summary, lowUsage);
      }
      assert.ok(summaries > 0, 'The pending delta must cause compaction before the large main inference');
      assertLargeRequest(request);
      assert.ok(visibleText(request.messages).includes(summary));
      continued = true;
      return send('LARGE-PENDING-DELTA-COMPLETE', lowUsage);
    },
  });
  const rpc = await fixture.start({ autoCompaction: false });
  completed(await rpc.prompt('Open a small live owner and preserve its constraint.'));
  const before = await inspect(rpc);
  assert.ok(before.projectedTokens < threshold / 2, JSON.stringify(before));
  assert.equal(before.assistants.at(-1).usage.input, lowUsage.inputTokens);
  const pending = 'Use the following newly supplied live evidence.\n' + largeVisible;
  const withPending = await inspect(rpc, { pending, marker: largeVisible });
  assertLargeProjection(withPending);
  await rpc.command('set_auto_compaction', { enabled: true });
  phase = 'pending';
  completed(await rpc.prompt(pending));
  await successfulCompact(rpc);
  assert.equal(continued, true);
  assert.equal(summaries, 1);
  assert.equal(starts(rpc).length, 1);
  await assertOneDurableCompact(before.sessionFile);
  await rpc.close();
});

test('native Spine compacts high valid usage, then cold restart ignores that kept stale usage without an intervening model sample', { timeout: 180000 }, async (t) => {
  const pressureAnswer = 'HIGH-USAGE-KEPT-ASSISTANT';
  const highInput = threshold + 10000;
  let phase = 'seed', step = 0, summaries = 0;
  const fixture = await createNativeFixture(t, {
    label: 'usage-compact-restart', bridge, settings,
    onRequest(request, { send }) {
      if (isSummary(request)) {
        assert.equal(phase, 'high', 'Cold restart must not reuse the retained pre-compaction high usage');
        const text = visibleText(request.messages);
        assert.ok(text.includes(owner));
        assert.ok(text.includes(pressureAnswer));
        summaries++;
        return send(summary, lowUsage);
      }
      if (phase === 'seed') {
        if (step++ === 0) return send(spineCall('spine_open', { goal: owner }), lowUsage);
        return send('SMALL-HIGH-USAGE-BASELINE', lowUsage);
      }
      if (phase === 'high') return send(pressureAnswer, { inputTokens: highInput, outputTokens: 20 });
      assert.equal(phase, 'cold');
      assert.ok(visibleText(request.messages).includes(summary), 'Physical restart must send the durable real summary');
      assert.ok(visibleText(request.messages).includes(pressureAnswer), 'The dangerous stale assistant is genuinely kept and model-visible');
      return send('POST-COMPACTION-COLD-RESTART-COMPLETE', lowUsage);
    },
  });
  let rpc = await fixture.start({ autoCompaction: false });
  completed(await rpc.prompt('Preserve the constraint and open a small owner.'));
  const seeded = await inspect(rpc);
  assert.ok(seeded.projectedTokens < threshold / 2, JSON.stringify(seeded));
  await rpc.command('set_auto_compaction', { enabled: true });
  phase = 'high';
  completed(await rpc.prompt('Report genuinely high provider context usage in one final answer.'));
  await successfulCompact(rpc);
  assert.equal(starts(rpc).length, 1);
  assert.equal(summaries, 1);
  await assertOneDurableCompact(seeded.sessionFile);
  const compacted = await inspect(rpc);
  assert.ok(compacted.projectedTokens < threshold / 2, JSON.stringify(compacted));
  assert.ok(compacted.assistants.some((message) => message.text === pressureAnswer && message.usage?.input === highInput),
    'This regression requires retained stale high usage, not a fixture that drops every old assistant');
  const requestsBeforeRestart = fixture.requests.length;
  await rpc.close();

  phase = 'cold';
  rpc = await fixture.restart(seeded.sessionFile, { autoCompaction: true });
  const cold = await inspect(rpc);
  assert.equal(cold.sessionId, seeded.sessionId);
  assert.equal(fixture.requests.length, requestsBeforeRestart, 'Restart and inspection must not create a fresh sample that masks stale usage');
  assert.ok(cold.projectedTokens < threshold / 2, JSON.stringify(cold));
  assert.ok(cold.assistants.some((message) => message.text === pressureAnswer && message.usage?.input === highInput));
  completed(await rpc.prompt('Continue one small request immediately after cold restart.'));
  assert.equal(starts(rpc).length, 0, 'A persisted native compaction boundary must invalidate retained pre-compaction usage');
  assert.equal(summaries, 1);
  await assertOneDurableCompact(seeded.sessionFile);
  await rpc.close();
});
