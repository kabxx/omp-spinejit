import assert from 'node:assert/strict';
import test from 'node:test';
import { createNativeFixture, readJournal, spineCall, visibleText } from './fixture.mjs';
import { assertFoldedMemory, assertPendingFold } from './fold-assertions.mjs';

const bridge = new URL('./combinations.bridge.mjs', import.meta.url);
const pressureTokens = 100_352;
const compactionSettings = {
  compaction: { enabled: true, thresholdPercent: 75, thresholdTokens: -1, modelThresholds: {},
    reserveTokens: 8192, keepRecentTokens: 128, methodOrder: ['soft'], autoContinue: false,
    asyncEnabled: false, midTurnEnabled: false, supersedeReads: false, dropUseless: false },
  contextPromotion: { enabled: false },
};
let serial = 0;

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function completed(result) { assert.equal(result.status, 'completed', JSON.stringify(result)); }
async function call(rpc, action, fields = {}) {
  const token = `combo-${++serial}`;
  completed(await rpc.prompt(`/native-combination ${JSON.stringify({ action, token, ...fields })}`));
  const event = await rpc.event((frame) => frame.type === 'extension_ui_request' && frame.method === 'notify'
    && frame.message?.startsWith('COMBO-RESULT:')
    && JSON.parse(frame.message.slice('COMBO-RESULT:'.length)).token === token, action);
  return JSON.parse(event.message.slice('COMBO-RESULT:'.length));
}
async function inspect(rpc) { return (await call(rpc, 'inspect')).snapshot; }
function healthy(rows) { assert.equal(rows.filter((row) => row.customType === 'spine.fault.v1').length, 0); }
function identities(source) {
  assert.ok(source.thread);
  const ids = new Set();
  let boundary = -1;
  const ordinals = new Map();
  for (const cell of source.cells) {
    assert.ok(cell.boundary > boundary, 'Source boundaries must retain strict canonical order');
    boundary = cell.boundary;
    assert.equal(cell.source_id.epoch, source.epoch);
    const id = JSON.stringify(cell.source_id);
    assert.ok(!ids.has(id), 'One native producer must not acquire duplicate Source identity');
    ids.add(id);
    const previous = ordinals.get(cell.source_id.thread) ?? -1;
    assert.ok(cell.source_id.ordinal > previous, 'Source ordinals must increase within their producer namespace');
    ordinals.set(cell.source_id.thread, cell.source_id.ordinal);
  }
}
function once(source, marker) {
  const cells = source.cells.filter((cell) => cell.item.Message?.message.content === marker);
  assert.equal(cells.length, 1, `Exactly one canonical Source for ${marker}`);
  return cells[0];
}
function absent(text, markers) { for (const marker of markers) assert.ok(!text.includes(marker), `Leaked obsolete context: ${marker}`); }
function commits(rows) { return rows.filter((row) => row.customType === 'spine.archive.v1' && row.data.record.type === 'sampling_commit'); }
async function holdNextCommit(rpc) {
  const armed = await call(rpc, 'hold-commit');
  assert.equal(armed.armed, true);
  return armed.token;
}
async function releasePressureObserver(rpc, token) {
  await rpc.event((frame) => frame.type === 'extension_ui_request' && frame.message === `COMBO-COMMIT-HELD:${token}`, 'pressure sampling observer');
  await rpc.event((frame) => frame.type === 'auto_compaction_start', 'threshold maintenance');
  assert.equal((await call(rpc, 'release-commit', { text: token })).released, true);
}

