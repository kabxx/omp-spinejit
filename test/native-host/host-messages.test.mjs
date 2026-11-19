import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createNativeFixture, readJournal, spineCall, visibleText } from './fixture.mjs';
import { assertFoldedMemory, assertPendingFold } from './fold-assertions.mjs';

const bridge = new URL('./host-messages.bridge.mjs', import.meta.url);
let serial = 0;
const count = (value, marker) => value.split(marker).length - 1;
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
async function command(rpc, action, fields = {}) {
  const token = `host-messages-${++serial}`;
  const result = await rpc.prompt(`/native-host-messages ${JSON.stringify({ action, token, ...fields })}`);
  assert.equal(result.status, 'completed', JSON.stringify(result));
  const prefix = 'HOST-MESSAGES-RESULT:';
  const frame = await rpc.event((value) => value.type === 'extension_ui_request' && value.method === 'notify'
    && value.message?.startsWith(prefix) && JSON.parse(value.message.slice(prefix.length)).token === token, action);
  const data = JSON.parse(frame.message.slice(prefix.length));
  assert.equal(data.error, undefined, JSON.stringify(data));
  return data;
}
async function snapshot(rpc) { return (await command(rpc, 'snapshot')).snapshot; }
function healthy(rows) {
  assert.deepEqual(rows.filter((row) => row.customType === 'spine.fault.v1'), [], 'real Native journal must not contain a Spine fault');
}
function commits(rows) {
  return rows.filter((row) => row.customType === 'spine.archive.v1' && row.data.record.type === 'sampling_commit');
}
function executions(rows, type) {
  return commits(rows).flatMap((row) => row.data.record.record.executions).filter((value) => value.operation.type === type);
}
function sourceCount(source, marker) {
  return source.cells.filter((cell) => JSON.stringify(cell.item).includes(marker)).length;
}
function assertProviderToolPair(request, path) {
  const calls = request.messages.flatMap((message) => message.tool_calls ?? []).filter((call) => {
    return call.function.name === 'write' && JSON.parse(call.function.arguments).path === path;
  });
  assert.equal(calls.length, 1, `Native provider retains one tool call for ${path}`);
  assert.equal(request.messages.filter((message) => message.role === 'tool' && message.tool_call_id === calls[0].id).length, 1,
    `Native provider retains its matching tool result for ${path}`);
}
function assertJournalToolPairs(rows) {
  const calls = rows.flatMap((row) => row.message?.role === 'assistant' ? row.message.content.filter((part) => part.type === 'toolCall') : []);
  assert.ok(calls.length > 0, 'real assistant calls must have been persisted');
  for (const call of calls) {
    const results = rows.filter((row) => row.message?.role === 'toolResult' && row.message.toolCallId === call.id);
    assert.equal(results.length, 1, `one durable Native tool result for ${call.id}`);
    assert.equal(results[0].message.isError, false, JSON.stringify(results[0].message));
  }
}
async function stop(rpc) {
  if (rpc && rpc.child.exitCode === null && rpc.child.signalCode === null) await rpc.terminate();
}

