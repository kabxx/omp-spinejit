import assert from 'node:assert/strict';
import test from 'node:test';
import { copyFile, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createNativeFixture, readJournal, spineCall, visibleText } from './fixture.mjs';
import { assertFoldedMemory, assertPendingFold } from './fold-assertions.mjs';

const bridge = new URL('./durability.bridge.mjs', import.meta.url);
const constraint = 'DURABILITY-INITIAL-CONSTRAINT: retain the owner until its memory is committed';
const owner = 'DURABILITY-CURRENT-OWNER';
const memory = 'DURABILITY-COMMITTED-OWNER-MEMORY';
let serial = 0;

async function bridgeCall(rpc, action, fields = {}) {
  const token = `durability-${++serial}`;
  const result = await rpc.prompt(`/native-durability-case ${JSON.stringify({ action, token, ...fields })}`);
  assert.equal(result.status, 'completed', JSON.stringify(result));
  const prefix = 'DURABILITY-RESULT:';
  const frame = await rpc.event((frame) => frame.type === 'extension_ui_request' && frame.method === 'notify'
    && frame.message?.startsWith(prefix) && JSON.parse(frame.message.slice(prefix.length)).token === token, action);
  return JSON.parse(frame.message.slice(prefix.length));
}
async function snapshot(rpc) {
  const { snapshot: value } = await bridgeCall(rpc, 'snapshot');
  assert.equal(value.flush.ok, true, JSON.stringify(value.flush));
  return value;
}
function archives(rows, type) {
  return rows.filter((entry) => entry.customType === 'spine.archive.v1' && entry.data.record.type === type);
}
function memoryOperations(rows, value = memory) {
  return archives(rows, 'sampling_commit').flatMap((entry) => entry.data.record.record.executions)
    .filter((execution) => execution.operation.memory === value);
}
function assertOwner(request) {
  const text = visibleText(request.messages);
  assert.equal(text.split(constraint).length - 1, 1, 'committed human constraint appears exactly once');
  assert.ok(text.includes(`summary="${owner}"`), 'real provider view contains the active Spine node');
}
function assertSourceHuman(source, text, count) {
  assert.equal(source.cells.filter((cell) => cell.item.Message?.message.role === 'User'
    && cell.item.Message.message.content === text).length, count, 'canonical Source follows actual Native human persistence');
}
async function stopOwnedProcess(rpc) {
  if (rpc && rpc.child.exitCode === null && rpc.child.signalCode === null) await rpc.terminate();
}
async function killHeld(rpc, pending, boundary) {
  const prefix = 'DURABILITY-HELD:';
  const frame = await rpc.event((frame) => frame.type === 'extension_ui_request' && frame.method === 'notify'
    && frame.message?.startsWith(prefix) && JSON.parse(frame.message.slice(prefix.length)).boundary === boundary, boundary);
  const held = JSON.parse(frame.message.slice(prefix.length));
  const rows = await readJournal(held.sessionFile);
  assert.equal(rows.at(-1).id, held.leafId, 'held boundary is in the actual flushed file, not merely Native heap');
  const exit = await rpc.terminate();
  assert.equal(exit.code, null);
  assert.equal(exit.signal, 'SIGKILL', 'expected crash is not counted as a normal RPC exit');
  await assert.rejects(pending, 'the interrupted prompt cannot report success after process death');
  return { held, rows };
}