test('native retry then automatic compact then reset creates a fresh Root without leaking old memory on restart', { timeout: 180_000 }, async (t) => {
  const failed = 'COMBO-RETRY-PRIVATE-THINKING';
  const old = ['COMBO-OLD-CONSTRAINT', 'COMBO-OLD-CLOSED', 'COMBO-OLD-LIVE', 'COMBO-OLD-MEMORY', 'COMBO-OLD-SUMMARY', failed];
  const fixture = await createNativeFixture(t, {
    label: 'combo-retry-compact-reset', bridge,
    model: { contextWindow: 131072, maxTokens: 4096, reasoning: true },
    settings: { ...compactionSettings, retry: { enabled: true, maxRetries: 1, baseDelayMs: 25,
      maxDelayMs: 60_000, modelFallback: false, usageAwareFallback: false } },
    onRequest(request, { index, send }) {
      const text = visibleText(request.messages);
      switch (index) {
        case 1: return send(spineCall('spine_open', { goal: 'COMBO-OLD-CLOSED' }));
        case 2: return send(spineCall('spine_next', { memory: 'COMBO-OLD-MEMORY', goal: 'COMBO-OLD-LIVE' }));
        case 3: return send('COMBO-OLD-READY');
        case 4:
          assert.match(text, /COMBO-OLD-LIVE/);
          return send('', { reasoningText: failed, streamError: { message: '503 service unavailable', status: 503,
            type: 'server_error', code: 'service_unavailable' } });
        case 5:
          absent(JSON.stringify(request.messages), [failed]);
          assert.match(text, /COMBO-OLD-MEMORY/);
          return send('COMBO-RETRY-RECOVERED');
        case 6: return send('COMBO-PRESSURE', { inputTokens: pressureTokens });
        case 7:
          assert.match(text, /COMBO-OLD-CONSTRAINT/);
          assert.match(text, /COMBO-OLD-MEMORY/);
          assert.match(text, /COMBO-OLD-LIVE/);
          absent(JSON.stringify(request.messages), [failed]);
          return send('COMBO-OLD-SUMMARY: COMBO-OLD-CONSTRAINT, COMBO-OLD-LIVE, COMBO-OLD-MEMORY');
        case 8:
          absent(JSON.stringify(request.messages), old);
          return send(spineCall('spine_open', { goal: 'COMBO-FRESH-OWNER' }));
        case 9:
          absent(JSON.stringify(request.messages), old);
          assert.match(text, /<spine_node id="1\.1"[^>]*summary="COMBO-FRESH-OWNER"/);
          return send(spineCall('spine_close', { memory: 'COMBO-FRESH-MEMORY' }));
        case 10: return send('COMBO-FRESH-DONE');
        case 11:
          absent(JSON.stringify(request.messages), old);
          assert.match(text, /COMBO-FRESH-MEMORY/);
          return send(spineCall('spine_open', { goal: 'COMBO-RESUMED-OWNER' }));
        case 12:
          assert.match(text, /<spine_node id="1\.2"[^>]*summary="COMBO-RESUMED-OWNER"/);
          return send(spineCall('spine_close', { memory: 'COMBO-RESUMED-MEMORY' }));
        case 13: return send('COMBO-RESUMED-DONE');
        default: assert.fail(`Unexpected combined retry/compact/reset request ${index}`);
      }
    },
  });
  let rpc = await fixture.start({ autoRetry: true, autoCompaction: true });
  completed(await rpc.prompt('COMBO-OLD-CONSTRAINT'));
  const seed = await inspect(rpc);
  assert.deepEqual(seed.projection.cursor, [1, 2]);
  completed(await rpc.prompt('COMBO-RECOVERY-HUMAN'));
  assert.equal((await rpc.event((frame) => frame.type === 'auto_retry_end', 'retry recovery')).success, true);
  const recovered = await inspect(rpc);
  assert.deepEqual(recovered.projection.cursor, seed.projection.cursor);
  once(recovered.source, 'COMBO-RECOVERY-HUMAN');
  const token = await holdNextCommit(rpc);
  const pressure = rpc.prompt('COMBO-PRESSURE-HUMAN');
  pressure.catch(() => {});
  await releasePressureObserver(rpc, token);
  completed(await pressure);
  const end = await rpc.event((frame) => frame.type === 'auto_compaction_end', 'combined compact completion');
  assert.equal(end.aborted, false);
  assert.match(end.result.summary, /COMBO-OLD-SUMMARY/);
  const compacted = await inspect(rpc);
  identities(compacted.source);
  assert.equal(compacted.source.epoch, recovered.source.epoch + 1);
  const compactRows = await readJournal(compacted.sessionFile);
  assert.equal(compactRows.filter((row) => row.customType === 'spine.compact.v1').length, 1);
  const retryError = compactRows.find((row) => row.message?.retryRecovery?.status === 'recovered');
  assert.ok(retryError, 'Real native retry acknowledgment must precede compact/reset');
  const reset = await call(rpc, 'reset');
  assert.equal(reset.sessionId, compacted.sessionId);
  assert.equal(reset.sessionFile, compacted.sessionFile);
  assert.deepEqual(reset.messages, []);
  assert.ok(reset.reset.droppedCount > 0);
  completed(await rpc.prompt('COMBO-FRESH-HUMAN'));
  const fresh = await inspect(rpc);
  identities(fresh.source);
  assert.equal(fresh.source.epoch, 0, 'Native reset starts a fresh Spine Root, not the compacted epoch');
  assert.deepEqual(fresh.projection.cursor, [1]);
  assert.equal(once(fresh.source, 'COMBO-FRESH-HUMAN').source_id.ordinal, 0);
  absent(JSON.stringify(fresh.source), old);
  const rows = await readJournal(fresh.sessionFile);
  assert.deepEqual(rows.slice(0, compactRows.length), compactRows, 'Reset must retain the compact/retry journal prefix');
  assert.equal(rows.filter((row) => row.type === 'reset_boundary').length, 1);
  healthy(rows);
  await rpc.close();
  rpc = await fixture.restart(fresh.sessionFile, { autoRetry: true, autoCompaction: true });
  const restored = await inspect(rpc);
  assert.deepEqual(restored.source, fresh.source);
  assert.deepEqual(restored.projection, fresh.projection);
  completed(await rpc.prompt('COMBO-RESUMED-HUMAN'));
  const finished = await inspect(rpc);
  assert.deepEqual(finished.projection.cursor, [1]);
  identities(finished.source);
  absent(JSON.stringify(finished.source), old);
  healthy(await readJournal(fresh.sessionFile));
  assert.equal(fixture.requests.length, 13);
  await rpc.close();
});