// The native rule matcher and passive context producer place the reminder
// after the tool batch. Hold both child replies until the parent has committed
// Spawn and observed the reminder, then release the arrivals one by one.
test('native TTSR developer reminder survives staged Spawn, independent arrivals and physical restart', { timeout: 240_000 }, async (t) => {
  const reminder = 'HOST-RULE-GUIDANCE: preserve every automatic reminder and both completed child memories';
  const trigger = 'HOST-RULE-MATCH';
  const path = 'host-rule-trigger.txt';
  const names = ['ALPHA', 'BETA'];
  const memories = names.map((name) => `HOST-${name}-MEMORY`);
  const acknowledgments = names.map((name) => `HOST-RULE-SAW-${name}`);
  const releases = names.map(() => deferred());
  const children = [0, 0];
  let parentStep = 0;
  const fixture = await createNativeFixture(t, {
    label: 'host-rule-spawn', bridge,
    settings: { ttsr: { enabled: true, builtinRules: false, judge: 'off', interruptMode: 'never', repeatMode: 'once' } },
    rules: { 'host-message-boundary.md': `---\ncondition: "${trigger}"\nscope: "tool:write(*.txt)"\ninterruptMode: never\n---\n${reminder}\n` },
    async onRequest(request, { send }) {
      const assignment = visibleText(request.messages.filter((message) => message.role === 'user').at(-1)).trimEnd();
      const child = names.findIndex((name) => assignment.endsWith(`HOST CHILD ${name}`));
      if (child !== -1) {
        assert.equal(++children[child], 1, 'each real child samples once and ends with a plain reply');
        await releases[child].promise;
        return send(memories[child]);
      }
      const text = visibleText(request.messages);
      switch (++parentStep) {
        case 1: return send(spineCall('spine_open', { goal: 'HOST-RULE-OWNER' }));
        case 2: return send([
          spineCall('spine_spawn', { tasks: [
            { summary: 'Host Alpha', prompt: 'HOST CHILD ALPHA' },
            { summary: 'Host Beta', prompt: 'HOST CHILD BETA' },
          ] }),
          { name: 'write', arguments: { i: 'Triggering isolated native rule', path, content: `${trigger}\nreal native write\n` } },
        ]);
        case 3:
          assert.equal(count(text, reminder), 1, 'actual automatic developer guidance reaches the very next provider request exactly once');
          assertProviderToolPair(request, path);
          assertProviderToolPair(request, 'xd://spine_spawn');
          assert.ok(memories.every((memory) => !text.includes(memory)), 'staged Spawn does not wait for children');
          return send('HOST-RULE-FIRST-DONE');
        case 4:
          assert.equal(count(text, reminder), 1, 'the first independent arrival preserves the developer guidance');
          assert.ok(text.includes(memories[0]) && !text.includes(memories[1]));
          return send(acknowledgments[0]);
        case 5:
          assert.equal(count(text, reminder), 1);
          assert.ok(memories.every((memory) => text.includes(memory)));
          return send(acknowledgments[1]);
        case 6:
          assert.equal(count(text, reminder), 1, 'live continuation cannot lose or duplicate the host reminder');
          return send('HOST-RULE-CONTINUED');
        case 7:
          assert.equal(count(text, reminder), 1, 'physical restart replays the real reminder exactly once');
          assert.ok(text.includes('HOST-ALPHA-MEMORY') && text.includes('HOST-BETA-MEMORY'));
          return send(spineCall('spine_next', { memory: 'HOST-RULE-NEXT-MEMORY', goal: 'HOST-RULE-NEXT-OWNER' }));
        case 8:
          assertPendingFold(request, '1.1', 'HOST-RULE-NEXT-MEMORY');
          assert.ok(text.includes('HOST-RULE-NEXT-OWNER'));
          assert.ok(count(text, reminder) <= 1, 'closing its old scope never duplicates guidance');
          return send('HOST-RULE-NEXT-READY');
        case 9:
          assertFoldedMemory(request, '1.1', 'HOST-RULE-NEXT-MEMORY');
          return send(spineCall('spine_close', { memory: 'HOST-RULE-CLOSE-MEMORY' }));
        case 10:
          assertPendingFold(request, '1.2', 'HOST-RULE-CLOSE-MEMORY');
          return send('HOST-RULE-CLOSE-ACKNOWLEDGED');
        case 11:
          assertFoldedMemory(request, '1.2', 'HOST-RULE-CLOSE-MEMORY');
          return send('HOST-RULE-RECOVERED-DONE');
        default: assert.fail(`Unexpected host-rule parent request ${parentStep}`);
      }
    },
  });
  let rpc;
  try {
    rpc = await fixture.start();
    assert.equal((await rpc.prompt('Exercise the isolated automatic rule with independent real children.')).status, 'completed');
    assert.equal(await readFile(join(fixture.workspace, path), 'utf8'), `${trigger}\nreal native write\n`);
    let state = await snapshot(rpc);
    assert.equal(sourceCount(state.source, reminder), 1, 'canonical Source includes the following developer message once');
    let rows = await readJournal(state.sessionFile);
    healthy(rows);
    const reminders = rows.filter((row) => row.message?.role === 'developer' && visibleText(row.message).includes(reminder));
    assert.equal(reminders.length, 1, 'guidance was produced and persisted by the real host as developer');
    assert.equal(rows.filter((row) => row.type === 'ttsr_injection' && row.injectedRules?.includes('host-message-boundary')).length, 1,
      'native TTSR injection/cooldown entry proves real rule matching, not a bridge-created message');
    const committed = commits(rows).find((row) => row.data.record.record.executions.some(({ operation }) => operation.type === 'spawn'));
    assert.ok(committed, 'the parent commits Spawn while the child replies are held');
    assert.deepEqual(rows.filter((row) => row.customType === 'spine-arrival'), []);
    assert.equal(executions(rows, 'spawn').length, 1);
    assert.equal(executions(rows, 'spawn')[0].operation.tasks.length, 2);
    assertJournalToolPairs(rows);
    for (const [i, release] of releases.entries()) {
      release.resolve();
      await rpc.event((frame) => frame.type === 'agent_end' && frame.messages?.some((message) =>
        message.role === 'assistant' && visibleText(message) === acknowledgments[i]), `native wake for ${names[i]}`);
    }
    assert.deepEqual(children, [1, 1]);
    rows = await readJournal(state.sessionFile);
    const arrivals = rows.filter((row) => row.type === 'custom' && row.customType === 'spine-arrival');
    assert.deepEqual(arrivals.map(({ data }) => [data.outcome, data.memory]), memories.map((memory) => ['completed', memory]));
    const reminderIndex = rows.findIndex((row) => row.id === reminders[0].id);
    const spawnIndex = rows.findIndex((row) => row.id === committed.id);
    assert.ok(reminderIndex !== -1 && spawnIndex !== -1);
    assert.ok(arrivals.every((row) => rows.indexOf(row) > Math.max(reminderIndex, spawnIndex)));
    assert.equal((await rpc.prompt('Continue without changing the current owner.')).status, 'completed');
    state = await snapshot(rpc);
    for (const memory of memories) assert.equal(sourceCount(state.source, memory), 1, 'each arrival enters canonical Source once');
    await rpc.close();
    rpc = await fixture.restart(state.sessionFile);
    const recovered = await snapshot(rpc);
    assert.deepEqual(recovered.source, state.source, 'physical restart preserves canonical Source exactly');
    assert.deepEqual(recovered.projection, state.projection, 'real WASM restart preserves committed Spawn ownership');
    assert.equal((await rpc.prompt('Use Next after recovery.')).status, 'completed');
    assert.equal((await rpc.prompt('Use Close after observing the first Fold.')).status, 'completed');
    assert.equal((await rpc.prompt('Verify the next Fold after Close.')).status, 'completed');
    const finished = await snapshot(rpc);
    rows = await readJournal(finished.sessionFile);
    healthy(rows);
    assertJournalToolPairs(rows);
    assert.equal(executions(rows, 'spawn').length, 1, 'recovery never repeats Spawn');
    assert.deepEqual(rows.filter((row) => row.customType === 'spine-arrival'), arrivals, 'restart does not repeat the arrivals');
    assert.equal(executions(rows, 'next').length, 1);
    assert.equal(executions(rows, 'close').length, 1);
    assert.equal(sourceCount(finished.source, reminder), 1);
    assert.deepEqual(finished.projection.cursor, [1]);
    const childFiles = (await readdir(join(fixture.root, 'sessions'), { recursive: true }))
      .filter((name) => name.endsWith('.jsonl') && name.includes('spine-spawn'));
    assert.equal(childFiles.length, 2, 'two actual child process journals');
    for (const arrival of arrivals) {
      const name = childFiles.find((file) => file.endsWith(`.${arrival.data.producer.join('.')}.jsonl`));
      assert.ok(name);
      const childRows = await readJournal(join(fixture.root, 'sessions', name));
      healthy(childRows);
      const reply = childRows.findLast((row) => row.message?.role === 'assistant');
      assert.equal(reply?.message.stopReason, 'stop');
      assert.equal(visibleText(reply?.message), arrival.data.memory);
    }
    await rpc.close();
    rpc = await fixture.restart(finished.sessionFile);
    const twice = await snapshot(rpc);
    assert.deepEqual(twice.source, finished.source);
    assert.deepEqual(twice.projection, finished.projection);
    healthy(await readJournal(twice.sessionFile));
    await rpc.close();
  } finally {
    for (const release of releases) release.resolve();
    await stop(rpc);
  }
});

