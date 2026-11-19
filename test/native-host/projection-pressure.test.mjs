import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import test from 'node:test';
import { createNativeFixture, readJournal, spineCall, visibleText } from './fixture.mjs';

const bridge = new URL('./projection-pressure.bridge.mjs', import.meta.url);
const threshold = 50000;
const largeArchive = 'archived alpha beta gamma delta epsilon zeta eta theta iota kappa lambda\n'.repeat(6000);
const summary = 'PROJECTED-PRESSURE-SUMMARY: preserve the root constraint and continue current work.';
const settings = {
  startup: { setupWizard: false, showSplash: false, checkUpdate: false },
  compaction: { enabled: true, thresholdTokens: threshold, thresholdPercent: -1, modelThresholds: {},
    reserveTokens: 4096, keepRecentTokens: 1, methodOrder: ['soft'], autoContinue: false,
    asyncEnabled: false, midTurnEnabled: true, supersedeReads: false, dropUseless: false },
  contextPromotion: { enabled: false },
};
async function inspect(rpc) {
  const start = rpc.frames.length;
  await rpc.prompt('/pressure-inspect');
  const frame = await rpc.event((item) => rpc.frames.indexOf(item) >= start
    && item.type === 'extension_ui_request' && item.method === 'notify'
    && item.message?.startsWith('PRESSURE-STATE:'), 'native projection token counts');
  return JSON.parse(frame.message.slice('PRESSURE-STATE:'.length));
}
function compactStarts(rpc) { return rpc.frames.filter((frame) => frame.type === 'auto_compaction_start'); }
function assertHealthy(rows) {
  assert.deepEqual(rows.filter((row) => row.customType === 'spine.fault.v1'), []);
}