test('native shake then branch cut then fork/switch keeps inherited Source identities and original journals through restart', { timeout: 180_000 }, async (t) => {
  const secret = 'COMBO-SHAKE-PRIVATE-THINKING';
  const fixture = await createNativeFixture(t, {
    label: 'combo-shake-cut-fork', bridge, model: { reasoning: true },
    onRequest(request, { index, send }) {
      const text = visibleText(request.messages);
      switch (index) {
        case 1: return send(spineCall('spine_open', { goal: 'COMBO-CUT-CLOSED' }));
        case 2: return send(spineCall('spine_next', { memory: 'COMBO-CUT-KEPT-MEMORY', goal: 'COMBO-CUT-LIVE' }));
        case 3: return send('COMBO-CUT-READY', { reasoningText: secret });
        case 4: return send(spineCall('spine_close', { memory: 'COMBO-CUT-DISCARDED-MEMORY' }));
        case 5: return send('COMBO-CUT-DISCARDED-ANSWER', { reasoningText: secret });
        case 6:
          absent(JSON.stringify(request.messages), [secret, 'COMBO-CUT-DISCARDED-HUMAN', 'COMBO-CUT-DISCARDED-MEMORY']);
          assert.match(text, /COMBO-CUT-KEPT-MEMORY/);
          assert.match(text, /COMBO-CUT-LIVE/);
          return send(spineCall('spine_close', { memory: 'COMBO-FORK-ONLY-MEMORY' }));
        case 7:
          assertPendingFold(request, '1.2', 'COMBO-FORK-ONLY-MEMORY');
          return send('COMBO-FORK-DONE');
        case 8:
          absent(JSON.stringify(request.messages), [secret, 'COMBO-FORK-ONLY-MEMORY', 'COMBO-CUT-DISCARDED-HUMAN']);
          assert.match(text, /COMBO-CUT-LIVE/);
          return send('COMBO-BRANCH-STILL-LIVE');
        case 9:
          absent(JSON.stringify(request.messages), [secret, 'COMBO-CUT-DISCARDED-HUMAN', 'COMBO-CUT-DISCARDED-MEMORY', 'COMBO-BRANCH-STILL-LIVE']);
          assertFoldedMemory(request, '1.2', 'COMBO-FORK-ONLY-MEMORY');
          return send('COMBO-FORK-RESTART-HEALTHY');
        default: assert.fail(`Unexpected shake/cut/fork request ${index}`);
      }
    },
  });
  let rpc = await fixture.start();
  completed(await rpc.prompt('COMBO-CUT-KEPT-HUMAN'));
  const kept = await inspect(rpc);
  identities(kept.source);
  completed(await rpc.prompt('COMBO-CUT-DISCARDED-HUMAN'));
  const original = await inspect(rpc);
  assert.deepEqual(original.projection.cursor, [1]);
  assert.ok(JSON.stringify(original.messages).includes(secret));
  const shake = await call(rpc, 'thinking');
  assert.equal(shake.shake.thinkingBlocksDropped, 2);
  assert.deepEqual(shake.after.source, original.source, 'Shake edits native view, never canonical Source');
  absent(JSON.stringify(shake.after.messages), [secret]);
  const originalRows = await readJournal(original.sessionFile);
  const cutEntry = shake.after.branch.find((row) => row.message?.role === 'user'
    && visibleText(row.message) === 'COMBO-CUT-DISCARDED-HUMAN');
  assert.ok(cutEntry);
  const cut = await rpc.command('branch', { entryId: cutEntry.id });
  assert.equal(cut.cancelled, false);
  assert.equal(cut.text, 'COMBO-CUT-DISCARDED-HUMAN');
  const branched = await inspect(rpc);
  assert.notEqual(branched.sessionId, original.sessionId);
  assert.notEqual(branched.sessionFile, original.sessionFile);
  assert.deepEqual(branched.source.cells, kept.source.cells, 'Inherited canonical cells retain producer identity after native cut');
  assert.deepEqual(branched.projection.cursor, [1, 2]);
  absent(JSON.stringify(branched.messages), [secret, 'COMBO-CUT-DISCARDED-HUMAN', 'COMBO-CUT-DISCARDED-MEMORY']);
  assert.deepEqual(await readJournal(original.sessionFile), originalRows, 'Branching must not erase original entries');
  assert.equal((await rpc.command('fork')).cancelled, false);
  const forked = await inspect(rpc);
  assert.notEqual(forked.source.thread, branched.source.thread);
  assert.deepEqual(forked.source.cells, branched.source.cells);
  assert.deepEqual(forked.projection.cursor, [1, 2]);
  completed(await rpc.prompt('COMBO-FORK-HUMAN'));
  const forkDone = await inspect(rpc);
  identities(forkDone.source);
  assert.deepEqual(forkDone.source.cells.slice(0, kept.source.cells.length), kept.source.cells);
  assert.equal(once(forkDone.source, 'COMBO-FORK-HUMAN').source_id.thread, forkDone.source.thread);
  assert.deepEqual(forkDone.projection.cursor, [1]);
  assert.equal((await rpc.command('switch_session', { sessionPath: original.sessionFile })).cancelled, false);
  const originalAgain = await inspect(rpc);
  assert.deepEqual(originalAgain.source, original.source);
  assert.deepEqual(originalAgain.projection.cursor, [1]);
  absent(JSON.stringify(originalAgain.messages), [secret, 'COMBO-FORK-ONLY-MEMORY']);
  assert.equal((await rpc.command('switch_session', { sessionPath: branched.sessionFile })).cancelled, false);
  assert.deepEqual((await inspect(rpc)).source, branched.source);
  completed(await rpc.prompt('COMBO-BRANCH-HUMAN'));
  assert.deepEqual((await inspect(rpc)).projection.cursor, [1, 2]);
  assert.equal((await rpc.command('switch_session', { sessionPath: forkDone.sessionFile })).cancelled, false);
  assert.deepEqual((await inspect(rpc)).source, forkDone.source);
  await rpc.close();
  rpc = await fixture.restart(forkDone.sessionFile);
  assert.deepEqual((await inspect(rpc)).source, forkDone.source);
  completed(await rpc.prompt('COMBO-FORK-RESTART-HUMAN'));
  identities((await inspect(rpc)).source);
  for (const path of [original.sessionFile, branched.sessionFile, forkDone.sessionFile]) healthy(await readJournal(path));
  assert.deepEqual(await readJournal(original.sessionFile), originalRows);
  assert.equal(fixture.requests.length, 9);
  await rpc.close();
});