for (const boundary of ['source-checkpoint', 'sampling_started', 'sampling_commit']) {
  test(`native SIGKILL after durable ${boundary} restores only committed ownership and memory`, { timeout: 180_000 }, async (t) => {
    const interrupted = `DURABILITY-INTERRUPTED-${boundary}`;
    const committedAtCrash = boundary === 'sampling_commit';
    const fixture = await createNativeFixture(t, {
      label: `durability-${boundary}`, bridge,
      onRequest(request, { index, send }) {
        if (index === 1) return send(spineCall('spine_open', { goal: owner }));
        if (index === 2) { assertOwner(request); return send('DURABILITY-OWNER-READY'); }
        if (index === 3 && !committedAtCrash) {
          assertOwner(request);
          assert.ok(!JSON.stringify(request.messages).includes(memory), 'uncommitted memory is not fabricated on restart');
          return send(spineCall('spine_close', { memory }));
        }
        if (index === 3) { assertOwner(request); return send(spineCall('spine_close', { memory })); }
        if (index === 4) {
          assertPendingFold(request, '1.1', memory);
          return send('DURABILITY-RESUMED-DONE');
        }
        if (index === 5) {
          assertFoldedMemory(request, '1.1', memory);
          return send('DURABILITY-FOLDED-MEMORY-VERIFIED');
        }
        throw new Error(`Unexpected durability provider request ${index}`);
      },
    });
    let rpc;
    try {
      rpc = await fixture.start();
      assert.equal((await rpc.prompt(constraint)).status, 'completed');
      const before = await snapshot(rpc);
      assert.deepEqual(before.projection.cursor, [1, 1]);
      const baseline = await readJournal(before.sessionFile);
      await bridgeCall(rpc, 'arm', { boundary });
      const frameStart = rpc.frames.length;
      const pending = rpc.prompt(interrupted);
      pending.catch(() => {});
      const { held, rows } = await killHeld(rpc, pending, boundary);
      assert.equal(fixture.requests.length, committedAtCrash ? 3 : 2, 'no provider call crosses the held pre-provider boundary');
      assert.equal(archives(rows, 'sampling_commit').length, archives(baseline, 'sampling_commit').length + Number(committedAtCrash));
      assert.equal(memoryOperations(rows).length, Number(committedAtCrash));
      assert.equal(rows.at(-1).customType, boundary === 'source-checkpoint' ? 'spine.source.v1' : 'spine.archive.v1');
      if (boundary !== 'source-checkpoint') assert.equal(rows.at(-1).data.record.type, boundary);
      assert.equal(rpc.frames.slice(frameStart).filter((frame) => frame.type === 'prompt_result'
        && frame.agentInvoked === true && frame.status === 'completed').length, 0, 'no successful prompt acknowledgement before crash');

      rpc = await fixture.restart(held.sessionFile);
      const restored = await snapshot(rpc);
      assert.deepEqual(restored.projection.cursor, committedAtCrash ? [1] : [1, 1]);
      assert.equal(JSON.stringify(restored.projection).includes(memory), committedAtCrash);
      assertSourceHuman(restored.source, constraint, 1);
      const persistedHumans = rows.filter((entry) => entry.message?.role === 'user' && visibleText(entry.message) === interrupted).length;
      assertSourceHuman(restored.source, interrupted, persistedHumans);
      const continuation = committedAtCrash ? 'DURABILITY-CONTINUE-AFTER-COMMIT' : 'DURABILITY-CLOSE-AFTER-UNCOMMITTED-CRASH';
      assert.equal((await rpc.prompt(continuation)).status, 'completed');
      // The committed crash consumes request 3 before death, so its resumed
      // answer is request 4; the uncommitted crash closes via requests 3 + 4.
      assert.equal(fixture.requests.length, 4);
      const finished = await snapshot(rpc);
      assert.deepEqual(finished.projection.cursor, [1]);
      assert.equal(memoryOperations(await readJournal(finished.sessionFile)).length, 1, 'recovery never repeats a successful close memory');
      await rpc.close();
      rpc = await fixture.restart(finished.sessionFile);
      const twice = await snapshot(rpc);
      assert.deepEqual(twice.source, finished.source, 'second physical restart preserves exact immutable Source');
      assert.deepEqual(twice.projection, finished.projection);
      assert.equal(memoryOperations(await readJournal(twice.sessionFile)).length, 1);
      assert.equal((await rpc.prompt('Verify the folded memory after the second restart.')).status, 'completed');
      assert.equal(fixture.requests.length, 5);
      await rpc.close();
    } finally { await stopOwnedProcess(rpc); }
  });
}