test('native Spine pressure excludes closed raw history at pre-prompt, midrun, post-turn and unanchored restart, but still compacts high usage', { timeout: 180000 }, async (t) => {
  let phase = 'seed', step = 0, summaries = 0;
  const fixture = await createNativeFixture(t, {
    label: 'projection-pressure', bridge, settings,
    onRequest(request, { send }) {
      const text = visibleText(request.messages);
      const isSummary = visibleText(request.messages.at(-1)).includes('Create a concise structured continuation summary');
      if (isSummary) {
        assert.equal(phase, 'high', 'Raw archive size must not request a summary while actual context is small');
        summaries++;
        return send(summary, { inputTokens: 1000, outputTokens: 40 });
      }
      if (phase === 'seed') {
        switch (step++) {
          case 0: return send(spineCall('spine_open', { goal: 'ARCHIVE-HEAVY-CLOSED-WORK' }), { inputTokens: 1000 });
          case 1: return send({ name: 'write', arguments: { i: 'Writing isolated archived work', path: 'archive.txt', content: largeArchive } }, { inputTokens: 1000 });
          case 2: return send(spineCall('spine_close', { memory: 'ARCHIVE-HEAVY-WORK-COMPLETE' }), { inputTokens: 1000 });
          case 3: return send('SEED-CLOSED', { inputTokens: 1000 });
          default: assert.fail('Unexpected seed continuation');
        }
      }
      assert.ok(!text.includes(largeArchive.slice(0, 1000)), 'Closed work body must not be sent to the model');
      if (phase === 'low') {
        if (step++ === 0) return send({ name: 'write', arguments: { i: 'Exercising low pressure tool loop', path: 'current.txt', content: 'small current work' } }, { inputTokens: 1000 });
        return send('LOW-PRESSURE-COMPLETE', { inputTokens: 1000 });
      }
      if (phase === 'cold') return send('UNANCHORED-RESTART-COMPLETE', { inputTokens: 1000 });
      assert.equal(phase, 'high');
      return send('REAL-USAGE-PRESSURE', { inputTokens: threshold + 10000 });
    },
  });
  let rpc = await fixture.start();
  assert.equal((await rpc.prompt('Keep the root constraint. Complete the archive-heavy branch in this turn.')).status, 'completed');
  const seeded = await inspect(rpc);
  assert.ok(seeded.rawTokens > threshold, JSON.stringify(seeded));
  assert.ok(seeded.projectedTokens < threshold / 2, JSON.stringify(seeded));
  await rpc.command('set_auto_compaction', { enabled: true });
  phase = 'low'; step = 0;
  assert.equal((await rpc.prompt('Next small user request: write one small result.')).status, 'completed');
  assert.equal(compactStarts(rpc).length, 0);
  assert.equal(summaries, 0);
  await rpc.close();

  // Imported histories can lack usable provider counters. Only private test
  // metadata changes; source text, identities, archives and ownership stay intact.
  const rows = await readJournal(seeded.sessionFile);
  assertHealthy(rows);
  for (const row of rows) {
    if (row.message?.role !== 'assistant') continue;
    row.message.usage = { ...row.message.usage, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
    delete row.message.contextSnapshot;
  }
  await writeFile(seeded.sessionFile, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  phase = 'cold';
  rpc = await fixture.restart(seeded.sessionFile, { autoCompaction: true });
  const cold = await inspect(rpc);
  assert.equal(cold.anchored, false);
  assert.ok(cold.rawTokens > threshold && cold.projectedTokens < threshold / 2, JSON.stringify(cold));
  assert.equal((await rpc.prompt('Continue with a small answer after imported usage metadata.')).status, 'completed');
  assert.equal(compactStarts(rpc).length, 0);
  phase = 'high';
  assert.equal((await rpc.prompt('Report genuine provider context pressure.')).status, 'completed');
  const compact = await rpc.event((frame) => frame.type === 'auto_compaction_end', 'usage-driven native compaction');
  assert.equal(compact.aborted, false);
  assert.equal(compact.result.summary, summary);
  assert.equal(summaries, 1);
  assert.equal(compactStarts(rpc).length, 1);
  const after = await readJournal(seeded.sessionFile);
  assertHealthy(after);
  assert.equal(after.filter((row) => row.type === 'compaction' && row.fromExtension === true).length, 1);
  assert.equal(after.filter((row) => row.customType === 'spine.compact.v1').length, 1);
  await rpc.close();
});

test('native sessions without a context owner retain the stored-history floor despite low provider usage', { timeout: 180000 }, async (t) => {
  let phase = 'seed', step = 0, pressureRequests = 0;
  const fixture = await createNativeFixture(t, {
    label: 'native-history-floor', bridge, settings,
    onRequest(_request, { send }) {
      if (phase === 'seed') {
        if (step++ === 0) return send({ name: 'write', arguments: { i: 'Writing native history pressure', path: 'native-archive.txt', content: largeArchive } }, { inputTokens: 1000 });
        return send('NATIVE-SEED-COMPLETE', { inputTokens: 1000 });
      }
      pressureRequests++;
      return send(pressureRequests === 1 ? 'NATIVE-HISTORY-SUMMARY: continue the small request.' : 'NATIVE-AFTER-COMPACT', { inputTokens: 1000 });
    },
  });
  const rpc = await fixture.start({ env: { OMP_PRESSURE_NATIVE_ONLY: '1' } });
  assert.equal((await rpc.prompt('Write the large native history.')).status, 'completed');
  const state = await inspect(rpc);
  assert.ok(state.rawTokens > threshold, JSON.stringify(state));
  assert.equal(state.projectedTokens, null);
  await rpc.command('set_auto_compaction', { enabled: true });
  phase = 'pressure';
  assert.equal((await rpc.prompt('Now answer one small request.')).status, 'completed');
  const compact = await rpc.event((frame) => frame.type === 'auto_compaction_end', 'preserved native history floor');
  assert.equal(compact.aborted, false);
  assert.equal(compactStarts(rpc).length, 1);
  const rows = await readJournal(state.sessionFile);
  assert.equal(rows.filter((row) => row.type === 'compaction' && row.fromExtension !== true).length, 1);
  await rpc.close();
});

test('registered projection owner exceptions cancel automatic compaction without native fallback', { timeout: 120000 }, async (t) => {
  let recovering = false;
  const fixture = await createNativeFixture(t, {
    label: 'projection-owner-failure', bridge, settings,
    onRequest(request, { send, index }) {
      if (recovering) {
        assert.ok(visibleText(request.messages).includes('summary="Preserve the owner on summary failure"'));
        assert.ok(visibleText(request.messages).includes('Preserve this constraint'));
        return send('OWNER-FAILURE-RECOVERED', { inputTokens: 1000 });
      }
      if (index === 1) return send(spineCall('spine_open', { goal: 'Preserve the owner on summary failure' }), { inputTokens: 1000 });
      assert.equal(index, 2, 'Failed owner must not start an unowned summary or another main request');
      return send('OWNER-FAILURE-PRESSURE', { inputTokens: threshold + 10000 });
    },
  });
  const rpc = await fixture.start({ autoCompaction: true, env: { OMP_PRESSURE_SUMMARY_ERROR: '1' } });
  await rpc.prompt('Preserve this constraint if the compaction owner fails.');
  const end = await rpc.event((frame) => frame.type === 'auto_compaction_end', 'failed owner settlement');
  assert.equal(end.aborted, true);
  assert.equal(end.result, undefined);
  const state = await rpc.command('get_state');
  const rows = await readJournal(state.sessionFile);
  assert.equal(rows.filter((row) => row.type === 'compaction' || row.customType === 'spine.compact.v1').length, 0);
  await rpc.command('set_auto_compaction', { enabled: false });
  recovering = true;
  assert.equal((await rpc.prompt('Continue the preserved owner after the failed summary.')).status, 'completed');
  await rpc.close();
});