// display:false idle custom messages persist without message_end. Streaming
// aside delivery instead joins the agent's next step, after an in-flight reply.
// Both must be consumed from the native branch, not synthesized from events.
test('native idle durable custom resource and asynchronous streaming aside reach consumers exactly once', { timeout: 180_000 }, async (t) => {
  const idle = 'HOST-IDLE-DURABLE-RESOURCE';
  const aside = 'HOST-ASYNC-STREAMING-ASIDE';
  const entered = deferred();
  const release = deferred();
  const fixture = await createNativeFixture(t, {
    label: 'host-custom-aside', bridge,
    async onRequest(request, { index, send }) {
      const text = visibleText(request.messages);
      switch (index) {
        case 1: return send(spineCall('spine_open', { goal: 'HOST-CUSTOM-OWNER' }));
        case 2: return send('HOST-CUSTOM-READY');
        case 3:
          assert.equal(count(text, idle), 1, 'idle display:false custom append reaches the next real provider');
          assert.equal(count(text, aside), 0, 'aside has not arrived before the request being held');
          entered.resolve();
          await release.promise;
          return send({ name: 'write', arguments: { i: 'Completing actual held tool batch', path: 'aside-real-write.txt', content: 'real write\n' } });
        case 4:
          assert.equal(count(text, idle), 1);
          assert.equal(count(text, aside), 1, 'non-interrupting asynchronous aside reaches the next tool-loop provider exactly once');
          assertProviderToolPair(request, 'aside-real-write.txt');
          return send('HOST-ASIDE-CONSUMED');
        case 5:
          assert.equal(count(text, idle), 1, 'restart retains idle resource');
          assert.equal(count(text, aside), 1, 'restart retains asynchronously delivered aside');
          return send(spineCall('spine_close', { memory: 'HOST-CUSTOM-CLOSE-MEMORY' }));
        case 6:
          assertPendingFold(request, '1.1', 'HOST-CUSTOM-CLOSE-MEMORY');
          return send('HOST-CUSTOM-CLOSE-ACKNOWLEDGED');
        case 7:
          assertFoldedMemory(request, '1.1', 'HOST-CUSTOM-CLOSE-MEMORY');
          return send('HOST-CUSTOM-DONE');
        default: assert.fail(`Unexpected custom/aside provider request ${index}`);
      }
    },
  });
  let rpc;
  try {
    rpc = await fixture.start();
    assert.equal((await rpc.prompt('Open the custom resource owner.')).status, 'completed');
    const idleResult = await command(rpc, 'idle-custom', { text: idle });
    assert.equal(idleResult.invoked, false);
    assert.equal(idleResult.streaming, false);
    assert.equal(fixture.requests.length, 2, 'idle durable resource does not start inference');
    const pending = rpc.prompt('Consume the pending durable resource and finish an actual write.');
    pending.catch(() => {});
    await Promise.race([
      entered.promise,
      pending.then((result) => assert.fail(`Native provider did not reach the held aside request: ${result.status}`)),
    ]);
    const asideResult = await command(rpc, 'streaming-aside', { text: aside });
    assert.equal(asideResult.invoked, false);
    assert.equal(asideResult.streaming, true);
    release.resolve();
    assert.equal((await pending).status, 'completed');
    const state = await snapshot(rpc);
    for (const marker of [idle, aside]) {
      assert.equal(sourceCount(state.source, marker), 1);
      assert.equal(state.branch.filter((row) => row.type === 'custom_message' && visibleText(row).includes(marker)).length, 1,
        'resource lives in one actual durable custom_message entry');
    }
    healthy(await readJournal(state.sessionFile));
    assertJournalToolPairs(await readJournal(state.sessionFile));
    await rpc.close();
    rpc = await fixture.restart(state.sessionFile);
    const recovered = await snapshot(rpc);
    assert.deepEqual(recovered.source, state.source);
    assert.deepEqual(recovered.projection, state.projection);
    assert.equal((await rpc.prompt('Close after native resource recovery.')).status, 'completed');
    assert.equal((await rpc.prompt('Verify folded native resource memory.')).status, 'completed');
    const finished = await snapshot(rpc);
    healthy(await readJournal(finished.sessionFile));
    assert.equal(executions(await readJournal(finished.sessionFile), 'close').length, 1);
    await rpc.close();
  } finally { release.resolve(); await stop(rpc); }
});

