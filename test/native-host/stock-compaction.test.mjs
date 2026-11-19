import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createNativeFixture, readJournal, visibleText } from './fixture.mjs';

const summary = 'STOCK-SUMMARY: preserve the first constraint and carry on.';
const body = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda '.repeat(3000);
const isSummary = (request) => visibleText(request.messages.at(-1)).includes('Create a concise structured continuation summary');

test('official OMP compacts projected pressure before the next request and restores the committed summary after restart', { timeout: 30_000 }, async (t) => {
  let turn = 0;
  let summaries = 0;
  const fixture = await createNativeFixture(t, {
    label: 'stock-spine-pressure', model: { contextWindow: 64000 },
    settings: { compaction: { enabled: true, thresholdPercent: 99 } },
    async onRequest(request, { send }) {
      if (isSummary(request)) {
        summaries++;
        await delay(1900);
        return send(summary);
      }
      if (++turn === 1) return send('FIRST-TURN-ALREADY-COMPLETE');
      if (turn === 2) return send('SECOND-TURN-ALREADY-COMPLETE');
      assert.ok(visibleText(request.messages).includes(summary));
      assert.ok(!visibleText(request.messages).includes(body.slice(0, 500)), 'old context is replaced, not merely acknowledged');
      send('RESTARTED-WITH-SUMMARY');
    },
  });
  let rpc = await fixture.start({ autoCompaction: false });
  const path = (await rpc.command('get_state')).sessionFile;
  assert.equal((await rpc.prompt(`FIRST-CONSTRAINT ${body}`)).status, 'completed');
  assert.equal((await rpc.command('get_state')).autoCompactionEnabled, false);
  await rpc.command('set_auto_compaction', { enabled: true });
  assert.equal((await rpc.command('get_state')).autoCompactionEnabled, true);
  // The second user turn makes a previous whole turn eligible for eviction.
  assert.equal((await rpc.prompt('SECOND-TURN')).status, 'completed');
  await rpc.event((event) => event.type === 'manual_compaction_end' && event.result?.summary === summary, 'Spine scheduled compaction');
  await rpc.close();
  const rows = await readJournal(path);
  assert.equal(rows.filter((entry) => entry.type === 'compaction').length, 1);
  const compact = rows.find((entry) => entry.type === 'compaction');
  const receipt = compact.details?.['spine.compact.v1'];
  assert.equal(receipt?.preparedLeafId, compact.parentId);
  assert.equal(summaries, 1);
  assert.equal(turn, 2, 'Both ordinary turns must run before compaction');
  rpc = await fixture.restart(path, { autoCompaction: null });
  assert.equal((await rpc.prompt('AFTER-RESTART')).status, 'completed');
  assert.deepEqual((await readJournal(path)).filter((entry) => entry.customType === 'spine.fault.v1'), []);
  await rpc.close();

  // Turn the same genuine archive into a separate two-record legacy journal.
  // Keep the native compaction ID so subsequent source bindings are unchanged.
  const { preparedLeafId, ...legacyReceipt } = receipt;
  const { details, ...ack } = compact;
  const legacyId = 'legacy-compact-receipt';
  const legacyPath = `${path.slice(0, -6)}-legacy.jsonl`;
  await writeFile(legacyPath, rows.flatMap((row) => row !== compact ? [row] : [
    { type: 'custom', customType: 'spine.compact.v1', id: legacyId, parentId: row.parentId, timestamp: row.timestamp, data: legacyReceipt },
    { ...ack, parentId: legacyId },
  ]).map((row) => JSON.stringify(row)).join('\n') + '\n');
  rpc = await fixture.restart(legacyPath, { autoCompaction: false });
  assert.equal((await rpc.prompt('AFTER-LEGACY-RESTART')).status, 'completed');
  await rpc.close();
  assert.deepEqual((await readJournal(legacyPath)).filter((entry) => entry.customType === 'spine.fault.v1'), []);
  assert.equal(summaries, 1, 'Neither persisted format requests another summary during restart');
});

test('official OMP defers a slow manual summary without performing a native fallback', { timeout: 20_000 }, async (t) => {
  let calls = 0;
  const fixture = await createNativeFixture(t, {
    label: 'stock-spine-defer',
    async onRequest(request, { send }) {
      if (isSummary(request)) {
        calls++;
        assert.match(visibleText(request.messages.at(-1)), /FOCUS-TEST/);
        await delay(1950);
        return send(summary);
      }
      assert.ok(visibleText(request.messages).includes('SEED'));
      return send('SEED-ANSWER');
    },
  });
  const rpc = await fixture.start();
  const path = (await rpc.command('get_state')).sessionFile;
  assert.equal((await rpc.prompt('SEED')).status, 'completed');
  await assert.rejects(rpc.command('compact', { customInstructions: 'FOCUS-TEST' }), /cancel/i);
  assert.equal((await readJournal(path)).some((entry) => entry.type === 'compaction'), false);
  await rpc.event((event) => event.type === 'manual_compaction_end' && event.result?.summary === summary, 'deferred manual completion');
  assert.equal(calls, 1);
  assert.equal((await readJournal(path)).filter((entry) => entry.type === 'compaction' && entry.fromExtension).length, 1);
  await rpc.close();
});