test('idle custom Source arriving during automatic summary cancels the stale compact and leaves ownership usable after restart', { timeout: 180_000 }, async (t) => {
  const summaryHeld = deferred();
  const summaryRelease = deferred();
  const fixture = await createNativeFixture(t, {
    label: 'combo-auto-idle-source', bridge, settings: compactionSettings,
    model: { contextWindow: 131072, maxTokens: 4096 },
    async onRequest(request, { index, send }) {
      const text = visibleText(request.messages);
      switch (index) {
        case 1: return send(spineCall('spine_open', { goal: 'COMBO-IDLE-CLOSED' }));
        case 2: return send(spineCall('spine_next', { memory: 'COMBO-IDLE-KEPT-MEMORY', goal: 'COMBO-IDLE-LIVE' }));
        case 3: return send('COMBO-IDLE-READY');
        case 4: return send('COMBO-IDLE-PRESSURE', { inputTokens: pressureTokens });
        case 5:
          assert.match(text, /COMBO-IDLE-LIVE/);
          assert.match(text, /COMBO-IDLE-KEPT-MEMORY/);
          summaryHeld.resolve();
          await summaryRelease.promise;
          return send('COMBO-IDLE-STALE-SUMMARY');
        case 6:
          absent(JSON.stringify(request.messages), ['COMBO-IDLE-STALE-SUMMARY']);
          assert.match(text, /COMBO-IDLE-RESOURCE-UPDATE/);
          assert.match(text, /COMBO-IDLE-KEPT-MEMORY/);
          assert.match(text, /COMBO-IDLE-LIVE/);
          return send(spineCall('spine_close', { memory: 'COMBO-IDLE-CLOSE-MEMORY' }));
        case 7: return send('COMBO-IDLE-HEALTHY');
        case 8:
          assert.match(text, /COMBO-IDLE-CLOSE-MEMORY/);
          absent(JSON.stringify(request.messages), ['COMBO-IDLE-STALE-SUMMARY']);
          return send('COMBO-IDLE-RESTART-HEALTHY');
        default: assert.fail(`Unexpected idle-source compact request ${index}`);
      }
    },
  });
  let rpc = await fixture.start({ autoCompaction: true });
  completed(await rpc.prompt('COMBO-IDLE-INITIAL-HUMAN'));
  const owner = await inspect(rpc);
  const token = await holdNextCommit(rpc);
  const pressure = rpc.prompt('COMBO-IDLE-PRESSURE-HUMAN');
  pressure.catch(() => {});
  await releasePressureObserver(rpc, token);
  await summaryHeld.promise;
  const before = await inspect(rpc);
  const custom = await call(rpc, 'idle-custom', { text: 'COMBO-IDLE-RESOURCE-UPDATE' });
  assert.equal(custom.agentStreaming, false, 'Summary is maintenance, not a live assistant stream');
  assert.equal(custom.invoked, false);
  assert.equal(custom.branch.filter((row) => row.type === 'custom_message' && row.content === 'COMBO-IDLE-RESOURCE-UPDATE').length, 1,
    'Native idle consumer must durably append the changed Source before the held summary returns');
  summaryRelease.resolve();
  completed(await pressure);
  const end = await rpc.event((frame) => frame.type === 'auto_compaction_end', 'cancelled stale automatic compact');
  assert.ok(end.aborted || end.result === undefined, 'Stale summary must not be accepted');
  const cancelled = await inspect(rpc);
  assert.deepEqual(cancelled.projection, before.projection, 'Rejected compact must leave the complete old tree and memories intact');
  assert.deepEqual(cancelled.projection.cursor, owner.projection.cursor);
  assert.equal(cancelled.source.epoch, before.source.epoch);
  assert.deepEqual(cancelled.source.cells.slice(0, before.source.cells.length), before.source.cells);
  const cancelledRows = await readJournal(cancelled.sessionFile);
  assert.equal(cancelledRows.filter((row) => row.customType === 'spine.compact.v1' || row.type === 'compaction').length, 0);
  healthy(cancelledRows);
  await rpc.command('set_auto_compaction', { enabled: false });
  completed(await rpc.prompt('COMBO-IDLE-NEXT-HUMAN'));
  const settled = await inspect(rpc);
  identities(settled.source);
  const resource = once(settled.source, 'COMBO-IDLE-RESOURCE-UPDATE');
  const human = once(settled.source, 'COMBO-IDLE-NEXT-HUMAN');
  assert.ok(resource.boundary < human.boundary, 'Idle resource is admitted before the next human, not appended after it');
  assert.deepEqual(settled.projection.cursor, [1]);
  assert.ok(commits(await readJournal(settled.sessionFile)).length > commits(cancelledRows).length);
  await rpc.close();
  rpc = await fixture.restart(settled.sessionFile);
  assert.deepEqual((await inspect(rpc)).source, settled.source);
  completed(await rpc.prompt('COMBO-IDLE-RESTART-HUMAN'));
  healthy(await readJournal(settled.sessionFile));
  assert.equal(fixture.requests.length, 8);
  await rpc.close();
});