test('native queued user during Close preserves assistant source order and physical restart', { timeout: 180_000 }, async (t) => {
  const steer = 'HOST-QUEUED-USER-DURING-CLOSE';
  const memory = 'HOST-QUEUED-CLOSE-MEMORY';
  const entered = deferred();
  const release = deferred();
  const fixture = await createNativeFixture(t, {
    label: 'host-user-close', bridge,
    async onRequest(request, { index, send }) {
      const text = visibleText(request.messages);
      switch (index) {
        case 1: return send(spineCall('spine_open', { goal: 'HOST-QUEUED-PARENT' }));
        case 2: return send(spineCall('spine_open', { goal: 'HOST-QUEUED-CHILD' }));
        case 3:
          entered.resolve();
          await release.promise;
          return send([
            spineCall('spine_close', { memory }),
            { name: 'write', arguments: { i: 'Completing queued Close batch', path: 'close-batch.txt', content: 'batch completed\n' } },
          ]);
        case 4:
          assert.equal(count(text, steer), 1, 'queued user reaches the next actual provider exactly once');
          assertPendingFold(request, '1.1.1', memory);
          return send({ name: 'write', arguments: { i: 'Consuming queued user request', path: 'steering-result.txt', content: `${steer}\n` } });
        case 5: return send('HOST-QUEUED-USER-CONSUMED');
        case 6:
          assert.equal(count(text, steer), 1, 'restart preserves the queued user');
          assertFoldedMemory(request, '1.1.1', memory);
          return send(spineCall('spine_close', { memory: 'HOST-QUEUED-PARENT-DONE' }));
        case 7: return send('HOST-QUEUED-RESTART-DONE');
        default: assert.fail(`Unexpected queued user provider request ${index}`);
      }
    },
  });
  let rpc;
  try {
    rpc = await fixture.start();
    const pending = rpc.prompt('Open a parent and child, then close the child while accepting new user input.');
    pending.catch(() => {});
    await Promise.race([
      entered.promise,
      pending.then((result) => assert.fail(`Native provider did not reach held Close: ${result.status}`)),
    ]);
    await rpc.command('steer', { message: steer });
    release.resolve();
    assert.equal((await pending).status, 'completed');
    assert.equal(await readFile(join(fixture.workspace, 'close-batch.txt'), 'utf8'), 'batch completed\n');
    assert.equal(await readFile(join(fixture.workspace, 'steering-result.txt'), 'utf8'), `${steer}\n`);
    const state = await snapshot(rpc);
    assert.equal(sourceCount(state.source, steer), 1);
    healthy(await readJournal(state.sessionFile));
    assertJournalToolPairs(await readJournal(state.sessionFile));
    await rpc.close();
    rpc = await fixture.restart(state.sessionFile);
    const recovered = await snapshot(rpc);
    assert.deepEqual(recovered.source, state.source);
    assert.deepEqual(recovered.projection, state.projection);
    assert.equal((await rpc.prompt('Close the parent after queued user recovery.')).status, 'completed');
    const finished = await snapshot(rpc);
    healthy(await readJournal(finished.sessionFile));
    assert.equal(executions(await readJournal(finished.sessionFile), 'close').length, 2);
    await rpc.close();
  } finally { release.resolve(); await stop(rpc); }
});

test('native file mention and bash execution persist while excluded execution and ephemeral replies stay out of provider context', { timeout: 180_000 }, async (t) => {
  const file = 'HOST-FILE-MENTION-CONTENT';
  const bash = 'HOST-BASH-VISIBLE-OUTPUT';
  const excluded = 'HOST-BASH-EXCLUDED-OUTPUT';
  const ephemeralPrompt = 'HOST-EPHEMERAL-QUESTION';
  const ephemeralAnswer = 'HOST-EPHEMERAL-ANSWER';
  const fixture = await createNativeFixture(t, {
    label: 'host-file-bash-ephemeral', bridge,
    onRequest(request, { index, send }) {
      const text = visibleText(request.messages);
      switch (index) {
        case 1:
          assert.equal(count(text, file), 1, 'real @file mention auto-read reaches initial provider');
          return send(spineCall('spine_open', { goal: 'HOST-FILE-OWNER' }));
        case 2:
          assert.equal(count(text, file), 1, 'file mention survives projected context');
          return send('HOST-FILE-READY');
        case 3:
          assert.equal(count(text, ephemeralPrompt), 1, 'ephemeral operation uses the real provider path');
          return send(ephemeralAnswer);
        case 4:
          assert.equal(count(text, file), 1, 'recovered file mention is not lost');
          assert.equal(request.messages.filter((message) => visibleText(message).includes(bash)).length, 1,
            'one native execution transcript carries its command and output to the provider');
          assert.equal(count(text, excluded), 0, 'excludeFromContext execution is not leaked by source projection');
          assert.equal(count(text, ephemeralPrompt), 0, 'side question is never admitted into Source');
          assert.equal(count(text, ephemeralAnswer), 0, 'side reply is never admitted into Source');
          return send(spineCall('spine_close', { memory: 'HOST-FILE-CLOSE-MEMORY' }));
        case 5:
          assertPendingFold(request, '1.1', 'HOST-FILE-CLOSE-MEMORY');
          assert.equal(count(text, excluded), 0);
          assert.equal(count(text, ephemeralAnswer), 0);
          return send('HOST-FILE-CLOSE-ACKNOWLEDGED');
        case 6:
          assertFoldedMemory(request, '1.1', 'HOST-FILE-CLOSE-MEMORY');
          assert.equal(count(text, excluded), 0);
          assert.equal(count(text, ephemeralAnswer), 0);
          return send('HOST-FILE-DONE');
        default: assert.fail(`Unexpected file/bash/ephemeral provider request ${index}`);
      }
    },
  });
  await writeFile(join(fixture.workspace, 'host-mentioned.txt'), `${file}\n`);
  let rpc;
  try {
    rpc = await fixture.start();
    assert.equal((await rpc.prompt('Read @host-mentioned.txt and keep its actual attachment in scope.')).status, 'completed');
    const before = await snapshot(rpc);
    assert.equal(before.branch.filter((row) => row.message?.role === 'fileMention').length, 1);
    assert.equal((await command(rpc, 'bash', { text: bash })).result.exitCode, 0);
    assert.equal((await command(rpc, 'excluded-bash', { text: excluded })).result.exitCode, 0);
    const beforeSide = await snapshot(rpc);
    const side = await command(rpc, 'ephemeral', { text: ephemeralPrompt });
    assert.ok(JSON.stringify(side.result).includes(ephemeralAnswer), 'actual ephemeral result is returned without main-turn persistence');
    const afterSide = await snapshot(rpc);
    assert.deepEqual(afterSide.source, beforeSide.source, 'ephemeral reply never changes canonical Source');
    assert.deepEqual(afterSide.projection, beforeSide.projection);
    assert.deepEqual(afterSide.branch, beforeSide.branch, 'ephemeral side turn never creates journal messages');
    assert.equal(afterSide.branch.filter((row) => row.message?.role === 'bashExecution' && row.message.output.includes(bash)).length, 1);
    assert.equal(afterSide.branch.filter((row) => row.message?.role === 'bashExecution' && row.message.output.includes(excluded)
      && row.message.excludeFromContext === true).length, 1, 'excluded execution is still durably recorded by Native');
    healthy(await readJournal(afterSide.sessionFile));
    await rpc.close();
    rpc = await fixture.restart(afterSide.sessionFile);
    const restored = await snapshot(rpc);
    assert.ok(!JSON.stringify(restored.source).includes(ephemeralPrompt) && !JSON.stringify(restored.source).includes(ephemeralAnswer));
    assert.equal((await rpc.prompt('Consume the native attachment and visible execution after restart, then Close.')).status, 'completed');
    assert.equal((await rpc.prompt('Verify the folded file and execution memory.')).status, 'completed');
    const finished = await snapshot(rpc);
    healthy(await readJournal(finished.sessionFile));
    assertJournalToolPairs(await readJournal(finished.sessionFile));
    assert.deepEqual(finished.projection.cursor, [1]);
    await rpc.close();
  } finally { await stop(rpc); }
});