test('native atomic compact receipt survives SIGKILL before adapter application and a subsequent committed turn', { timeout: 180_000 }, async (t) => {
  const summary = 'DURABILITY-REAL-COMPACT-SUMMARY: preserve the original compatibility constraint and continue active work';
  const fixture = await createNativeFixture(t, {
    label: 'durability-compact-before-ack', bridge,
    settings: { contextPromotion: { enabled: false }, compaction: { methodOrder: ['soft'], keepRecentTokens: 1 } },
    onRequest(request, { index, send }) {
      if (index === 1) return send(spineCall('spine_open', { goal: owner }));
      if (index === 2) { assertOwner(request); return send('DURABILITY-COMPACT-SEED-READY'); }
      if (index === 3) { assertOwner(request); return send(summary); }
      if (index === 4) {
        assert.ok(visibleText(request.messages).includes(summary), 'durable barrier restores the actual locally generated summary');
        return send(spineCall('spine_open', { goal: 'DURABILITY-POST-COMPACT-OWNER' }));
      }
      if (index === 5) {
        assert.ok(visibleText(request.messages).includes('summary="DURABILITY-POST-COMPACT-OWNER"'));
        return send('DURABILITY-POST-COMPACT-READY');
      }
      throw new Error(`Unexpected compact durability request ${index}`);
    },
  });
  let rpc;
  try {
    rpc = await fixture.start();
    assert.equal((await rpc.prompt(constraint)).status, 'completed');
    await snapshot(rpc);
    await bridgeCall(rpc, 'arm', { boundary: 'compact-receipt' });
    const pending = rpc.command('compact', { customInstructions: 'Summarize the current compatibility constraint and preserve unfinished work.' });
    pending.catch(() => {});
    const { held, rows } = await killHeld(rpc, pending, 'compact-receipt');
    const compacts = rows.filter((entry) => entry.type === 'compaction');
    assert.equal(compacts.length, 1);
    const compact = compacts[0];
    assert.equal(compact.id, held.leafId);
    assert.equal(compact.fromExtension, true);
    const receipt = compact.details?.['spine.compact.v1'];
    assert.equal(receipt?.preparedLeafId, compact.parentId);
    assert.equal(receipt.replacementMessages[0].summary, summary);
    assert.equal(rows.filter((entry) => entry.customType === 'spine.compact.v1').length, 0, 'No separate pre-ack receipt');
    assert.equal(fixture.requests.length, 3, 'one real localhost summary producer');
    rpc = await fixture.restart(held.sessionFile);
    const restored = await snapshot(rpc);
    assert.equal(restored.source.epoch, receipt.barrier.next_epoch);
    assert.equal(fixture.requests.length, 3, 'recovery does not re-run an already durable model summary');
    assert.equal((await rpc.prompt('DURABILITY-CONTINUE-COMPACTED-OWNER')).status, 'completed');
    const finished = await snapshot(rpc);
    assert.ok(JSON.stringify(finished.projection).includes('DURABILITY-POST-COMPACT-OWNER'));
    await rpc.close();
    rpc = await fixture.restart(finished.sessionFile);
    const twice = await snapshot(rpc);
    assert.deepEqual(twice.source, finished.source, 'crash before the command acknowledgement cannot poison the next restart');
    assert.deepEqual(twice.projection, finished.projection);
    assert.deepEqual((await readJournal(twice.sessionFile)).filter((entry) => entry.type === 'compaction'), compacts);
    await rpc.close();
  } finally { await stopOwnedProcess(rpc); }
});

