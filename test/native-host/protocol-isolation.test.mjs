import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { createNativeFixture, readJournal, spineCall, visibleText } from './fixture.mjs';
import { assertFoldedMemory, assertPendingFold } from './fold-assertions.mjs';

for (const boundary of ['archive', 'compaction-ack']) {
  test(`native OMP rejects foreign Pi ${boundary} without consuming it or calling a model`, { timeout: 180_000 }, async (t) => {
    const owner = `PROTOCOL-${boundary}-OWNER`;
    const memory = `PROTOCOL-${boundary}-CONTINUED-MEMORY`;
    const summary = `Keep the protocol isolation constraint; unfinished owner ${owner}.`;
    let phase = 'initial';
    let continuation = 0;
    const fixture = await createNativeFixture(t, {
      label: `protocol-${boundary}`,
      onRequest(request, { index, send }) {
        if (phase === 'initial' && index === 1) return send(spineCall('spine_open', { goal: owner }));
        if (phase === 'initial' && index === 2) return send('PROTOCOL-OWNER-READY');
        if (phase === 'compact') return send(summary);
        assert.equal(phase, 'continue', 'A rejected foreign journal must never reach the provider');
        continuation += 1;
        if (boundary === 'compaction-ack' && continuation === 1) {
          return send(spineCall('spine_open', { goal: owner }));
        }
        if (continuation === (boundary === 'archive' ? 1 : 2)) {
          assert.ok(visibleText(request.messages).includes(`summary="${owner}"`));
          return send(spineCall('spine_close', { memory }));
        }
        const node = boundary === 'archive' ? '1.1' : '2.1';
        if (continuation === (boundary === 'archive' ? 2 : 3)) {
          assertPendingFold(request, node, memory);
          return send('PROTOCOL-CONTINUED');
        }
        assertFoldedMemory(request, node, memory);
        return send('PROTOCOL-FOLDED-MEMORY-VERIFIED');
      },
    });
    let rpc = await fixture.start();
    assert.equal((await rpc.prompt('Keep native OMP protocol isolation and the unfinished owner.')).status, 'completed');
    if (boundary === 'compaction-ack') {
      phase = 'compact';
      const compact = await rpc.command('compact', { customInstructions: 'Retain the isolation constraint and unfinished work.' });
      assert.equal(compact.summary, summary);
    }
    const original = (await rpc.command('get_state')).sessionFile;
    assert.ok(original);
    await rpc.close();
    const originalBytes = await readFile(original);
    const rows = await readJournal(original);
    const foreign = structuredClone(rows);
    if (boundary === 'archive') {
      const archives = foreign.filter((entry) => entry.customType === 'spine.archive.v1');
      assert.ok(archives.some((entry) => entry.data.record.type === 'sampling_commit'));
      for (const entry of archives) entry.data.schema = 'spine-plugin/pi/v1';
    } else {
      const acknowledgement = foreign.find((entry) => entry.type === 'compaction');
      assert.equal(acknowledgement?.fromExtension, true);
      delete acknowledgement.fromExtension;
      acknowledgement.fromHook = true;
    }
    const copy = join(dirname(original), `foreign-${boundary}.jsonl`);
    await writeFile(copy, foreign.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
    const requestsBefore = fixture.requests.length;
    phase = 'reject';
    rpc = await fixture.restart(copy);
    const rejected = await rpc.prompt('Do not consume this foreign harness history.');
    assert.notEqual(rejected.status, 'completed', 'A foreign archive or Pi-only acknowledgement cannot yield successful inference');
    assert.equal(fixture.requests.length, requestsBefore, 'No model request is made after incompatible recovery');
    const rejectedRows = await readJournal((await rpc.command('get_state')).sessionFile);
    assert.ok(rejectedRows.some((entry) => entry.customType === 'spine.fault.v1'));
    assert.deepEqual(rejectedRows.filter((entry) => entry.customType === 'spine.archive.v1'),
      foreign.filter((entry) => entry.customType === 'spine.archive.v1'), 'No canonical sampling is fabricated from rejected history');
    await rpc.close();
    assert.deepEqual(await readFile(original), originalBytes, 'The valid original native journal is untouched by rejection');
    phase = 'continue';
    rpc = await fixture.restart(original);
    assert.equal((await rpc.prompt('Continue from valid OMP history and return the requested memory.')).status, 'completed');
    assert.equal((await rpc.prompt('Verify the folded memory from the valid journal.')).status, 'completed');
    const healthyRows = await readJournal((await rpc.command('get_state')).sessionFile);
    assert.equal(healthyRows.filter((entry) => entry.customType === 'spine.fault.v1').length, 0);
    const executions = healthyRows.filter((entry) => entry.customType === 'spine.archive.v1'
      && entry.data.record.type === 'sampling_commit').flatMap((entry) => entry.data.record.record.executions);
    assert.equal(executions.filter((execution) => execution.operation.memory === memory).length, 1);
    await rpc.close();
  });
}