test('native incomplete-todo continuation admits its automatic reminder and preserves real completion after restart', { timeout: 180_000 }, async (t) => {
  const task = 'Write todo-source-proof.txt with the completed source-boundary proof';
  const proof = 'HOST-TODO-SOURCE-PROOF\n';
  let deliveredReminder;
  const fixture = await createNativeFixture(t, {
    label: 'host-todo-reminder', bridge,
    settings: { todo: { enabled: true, reminders: true, remindersMax: 1 } },
    onRequest(request, { index, send }) {
      const text = visibleText(request.messages);
      switch (index) {
        case 1: return send([
          spineCall('spine_open', { goal: 'HOST-TODO-OWNER' }),
          { name: 'todo', arguments: { op: 'init', items: [task] } },
        ]);
        case 2: return send('HOST-TODO-EARLY-STOP: the actual output file has not been written.');
        case 3: {
          const reminders = request.messages.filter((message) =>
            (message.role === 'user' || message.role === 'developer') && visibleText(message).includes(task));
          assert.equal(reminders.length, 1, 'reminder itself reaches the provider once, not just the earlier todo toolResult');
          deliveredReminder = visibleText(reminders[0]);
          return send([
            { name: 'write', arguments: { i: 'Writing actual pending task output', path: 'todo-source-proof.txt', content: proof } },
            { name: 'todo', arguments: { op: 'done', task } },
          ]);
        }
        case 4: return send(spineCall('spine_close', { memory: 'HOST-TODO-COMPLETED-MEMORY' }));
        case 5:
          assertPendingFold(request, '1.1', 'HOST-TODO-COMPLETED-MEMORY');
          return send('The actual file is written and the task is complete.');
        case 6:
          assertFoldedMemory(request, '1.1', 'HOST-TODO-COMPLETED-MEMORY');
          return send('The actual file and completed task remain available.');
        default: assert.fail(`Unexpected todo continuation request ${index}`);
      }
    },
  });
  let rpc;
  try {
    rpc = await fixture.start();
    // Native canonical todo persistence currently requires its top-level
    // receipt; xd://todo recovery is an independent host bug, reported with
    // isolated evidence instead of accepting an empty restored list here.
    await command(rpc, 'present-todo');
    assert.equal((await rpc.prompt('Create the output file while tracking its real completion.')).status, 'completed');
    // Provider HTTP and RPC stdout are independent transports. Verify the
    // reminder event after the RPC prompt settles, not at HTTP request entry.
    const events = fixture.rpcs[0].frames.filter((frame) => frame.type === 'todo_reminder');
    assert.equal(events.length, 1, 'real incomplete tasks trigger one native continuation');
    assert.deepEqual(events[0].todos.map((todo) => todo.content), [task]);
    assert.equal(await readFile(join(fixture.workspace, 'todo-source-proof.txt'), 'utf8'), proof);
    const current = await snapshot(rpc);
    const rows = await readJournal(current.sessionFile);
    healthy(rows);
    assertJournalToolPairs(rows);
    const stopped = rows.findIndex((row) => row.message?.role === 'assistant'
      && visibleText(row.message).startsWith('HOST-TODO-EARLY-STOP:'));
    assert.ok(stopped >= 0);
    const reminder = rows.slice(stopped + 1).find((row) => row.message?.role === 'developer'
      && visibleText(row.message).includes(task));
    assert.ok(reminder, 'native completion reminder is durably recorded after the early stop');
    const reminderText = visibleText(reminder.message);
    assert.equal(deliveredReminder, reminderText, 'provider receives the actual persisted reminder unchanged');
    assert.equal(current.source.cells.filter((cell) => cell.item.Message?.message.content === reminderText).length, 1,
      'automatic reminder acquires one canonical source identity');
    const phases = (await rpc.command('get_state')).todoPhases;
    assert.deepEqual(phases.flatMap((phase) => phase.tasks).map((todo) => [todo.content, todo.status]), [[task, 'completed']]);
    assert.deepEqual(current.projection.cursor, [1]);
    await rpc.close();
    rpc = await fixture.restart(current.sessionFile);
    assert.deepEqual((await rpc.command('get_state')).todoPhases, phases);
    const restored = await snapshot(rpc);
    assert.deepEqual(restored.source, current.source);
    assert.deepEqual(restored.projection, current.projection);
    assert.equal((await rpc.prompt('Inspect the completed output after physical restart.')).status, 'completed');
    assert.equal(rpc.frames.filter((frame) => frame.type === 'todo_reminder').length, 0,
      'completed tasks cannot trigger a new recovery reminder');
    healthy(await readJournal(restored.sessionFile));
    await rpc.close();
  } finally { await stop(rpc); }
});