test('actual Native ENOTDIR append failure is visible, replayed, and cannot acknowledge a durable successful prompt', { timeout: 180_000 }, async (t) => {
  const fixture = await createNativeFixture(t, {
    label: 'durability-enotdir', bridge,
    rootParent: tmpdir(),
    onRequest(request, { index, send }) {
      if (index === 1) return send(spineCall('spine_open', { goal: owner }));
      if (index === 2) return send('DURABILITY-STORAGE-SEED-READY');
      // A buggy adapter may call the real provider despite failed persistence.
      // Return an ordinary mock answer so the assertion detects silent success,
      // rather than relying on an artificial provider/fixture failure.
      return send('DURABILITY-ANSWER-WITHOUT-STORAGE');
    },
  });
  let rpc;
  let obstruction;
  let backup;
  try {
    rpc = await fixture.start();
    assert.equal((await rpc.prompt(constraint)).status, 'completed');
    const before = await snapshot(rpc);
    const originalBytes = await readFile(before.sessionFile);
    const obstructed = await bridgeCall(rpc, 'obstruct');
    obstruction = obstructed.directory;
    backup = obstructed.backup;
    const probe = await bridgeCall(rpc, 'probe-append');
    assert.equal(probe.flush.ok, false, 'flush must reject the real hot append producer failure');
    assert.equal(probe.flush.error.code, 'ENOTDIR', JSON.stringify(probe));
    assert.equal(probe.errors.length, 1, 'first persistence failure is latched exactly once');
    assert.deepEqual(probe.replayed, [probe.flush.error], 'late Native subscriber receives the same latched failure');
    assert.deepEqual(await readFile(join(backup, before.sessionFile.slice(obstruction.length + 1))), originalBytes,
      'failed write did not land a journal entry via a detached descriptor');
    const notification = await rpc.event((frame) => frame.type === 'notice'
      && frame.source === 'session-persistence' && frame.level === 'error', 'real Native RPC storage failure surface');
    assert.ok(notification.message.length > 0);
    const rewrite = await bridgeCall(rpc, 'rewrite');
    assert.equal(rewrite.result.ok, false, 'Native atomic rewrite cannot clear a still-obstructed journal failure');
    assert.equal(rewrite.flush.ok, false);
    const result = await rpc.prompt('DURABILITY-REQUEST-AFTER-STORAGE-FAILURE');
    assert.notEqual(result.status, 'completed', 'lost-durability state must not silently acknowledge a successful model request');
    assert.equal((await bridgeCall(rpc, 'new')).result.ok, false, 'Native new-session flush refuses a latched storage failure');
    assert.equal((await bridgeCall(rpc, 'switch', { sessionFile: before.sessionFile })).result.ok, false,
      'Native switch cannot bypass the outgoing durability flush');
    const reset = await bridgeCall(rpc, 'reset');
    assert.equal(reset.result.ok, true, 'Native context reset is an in-memory boundary, not storage recovery');
    assert.equal(reset.flush.ok, false, 'context reset cannot silently clear the storage latch');
    assert.equal(reset.flush.error.code, 'ENOTDIR');
    const exit = await rpc.terminate();
    assert.equal(exit.signal, 'SIGKILL');
    await rm(obstruction);
    await rename(backup, obstruction);
    backup = undefined;
    obstruction = undefined;
    rpc = await fixture.restart(before.sessionFile);
    const restored = await snapshot(rpc);
    assert.deepEqual(restored.source, before.source, 'crash recovers only the pre-failure committed source');
    assert.deepEqual(restored.projection, before.projection);
    assert.ok(!JSON.stringify(restored.branch).includes('DURABILITY-REQUEST-AFTER-STORAGE-FAILURE'));
    assert.equal(restored.branch.filter((entry) => entry.type === 'reset_boundary').length, 0, 'unpersisted reset was not fabricated on restart');
    const healthyReset = await bridgeCall(rpc, 'reset');
    assert.equal(healthyReset.result.ok, true);
    assert.equal(healthyReset.flush.ok, true);
    assert.equal((await bridgeCall(rpc, 'new')).result.value, true, 'healthy native new-session can recover identity');
    assert.equal((await bridgeCall(rpc, 'switch', { sessionFile: before.sessionFile })).result.value, true, 'healthy native switch remains usable');
    await rpc.close();
  } finally {
    await stopOwnedProcess(rpc);
    if (backup) { await rm(obstruction, { force: true, recursive: true }); await rename(backup, obstruction); }
  }
});

test('native writable loader preserves a committed prefix and discards an incomplete final journal record on a fixture copy', { timeout: 180_000 }, async (t) => {
  const fixture = await createNativeFixture(t, {
    label: 'durability-truncated-tail', bridge,
    onRequest(_request, { index, send }) {
      if (index === 1) return send(spineCall('spine_open', { goal: owner }));
      if (index === 2) return send('DURABILITY-TRUNCATION-READY');
      if (index === 3) return send(spineCall('spine_close', { memory }));
      if (index === 4) return send('DURABILITY-TRUNCATION-RECOVERED');
      throw new Error(`Unexpected truncated-journal provider request ${index}`);
    },
  });
  let rpc;
  try {
    rpc = await fixture.start();
    assert.equal((await rpc.prompt(constraint)).status, 'completed');
    const before = await snapshot(rpc);
    await rpc.close();
    const originalBytes = await readFile(before.sessionFile);
    const copy = join(dirname(before.sessionFile), 'durability-incomplete-copy.jsonl');
    await copyFile(before.sessionFile, copy);
    // Simulate a software-crash tail on a NEW isolated copy. This is not an
    // injected throw, source-string test, or modification of any user session.
    await writeFile(copy, Buffer.concat([originalBytes, Buffer.from('{"type":"custom","customType":"spine.archive.v1","data":{"record":')]));
    rpc = await fixture.restart(copy);
    const restored = await snapshot(rpc);
    assert.deepEqual(restored.source, before.source, 'native lenient loader retains every complete committed Source');
    assert.deepEqual(restored.projection, before.projection);
    assert.deepEqual(await readFile(before.sessionFile), originalBytes, 'the original journal is untouched');
    assert.equal((await rpc.prompt('DURABILITY-CLOSE-AFTER-TRUNCATED-TAIL')).status, 'completed');
    const finished = await snapshot(rpc);
    const repairedRows = await readJournal(finished.sessionFile);
    assert.equal(memoryOperations(repairedRows).length, 1);
    assert.equal(repairedRows.filter((entry) => entry.customType === 'spine.fault.v1').length, 0);
    await rpc.close();
    rpc = await fixture.restart(finished.sessionFile);
    const twice = await snapshot(rpc);
    assert.deepEqual(twice.source, finished.source);
    assert.deepEqual(twice.projection, finished.projection);
    assert.deepEqual(await readFile(before.sessionFile), originalBytes);
    await rpc.close();
  } finally { await stopOwnedProcess(rpc); }
});

