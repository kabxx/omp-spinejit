import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { createNativeFixture, readJournal, spineCall, visibleText } from './fixture.mjs';

function committedSpawn(rows) {
  return rows.filter((row) => row.customType === 'spine.archive.v1' && row.data.record.type === 'sampling_commit'
    && row.data.record.record.executions.some(({ operation }) => operation.type === 'spawn'));
}

function arrivals(rows) {
  return rows.filter((row) => row.type === 'custom' && row.customType === 'spine-arrival');
}

test('stock RPC Spawn commits before launching children, returns while they run, and wakes for each arrival', { timeout: 120_000 }, async (t) => {
  const prompt = 'RPC-SPAWN-PARENT-PROMPT';
  const owner = 'RPC-SPAWN-OWNER';
  const staged = 'RPC-SPAWN-PARENT-STAGED';
  const tasks = [0, 1].map((i) => ({ summary: `RPC task ${i}`, prompt: `RPC-SPAWN-CHILD-${i}` }));
  const memories = ['RPC-SPAWN-ALPHA-MEMORY', 'RPC-SPAWN-BETA-MEMORY'];
  const acknowledgments = ['RPC-SPAWN-SAW-ALPHA', 'RPC-SPAWN-SAW-BETA'];
  const releases = tasks.map(() => Promise.withResolvers());
  const childCalls = [0, 0];
  let parentCalls = 0;
  let sessionFile;
  const fixture = await createNativeFixture(t, {
    label: 'stock-rpc-spawn',
    async onRequest(request, { send }) {
      const user = visibleText(request.messages.findLast((message) => message.role === 'user')).trimEnd();
      const child = tasks.findIndex((task) => user.endsWith(task.prompt));
      const text = visibleText(request.messages);
      if (child !== -1) {
        assert.equal(++childCalls[child], 1, 'each child samples once and returns a plain final reply');
        assert.equal(committedSpawn(await readJournal(sessionFile)).length, 1, 'durable Spawn precedes child inference');
        assert.ok(!JSON.stringify(request.tools ?? []).includes('spine_child_return'));
        await releases[child].promise;
        return send(memories[child]);
      }
      switch (++parentCalls) {
        case 1:
          assert.ok(text.includes(prompt));
          return send(spineCall('spine_open', { goal: owner }));
        case 2:
          assert.ok(text.includes(`summary="${owner}"`));
          return send(spineCall('spine_spawn', { tasks }));
        case 3:
          for (const task of tasks) assert.ok(text.includes(`summary="${task.summary}"`), 'parent sees both committed births');
          for (const memory of memories) assert.ok(!text.includes(memory));
          return send(staged);
        case 4:
          assert.ok(text.includes(memories[0]) && !text.includes(memories[1]), 'first wake sees only the released child');
          return send(acknowledgments[0]);
        case 5:
          for (const memory of memories) assert.ok(text.includes(memory));
          return send(acknowledgments[1]);
        case 6:
          for (const memory of memories) assert.ok(text.includes(memory), 'restart restores each committed result');
          return send('RPC-SPAWN-RESTORED');
        default:
          assert.fail(`Unexpected Spawn parent request ${parentCalls}`);
      }
    },
  });
  let rpc;
  try {
    rpc = await fixture.start();
    sessionFile = (await rpc.command('get_state')).sessionFile;
    assert.ok(sessionFile);
    const result = await rpc.prompt(prompt);
    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.equal(parentCalls, 3, 'the parent completes its prompt without waiting for either child');
    assert.equal(arrivals(await readJournal(sessionFile)).length, 0);

    for (const [i, { resolve }] of releases.entries()) {
      resolve();
      await rpc.event((frame) => frame.type === 'agent_end' && frame.messages?.some((message) =>
        message.role === 'assistant' && visibleText(message) === acknowledgments[i]), `parent wake for child ${i}`);
      const rows = await readJournal(sessionFile);
      assert.deepEqual(arrivals(rows).map((row) => [row.data.outcome, row.data.memory]),
        memories.slice(0, i + 1).map((memory) => ['completed', memory]));
    }
    assert.deepEqual(childCalls, [1, 1]);
    const rows = await readJournal(sessionFile);
    const [spawn, ...extra] = committedSpawn(rows);
    assert.ok(spawn);
    assert.deepEqual(extra, []);
    assert.ok(arrivals(rows).every((row) => rows.indexOf(row) > rows.indexOf(spawn)));
    assert.deepEqual(rows.filter((row) => row.customType === 'spine.fault.v1'), []);

    const spawnDir = join(dirname(sessionFile), 'spine-spawn');
    const files = (await readdir(spawnDir, { recursive: true })).filter((name) => name.endsWith('.jsonl'));
    assert.equal(files.length, 2);
    for (const arrival of arrivals(rows)) {
      const path = files.find((name) => name.endsWith(`.${arrival.data.producer.join('.')}.jsonl`));
      assert.ok(path, 'the arrival producer names its original child journal');
      const childRows = await readJournal(join(spawnDir, path));
      assert.deepEqual(childRows.find((row) => row.type === 'session')?.birth, arrival.data.producer);
      const reply = childRows.findLast((row) => row.message?.role === 'assistant');
      assert.equal(visibleText(reply?.message), arrival.data.memory);
      assert.equal(reply?.message.stopReason, 'stop');
    }
    await rpc.close();
    rpc = await fixture.restart(sessionFile);
    const restored = await rpc.prompt('Recall the completed notifications after restart.');
    assert.equal(restored.status, 'completed', JSON.stringify(restored));
    await rpc.event((frame) => frame.type === 'message_end' && visibleText(frame.message) === 'RPC-SPAWN-RESTORED');
    assert.deepEqual(childCalls, [1, 1], 'restart does not launch completed children');
    const afterRestart = await readJournal(sessionFile);
    assert.deepEqual(arrivals(afterRestart).map(({ id }) => id), arrivals(rows).map(({ id }) => id));
    assert.deepEqual(afterRestart.filter((row) => row.customType === 'spine.fault.v1'), []);
    await rpc.close();
  } finally {
    for (const release of releases) release.resolve();
    if (rpc && !rpc.closing && rpc.child.exitCode === null && rpc.child.signalCode === null) await rpc.terminate();
  }
});