test('native context_notes projection preserves latest notebook, replacement and clearing through restart without inventing Sources', { timeout: 180_000 }, async (t) => {
  const first = 'HOST-NATIVE-NOTE-FIRST retain this durable notebook';
  const second = 'HOST-NATIVE-NOTE-SECOND replace the old durable notebook';
  const notes = (request, marker) => request.messages.filter((message) =>
    (message.role === 'user' || message.role === 'developer') && visibleText(message).includes(marker));
  const fixture = await createNativeFixture(t, {
    label: 'host-context-notes', bridge,
    settings: { compaction: { experimentalContextManagement: true } },
    onRequest(request, { index, send }) {
      switch (index) {
        case 1: return send(spineCall('spine_open', { goal: 'HOST-NOTE-OWNER' }));
        case 2: return send({ name: 'context_notes', arguments: { text: first } });
        case 3:
          assert.equal(notes(request, first).length, 1, 'native injected notebook reaches the real provider, not just its tool call');
          return send('First notebook is available.');
        case 4:
          assert.equal(notes(request, first).length, 1, 'physical restart restores the durable notebook');
          return send({ name: 'context_notes', arguments: { text: second } });
        case 5:
          assert.equal(notes(request, first).length, 0);
          assert.equal(notes(request, second).length, 1);
          return send('Only the replacement notebook is available.');
        case 6:
          assert.equal(notes(request, first).length, 0);
          assert.equal(notes(request, second).length, 1, 'second restart restores the replacement');
          return send({ name: 'context_notes', arguments: { text: '' } });
        case 7:
          assert.equal(notes(request, first).length, 0);
          assert.equal(notes(request, second).length, 0, 'clear removes the runtime notebook injection');
          return send(spineCall('spine_close', { memory: 'HOST-NOTE-OWNER-CLOSED' }));
        case 8: return send('Notebook cleared and owner closed.');
        case 9:
          assert.equal(notes(request, first).length, 0);
          assert.equal(notes(request, second).length, 0, 'clear survives a physical restart');
          return send('No cleared notebook is reintroduced.');
        default: assert.fail(`Unexpected native notebook request ${index}`);
      }
    },
  });
  let rpc;
  try {
    rpc = await fixture.start();
    assert.equal((await rpc.prompt('Maintain a durable notebook inside the current Spine owner.')).status, 'completed');
    let current = await snapshot(rpc);
    const assertNotebookIsNotSource = (state) => {
      assert.equal(state.source.cells.some((cell) =>
        cell.item.Message?.message.content.includes(first) || cell.item.Message?.message.content.includes(second)), false);
    };
    assertNotebookIsNotSource(current);
    for (const prompt of ['Replace the notebook.', 'Clear the notebook.', 'Verify the cleared notebook.']) {
      await rpc.close();
      rpc = await fixture.restart(current.sessionFile);
      const restored = await snapshot(rpc);
      assert.deepEqual(restored.source, current.source);
      assert.deepEqual(restored.projection, current.projection);
      assert.equal((await rpc.prompt(prompt)).status, 'completed');
      current = await snapshot(rpc);
      assertNotebookIsNotSource(current);
      healthy(await readJournal(current.sessionFile));
    }
    assert.deepEqual(current.projection.cursor, [1]);
    const rows = await readJournal(current.sessionFile);
    assert.deepEqual(rows.filter((row) => row.customType === 'experimental_context_notes').map((row) => row.data.text),
      [first, second, '']);
    assertJournalToolPairs(rows);
  } finally { await stop(rpc); }
});

for (const kernelMode of ['session', 'per-call']) {
  test(`native Python ${kernelMode} execution persists visible/error results and isolates excluded/streaming notifications through restart`, { timeout: 180_000 }, async (t) => {
    const visible = `PYTHON-VISIBLE-${kernelMode}`;
    const excluded = `PYTHON-EXCLUDED-${kernelMode}`;
    const failure = `PYTHON-ERROR-${kernelMode}`;
    const streaming = `PYTHON-QUEUED-${kernelMode}`;
    const entered = deferred();
    const release = deferred();
    const providerCount = (request, marker) => request.messages.filter((message) =>
      (message.role === 'user' || message.role === 'developer') && visibleText(message).includes(marker)).length;
    const fixture = await createNativeFixture(t, {
      label: `host-python-${kernelMode}`, bridge,
      settings: { python: { kernelMode, ...(process.env.OMP_NATIVE_PYTHON ? { interpreter: process.env.OMP_NATIVE_PYTHON } : {}) } },
      async onRequest(request, { index, send }) {
        switch (index) {
          case 1: return send(spineCall('spine_open', { goal: `PYTHON-OWNER-${kernelMode}` }));
          case 2: return send('Ready for actual Python execution.');
          case 3:
            assert.equal(providerCount(request, visible), 1);
            assert.equal(providerCount(request, failure), 1);
            assert.equal(providerCount(request, excluded), 0);
            assert.equal(providerCount(request, streaming), 0);
            entered.resolve();
            await release.promise;
            return send('The in-flight provider reply completed.');
          case 4:
          case 5:
            for (const marker of [visible, failure, streaming]) assert.equal(providerCount(request, marker), 1);
            assert.equal(providerCount(request, excluded), 0);
            return send(index === 4 ? 'Queued Python output has entered the next native prompt.'
              : spineCall('spine_close', { memory: `PYTHON-CLOSE-${kernelMode}` }));
          case 6:
            assertPendingFold(request, '1.1', `PYTHON-CLOSE-${kernelMode}`);
            return send('Python history recovered and Close acknowledged.');
          case 7:
            assertFoldedMemory(request, '1.1', `PYTHON-CLOSE-${kernelMode}`);
            assert.equal(providerCount(request, excluded), 0);
            return send('Python history recovered and owner closed.');
          default: assert.fail(`Unexpected Python provider request ${index}`);
        }
      },
    });
    let rpc;
    try {
      rpc = await fixture.start();
      assert.equal((await rpc.prompt('Open an owner for real Python execution.')).status, 'completed');
      const normal = await command(rpc, 'python', {
        text: `from pathlib import Path\nPath("python-visible-proof.txt").write_text("${visible}")\nprint("${visible}")`,
      });
      assert.equal(normal.result.exitCode, 0, JSON.stringify(normal.result));
      assert.equal(normal.result.output.trim(), visible);
      const privateResult = await command(rpc, 'excluded-python', {
        text: `from pathlib import Path\nPath("python-excluded-proof.txt").write_text("${excluded}")\nprint("${excluded}")`,
      });
      assert.equal(privateResult.result.exitCode, 0, JSON.stringify(privateResult.result));
      assert.equal(privateResult.result.output.trim(), excluded);
      const error = await command(rpc, 'python', { text: `raise ValueError("${failure}")` });
      assert.notEqual(error.result.exitCode, 0);
      assert.ok(error.result.output.includes(failure));
      const pending = rpc.prompt('Consume visible and failed Python notifications, not the excluded result.');
      pending.catch(() => {});
      await Promise.race([
        entered.promise,
        pending.then((result) => assert.fail(`Python provider did not reach the held request: ${result.status}`)),
      ]);
      const queued = await command(rpc, 'streaming-python', {
        text: `from pathlib import Path\nPath("python-queued-proof.txt").write_text("${streaming}")\nprint("${streaming}")`,
      });
      assert.equal(queued.result.exitCode, 0, JSON.stringify(queued.result));
      assert.equal(queued.result.output.trim(), streaming);
      assert.equal(queued.streaming, true);
      assert.equal(queued.pending, true, 'native result waits for its safe persistence boundary');
      const before = await snapshot(rpc);
      assert.equal(before.branch.some((row) => row.message?.role === 'pythonExecution'
        && row.message.output.includes(streaming)), false);
      release.resolve();
      assert.equal((await pending).status, 'completed');
      assert.equal((await rpc.prompt('Flush queued Python notifications at the next native prompt boundary.')).status, 'completed');
      const current = await snapshot(rpc);
      const rows = await readJournal(current.sessionFile);
      const executions = rows.filter((row) => row.message?.role === 'pythonExecution').map((row) => row.message);
      assert.equal(executions.length, 4);
      for (const marker of [visible, excluded, failure, streaming]) {
        assert.equal(executions.filter((message) => message.output.includes(marker)).length, 1);
      }
      assert.equal(executions.find((message) => message.output.includes(excluded)).excludeFromContext, true);
      for (const [path, marker] of [['python-visible-proof.txt', visible], ['python-excluded-proof.txt', excluded], ['python-queued-proof.txt', streaming]]) {
        assert.equal(await readFile(join(fixture.workspace, path), 'utf8'), marker);
      }
      healthy(rows);
      await rpc.close();
      rpc = await fixture.restart(current.sessionFile);
      const restored = await snapshot(rpc);
      assert.deepEqual(restored.source, current.source);
      assert.deepEqual(restored.projection, current.projection);
      assert.equal((await rpc.prompt('Close the owner after real Python history recovery.')).status, 'completed');
      assert.deepEqual((await snapshot(rpc)).projection.cursor, [1]);
      assert.equal((await rpc.prompt('Verify the folded memory of the closed Python owner.')).status, 'completed');
      healthy(await readJournal(current.sessionFile));
    } finally { release.resolve(); await stop(rpc); }
  });
}