test('abort_and_prompt during held model IO rejects the old callback while queued custom and user Sources retain native order', { timeout: 180_000 }, async (t) => {
  const oldHeld = deferred();
  const oldRelease = deferred();
  const oldReturned = deferred();
  const replacementHeld = deferred();
  const replacementRelease = deferred();
  const fixture = await createNativeFixture(t, {
    label: 'combo-abort-queue-race', bridge,
    async onRequest(request, { index, send }) {
      const text = visibleText(request.messages);
      switch (index) {
        case 1: return send(spineCall('spine_open', { goal: 'COMBO-RACE-OWNER' }));
        case 2: return send('COMBO-RACE-READY');
        case 3:
          oldHeld.resolve();
          await oldRelease.promise;
          // This response really returns from the old local HTTP callback, after
          // the replacement native turn has entered its own provider request.
          send(spineCall('spine_next', { memory: 'COMBO-RACE-STALE-MEMORY', goal: 'COMBO-RACE-STALE-OWNER' }));
          oldReturned.resolve();
          return;
        case 4:
          assert.match(text, /COMBO-RACE-REPLACEMENT-HUMAN/);
          absent(JSON.stringify(request.messages), ['COMBO-RACE-STALE-MEMORY', 'COMBO-RACE-STALE-OWNER']);
          replacementHeld.resolve();
          await replacementRelease.promise;
          return send(spineCall('spine_close', { memory: 'COMBO-RACE-REPLACEMENT-MEMORY' }));
        case 5:
          assertPendingFold(request, '1.1', 'COMBO-RACE-REPLACEMENT-MEMORY');
          absent(JSON.stringify(request.messages), ['COMBO-RACE-STALE-MEMORY', 'COMBO-RACE-STALE-OWNER']);
          return send('COMBO-RACE-REPLACEMENT-DONE');
        case 6:
          assertFoldedMemory(request, '1.1', 'COMBO-RACE-REPLACEMENT-MEMORY');
          assert.ok(text.indexOf('COMBO-RACE-QUEUED-RESOURCE') < text.indexOf('COMBO-RACE-QUEUED-HUMAN'));
          assert.match(text, /COMBO-RACE-QUEUED-HUMAN/);
          return send(spineCall('spine_open', { goal: 'COMBO-RACE-QUEUED-OWNER' }));
        case 7:
          assert.match(text, /<spine_node id="1\.2"[^>]*summary="COMBO-RACE-QUEUED-OWNER"/);
          return send(spineCall('spine_close', { memory: 'COMBO-RACE-QUEUED-MEMORY' }));
        case 8: return send('COMBO-RACE-QUEUE-DONE');
        case 9:
          absent(JSON.stringify(request.messages), ['COMBO-RACE-STALE-MEMORY', 'COMBO-RACE-STALE-OWNER']);
          assertFoldedMemory(request, '1.1', 'COMBO-RACE-REPLACEMENT-MEMORY');
          assertFoldedMemory(request, '1.2', 'COMBO-RACE-QUEUED-MEMORY');
          return send('COMBO-RACE-RESTART-HEALTHY');
        default: assert.fail(`Unexpected abort/queue callback race request ${index}`);
      }
    },
  });
  let rpc = await fixture.start();
  await rpc.command('set_follow_up_mode', { mode: 'all' });
  completed(await rpc.prompt('COMBO-RACE-INITIAL-HUMAN'));
  const seed = await inspect(rpc);
  const interrupted = rpc.prompt('COMBO-RACE-INTERRUPTED-HUMAN');
  interrupted.catch(() => {});
  await oldHeld.promise;
  const frameStart = rpc.frames.length;
  await rpc.command('abort_and_prompt', { message: 'COMBO-RACE-REPLACEMENT-HUMAN' });
  await replacementHeld.promise;
  oldRelease.resolve();
  await oldReturned.promise;
  assert.notEqual((await interrupted).status, 'completed');
  const queued = await call(rpc, 'queue-custom', { text: 'COMBO-RACE-QUEUED-RESOURCE' });
  assert.equal(queued.agentStreaming, true);
  assert.equal(queued.invoked, false);
  await rpc.command('follow_up', { message: 'COMBO-RACE-QUEUED-HUMAN' });
  const replacementId = rpc.frames.slice(frameStart).find((frame) => frame.type === 'response' && frame.command === 'abort_and_prompt').id;
  replacementRelease.resolve();
  completed(await rpc.event((frame) => frame.type === 'prompt_result' && frame.id === replacementId, 'replacement and queued turn settlement'));
  await rpc.event((frame) => frame.type === 'agent_end' && visibleText(frame.messages ?? []).includes('COMBO-RACE-QUEUE-DONE'), 'actual queued native turn end');
  const settled = await inspect(rpc);
  identities(settled.source);
  assert.deepEqual(settled.source.cells.slice(0, seed.source.cells.length), seed.source.cells);
  once(settled.source, 'COMBO-RACE-INTERRUPTED-HUMAN');
  once(settled.source, 'COMBO-RACE-REPLACEMENT-HUMAN');
  const notice = once(settled.source, 'COMBO-RACE-QUEUED-RESOURCE');
  const human = once(settled.source, 'COMBO-RACE-QUEUED-HUMAN');
  assert.ok(notice.boundary < human.boundary);
  assert.ok(notice.source_id.ordinal < human.source_id.ordinal);
  assert.deepEqual(settled.projection.cursor, [1]);
  absent(JSON.stringify(settled.source), ['COMBO-RACE-STALE-MEMORY', 'COMBO-RACE-STALE-OWNER']);
  const rows = await readJournal(settled.sessionFile);
  healthy(rows);
  absent(JSON.stringify(rows), ['COMBO-RACE-STALE-MEMORY', 'COMBO-RACE-STALE-OWNER']);
  const noticeEntry = rows.findIndex((row) => row.type === 'custom_message' && row.content === 'COMBO-RACE-QUEUED-RESOURCE');
  const humanEntry = rows.findIndex((row) => row.message?.role === 'user' && visibleText(row.message) === 'COMBO-RACE-QUEUED-HUMAN');
  assert.ok(noticeEntry >= 0 && humanEntry > noticeEntry, 'Canonical queued order must match actual native journal order');
  await rpc.close();
  rpc = await fixture.restart(settled.sessionFile);
  assert.deepEqual((await inspect(rpc)).source, settled.source);
  completed(await rpc.prompt('COMBO-RACE-RESTART-HUMAN'));
  healthy(await readJournal(settled.sessionFile));
  assert.equal(fixture.requests.length, 9);
  await rpc.close();
});