test('native second live writer relocates its own journal and replays persistence notices without faulting the original writer', { timeout: 180_000 }, async (t) => {
  const fixture = await createNativeFixture(t, {
    label: 'durability-persistence-notice', bridge,
    onRequest(request, { index, send }) {
      if (index === 1) return send(spineCall('spine_open', { goal: owner }));
      if (index === 2) return send('DURABILITY-NOTICE-ORIGINAL-READY');
      if (index === 3) { assertOwner(request); return send(spineCall('spine_close', { memory })); }
      if (index === 4) return send('DURABILITY-NOTICE-RELOCATED-READY');
      throw new Error(`Unexpected Native notice provider request ${index}`);
    },
  });
  let original;
  let contender;
  try {
    original = await fixture.start();
    assert.equal((await original.prompt(constraint)).status, 'completed');
    const before = await snapshot(original);
    const originalBytes = await readFile(before.sessionFile);
    contender = await fixture.restart(before.sessionFile);
    const probe = await bridgeCall(contender, 'probe-append');
    assert.equal(probe.flush.ok, true, 'second writer saves to a sibling instead of failing or mixing journals');
    const { notices, replayed } = await bridgeCall(contender, 'late-notices');
    assert.equal(notices.length, 1);
    assert.equal(notices[0].reason, 'open-elsewhere');
    assert.equal(notices[0].from, before.sessionFile);
    assert.notEqual(notices[0].to, before.sessionFile);
    assert.deepEqual(replayed, notices, 'late Native notice subscriber sees each relocation exactly once');
    await contender.event((frame) => frame.type === 'notice'
      && frame.source === 'session-persistence' && frame.level === 'warning', 'real Native RPC storage relocation surface');
    assert.deepEqual(await readFile(before.sessionFile), originalBytes, 'contender never writes the original owner journal');
    assert.equal((await contender.prompt('DURABILITY-CLOSE-ON-RELOCATED-JOURNAL')).status, 'completed');
    const relocated = await snapshot(contender);
    assert.equal(relocated.sessionFile, notices[0].to);
    assert.equal(relocated.errors.length, 0);
    assert.equal(memoryOperations(await readJournal(relocated.sessionFile)).length, 1);
    const unchanged = await snapshot(original);
    assert.deepEqual(unchanged.source, before.source);
    assert.deepEqual(unchanged.projection, before.projection);
    assert.equal(unchanged.errors.length, 0);
    await contender.close();
    await original.close();
    contender = await fixture.restart(relocated.sessionFile);
    const twice = await snapshot(contender);
    assert.deepEqual(twice.source.cells, relocated.source.cells, 'Relocation retains inherited Source identity while changing the active namespace');
    assert.equal(twice.source.epoch, relocated.source.epoch);
    assert.deepEqual(twice.projection, relocated.projection);
    assert.equal(memoryOperations(await readJournal(before.sessionFile)).length, 0, 'Relocated writer never installs its completed memory into the original journal');
    await contender.close();
  } finally { await Promise.all([stopOwnedProcess(original), stopOwnedProcess(contender)]); }
});