const ttsrCases = [
  ...['never', 'prose-only', 'tool-only', 'always'].flatMap((mode) =>
    ['text', 'thinking', 'tool'].map((source) => ({ mode, source, contextMode: 'discard' }))),
  ...['text', 'thinking', 'tool'].map((source) => ({ mode: 'always', source, contextMode: 'keep' })),
  { mode: 'always', override: 'never', source: 'text', contextMode: 'discard' },
  { mode: 'never', override: 'tool-only', source: 'tool', contextMode: 'discard' },
];
for (const { mode, override, source, contextMode } of ttsrCases) {
  const effective = override ?? mode;
  const interrupted = effective === 'always' || (effective === 'tool-only' && source === 'tool')
    || (effective === 'prose-only' && source !== 'tool');
  const name = `${mode}-${source}-${contextMode}${override ? `-override-${override}` : ''}`;
  test(`native TTSR ${name} obeys interruption scope, preserves correction and resumes tree control`, { timeout: 180_000 }, async (t) => {
    const trigger = `TTSR-STREAM-MATCH-${name}`;
    const guidance = `TTSR-NATIVE-CORRECTION-${name}`;
    const path = 'ttsr-output.txt';
    const fixture = await createNativeFixture(t, {
      label: `host-ttsr-${name}`, bridge,
      settings: { ttsr: { enabled: true, builtinRules: false, judge: 'off', repeatMode: 'once',
        interruptMode: mode, contextMode } },
      rules: { 'mode-scope.md': `---\ncondition: "${trigger}"\nscope: "${source === 'tool' ? 'tool:write(*.txt)' : source}"\n${override ? `interruptMode: ${override}\n` : ''}---\n${guidance}\n` },
      async onRequest(request, { index, send, response }) {
        if (index === 1) return send(spineCall('spine_open', { goal: `TTSR-OWNER-${name}` }));
        if (index === 2) {
          const call = { index: 0, id: 'ttsr-stream-tool', type: 'function',
            function: { name: 'write', arguments: JSON.stringify({ i: 'Writing actual scoped rule output', path, content: trigger }) } };
          const delta = source === 'tool' ? { role: 'assistant', tool_calls: [call] }
            : source === 'thinking' ? { role: 'assistant', reasoning_content: trigger }
            : { role: 'assistant', content: trigger };
          const packet = { id: 'ttsr-native-stream', object: 'chat.completion.chunk', created: 1, model: request.model };
          response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
          response.write(`data: ${JSON.stringify({ ...packet, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
          await fixture.rpcs[0].event((frame) => interrupted ? frame.type === 'ttsr_triggered'
            : frame.type === 'message_update' && frame.assistantMessageEvent?.type
              === (source === 'tool' ? 'toolcall_delta' : source === 'thinking' ? 'thinking_delta' : 'text_delta'),
          `actual ${source} matcher consumes the stream`);
          if (!response.destroyed && !response.writableEnded) {
            // A completed thinking response needs its real visible answer;
            // otherwise native empty-stop recovery, not TTSR, owns the next turn.
            if (source === 'thinking' && !interrupted) response.write(`data: ${JSON.stringify({
              ...packet, choices: [{ index: 0, delta: { content: 'Completed answer after the scoped reasoning.' }, finish_reason: null }],
            })}\n\n`);
            response.end(`data: ${JSON.stringify({ ...packet, choices: [{ index: 0, delta: {}, finish_reason: source === 'tool' ? 'tool_calls' : 'stop' }],
              usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\ndata: [DONE]\n\n`);
          }
          return;
        }
        const notices = request.messages.filter((message) => (message.role === 'user' || message.role === 'developer')
          && visibleText(message).includes(guidance));
        if (index === 3) {
          assert.equal(notices.length, 1, 'actual native correction reaches the very next continuation once');
          if (interrupted && source === 'text') {
            assert.equal(request.messages.some((message) => message.role === 'assistant'
              && visibleText(message).includes(trigger)), false,
            'native buildSessionContext excludes unsafe aborted replies from provider traffic in both modes');
          }
          return send(`TTSR-CORRECTION-CONSUMED-${name}`);
        }
        if (index === 4) {
          assert.equal(notices.length, 1, 'physical restart restores the native correction once');
          return send(spineCall('spine_close', { memory: `TTSR-CLOSE-${name}` }));
        }
        if (index === 5) {
          assertPendingFold(request, '1.1', `TTSR-CLOSE-${name}`);
          return send('Recovered Close acknowledged after native TTSR.');
        }
        if (index === 6) {
          assertFoldedMemory(request, '1.1', `TTSR-CLOSE-${name}`);
          return send('Recovered control committed after native TTSR.');
        }
        assert.fail(`Unexpected TTSR request ${index}`);
      },
    });
    let rpc;
    try {
      rpc = await fixture.start();
      assert.equal((await rpc.prompt('Exercise the native rule while preserving the current owner.')).status, 'completed');
      // Passive text/thinking reminders continue after the originating prompt
      // settles; wait for the real continuation rather than snapshotting mid-run.
      await rpc.event((frame) => frame.type === 'message_end' && frame.message?.role === 'assistant'
        && visibleText(frame.message).includes(`TTSR-CORRECTION-CONSUMED-${name}`), 'native corrective continuation finishes');
      const current = await snapshot(rpc);
      if (interrupted && source === 'text') {
        assert.equal(current.messages.some((message) => message.role === 'assistant'
          && message.responseId === 'ttsr-native-stream'), contextMode === 'keep',
        'native keep/discard controls the live interrupted transcript');
      }
      const rows = await readJournal(current.sessionFile);
      healthy(rows);
      assert.equal(rows.filter((row) => row.message?.role === 'assistant'
        && row.message.responseId === 'ttsr-native-stream' && row.message.stopReason === 'aborted').length,
      interrupted ? 1 : 0, 'actual host abort behavior follows mode and source');
      assert.equal(rows.filter((row) => row.type === 'ttsr_injection').length, 1);
      assert.equal(rows.filter((row) => row.type === 'message' || row.type === 'custom_message')
        .filter((row) => visibleText(row.message ?? row).includes(guidance)).length, 1);
      if (source === 'tool') {
        if (interrupted) await assert.rejects(readFile(join(fixture.workspace, path)), { code: 'ENOENT' });
        else assert.equal(await readFile(join(fixture.workspace, path), 'utf8'), trigger);
      }
      assert.deepEqual(current.projection.cursor, [1, 1]);
      await rpc.close();
      rpc = await fixture.restart(current.sessionFile);
      const restored = await snapshot(rpc);
      assert.deepEqual(restored.source, current.source);
      assert.deepEqual(restored.projection, current.projection);
      assert.equal((await rpc.prompt('Close after native interruption and physical recovery.')).status, 'completed');
      assert.equal((await rpc.prompt('Verify the folded memory after native TTSR recovery.')).status, 'completed');
      const finished = await snapshot(rpc);
      assert.deepEqual(finished.projection.cursor, [1]);
      healthy(await readJournal(current.sessionFile));
      assert.equal(executions(await readJournal(current.sessionFile), 'close').length, 1);
    } finally { await stop(rpc); }
  });
}

test('native default xd://todo preserves partial task completion across physical restart', {
  timeout: 180_000,
}, async (t) => {
  const first = 'Persist the first actual task output';
  const second = 'Keep the second actual task pending after restart';
  const fixture = await createNativeFixture(t, {
    label: 'host-default-xdev-todo', bridge,
    settings: { todo: { enabled: true, reminders: false } },
    onRequest(request, { index, send }) {
      if (index === 1) return send(spineCall('todo', { op: 'init', items: [first, second] }));
      if (index === 2) return send([
        { name: 'write', arguments: { i: 'Writing real completed todo output', path: 'native-todo-output.txt', content: first } },
        spineCall('todo', { op: 'done', task: first }),
      ]);
      if (index === 3) return send('First task completed; second task intentionally remains pending.');
      assert.fail(`Unexpected default todo provider request ${index}`);
    },
  });
  let rpc;
  try {
    rpc = await fixture.start();
    assert.equal((await rpc.prompt('Track two tasks through the default xd://todo surface.')).status, 'completed');
    assert.equal(await readFile(join(fixture.workspace, 'native-todo-output.txt'), 'utf8'), first);
    const state = await rpc.command('get_state');
    assert.deepEqual(state.todoPhases.flatMap((phase) => phase.tasks).map((task) => [task.content, task.status]),
      [[first, 'completed'], [second, 'in_progress']]);
    const rows = await readJournal(state.sessionFile);
    const receipt = rows.findLast((row) => row.message?.role === 'toolResult'
      && row.message.details?.xdev?.tool === 'todo' && row.message.details.xdev.inner?.op === 'done');
    assert.deepEqual(receipt.message.details.xdev.inner.phases, state.todoPhases);
    healthy(rows);
    await rpc.close();
    rpc = await fixture.restart(state.sessionFile);
    const restored = await rpc.command('get_state');
    assert.equal(restored.sessionFile, state.sessionFile);
    healthy(await readJournal(restored.sessionFile));
    assert.deepEqual(restored.todoPhases, state.todoPhases,
      'default native xdev todo must restore actual completed and pending tasks, not silently clear them');
  } finally { await stop(rpc); }
});
