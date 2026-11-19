import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNativeFixture, readJournal, spineCall, visibleText } from './fixture.mjs';

const driverPath = fileURLToPath(new URL('./stock-tree-spawn.driver.mjs', import.meta.url));
const phaseTimeoutMs = Number(process.env.OMP_NATIVE_TIMEOUT_MS ?? 60_000);
const settings = {
  startup: { setupWizard: false, showSplash: false, checkUpdate: false },
  providers: { cacheWarming: 'off' },
  spelling: { autocomplete: 'off' },
  composer: { predictions: false },
  disabledProviders: [
    'ollama', 'llama.cpp', 'lm-studio', 'apple', 'kilo', 'nvidia', 'ollama-cloud',
    'openai', 'qwen-portal', 'together', 'venice', 'xai', 'xiaomi',
    'xiaomi-token-plan-ams', 'xiaomi-token-plan-cn', 'xiaomi-token-plan-sgp',
    'zai', 'zenmux', 'amazon-bedrock', 'minimax-code', 'minimax-code-cn',
  ],
  branchSummary: { enabled: false },
};

async function runKeyboard(t, fixture, script, { resume } = {}) {
  const configPath = join(fixture.root, 'stock-keyboard.json');
  await writeFile(configPath, JSON.stringify({
    ...fixture.invocation,
    args: [...fixture.invocation.args, ...(resume ? ['--resume', resume] : [])],
    workspace: fixture.workspace, root: fixture.root,
    phaseTimeoutMs,
    env: fixture.environment, model: fixture.model, script,
  }));
  const driver = spawn(process.env.OMP_NATIVE_BUN ?? 'bun', [driverPath, configPath], {
    cwd: fixture.workspace, env: fixture.environment, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  driver.stdout.resume();
  driver.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const kill = () => {
    if (driver.pid === undefined) return;
    try { process.kill(-driver.pid, 'SIGKILL'); } catch { driver.kill('SIGKILL'); }
  };
  fixture.onError = kill;
  t.signal.addEventListener('abort', kill, { once: true });
  try {
    const [code, signal] = await new Promise((resolve, reject) => {
      driver.once('error', reject);
      driver.once('close', (code, signal) => resolve([code, signal]));
    });
    if (fixture.error) throw fixture.error;
    assert.equal(code, 0, `Stock TUI driver exited (${code ?? signal})\n${stderr}`);
  } finally {
    t.signal.removeEventListener('abort', kill);
    fixture.onError = undefined;
  }
}

async function journalPaths(fixture) {
  const dir = join(fixture.root, 'sessions');
  return (await readdir(dir, { recursive: true })).filter((name) => name.endsWith('.jsonl')).map((name) => join(dir, name));
}

function assertHealthy(rows) {
  assert.deepEqual(rows.filter((row) => row.customType === 'spine.fault.v1'), []);
}

function executions(rows, type) {
  return rows.filter((row) => row.customType === 'spine.archive.v1' && row.data.record.type === 'sampling_commit')
    .flatMap((row) => row.data.record.record.executions).filter((entry) => entry.operation.type === type);
}

function journalMessage(rows, role, marker) {
  const matches = rows.filter((row) => row.type === 'message' && row.message.role === role && visibleText(row.message) === marker);
  assert.equal(matches.length, 1, `Expected one durable ${role} entry for ${marker}`);
  return matches[0];
}

function ancestorIds(rows, leaf) {
  const byId = new Map(rows.filter((row) => row.type !== 'session' && row.id).map((row) => [row.id, row]));
  const ids = new Set();
  for (let id = leaf.parentId; id != null;) {
    assert.ok(byId.has(id) && !ids.has(id), `Invalid native journal ancestry at ${id}`);
    ids.add(id);
    id = byId.get(id).parentId;
  }
  return ids;
}

test('stock keyboard /tree forks the native journal and restores the original Spine owner on switch back', { timeout: phaseTimeoutMs * 10 }, async (t) => {
  const root = { prompt: 'STOCK-TREE-ROOT-PROMPT', answer: 'STOCK-TREE-ROOT-ANSWER', owner: 'STOCK-TREE-ROOT-OWNER' };
  const main = { prompt: 'STOCK-TREE-MAIN-PROMPT', answer: 'STOCK-TREE-MAIN-ANSWER', owner: 'STOCK-TREE-MAIN-OWNER' };
  const fork = { prompt: 'STOCK-TREE-FORK-PROMPT', answer: 'STOCK-TREE-FORK-ANSWER', owner: 'STOCK-TREE-FORK-OWNER' };
  const back = { prompt: 'STOCK-TREE-RETURN-PROMPT', answer: 'STOCK-TREE-RETURN-ANSWER', memory: 'STOCK-TREE-CLOSED-MAIN' };
  const fixture = await createNativeFixture(t, {
    label: 'stock-keyboard-tree', settings,
    onRequest(request, { index, send }) {
      const text = visibleText(request.messages);
      const seen = (...markers) => {
        for (const marker of markers) assert.ok(text.includes(marker), `Request ${index} is missing ${marker}`);
      };
      const absent = (...markers) => {
        for (const marker of markers) assert.ok(!JSON.stringify(request.messages).includes(marker), `Request ${index} leaked ${marker} from an inactive branch`);
      };
      const owner = ({ owner }) => seen(`summary="${owner}"`);
      switch (index) {
        case 1:
          seen(root.prompt);
          return send(spineCall('spine_open', { goal: root.owner }));
        case 2:
          owner(root);
          return send(root.answer);
        case 3:
          owner(root);
          seen(root.prompt, root.answer, main.prompt);
          return send(spineCall('spine_open', { goal: main.owner }));
        case 4:
          owner(main);
          return send(main.answer);
        case 5:
          owner(root);
          seen(root.prompt, root.answer, fork.prompt);
          absent(main.prompt, main.answer, main.owner);
          return send(spineCall('spine_open', { goal: fork.owner }));
        case 6:
          owner(fork);
          absent(main.prompt, main.answer, main.owner);
          return send(fork.answer);
        case 7:
          owner(main);
          seen(main.prompt, main.answer, back.prompt);
          absent(fork.prompt, fork.answer, fork.owner);
          return send(spineCall('spine_close', { memory: back.memory }));
        case 8:
          owner(root);
          absent(fork.prompt, fork.answer, fork.owner);
          return send(back.answer);
        default:
          assert.fail(`Unexpected /tree provider request ${index}`);
      }
    },
  });

  await runKeyboard(t, fixture, { kind: 'tree', root, main, fork, back });
  assert.equal(fixture.requests.length, 8);
  const paths = await journalPaths(fixture);
  assert.equal(paths.length, 1, '/tree must fork in place, not create another session');
  const rows = await readJournal(paths[0]);
  assertHealthy(rows);
  const rootAnswer = journalMessage(rows, 'assistant', root.answer);
  const original = journalMessage(rows, 'user', main.prompt);
  const originalAnswer = journalMessage(rows, 'assistant', main.answer);
  const alternate = journalMessage(rows, 'user', fork.prompt);
  const alternateAnswer = journalMessage(rows, 'assistant', fork.answer);
  const returned = journalMessage(rows, 'user', back.prompt);
  assert.ok(ancestorIds(rows, original).has(rootAnswer.id));
  const forkAncestry = ancestorIds(rows, alternate);
  assert.ok(forkAncestry.has(rootAnswer.id) && !forkAncestry.has(original.id), 'Fork retains the common prefix, not the original suffix');
  const backAncestry = ancestorIds(rows, returned);
  assert.ok(backAncestry.has(originalAnswer.id) && !backAncestry.has(alternateAnswer.id) && !backAncestry.has(alternate.id), 'Return follows the original journal branch');
  assert.equal(executions(rows, 'open').length, 3);
  assert.equal(executions(rows, 'close').length, 1, 'The restored owner accepts and commits Close');
});

test('stock keyboard /spine-tree reads a closed node without changing the resumed leaf', { timeout: phaseTimeoutMs * 7 }, async (t) => {
  const owner = 'STOCK-BROWSER-CLOSED-OWNER';
  const memory = 'STOCK-BROWSER-CLOSED-MEMORY';
  const answer = 'STOCK-BROWSER-SEED-ANSWER';
  const fixture = await createNativeFixture(t, {
    label: 'stock-keyboard-spine-tree', settings,
    onRequest(_request, { index, send }) {
      switch (index) {
        case 1: return send(spineCall('spine_open', { goal: owner }));
        case 2: return send(spineCall('spine_close', { memory }));
        case 3: return send(answer);
        default: assert.fail('/spine-tree must not send a model request');
      }
    },
  });
  const rpc = await fixture.start();
  const { sessionFile } = await rpc.command('get_state');
  assert.ok(sessionFile);
  const seeded = await rpc.prompt('Seed a completed Spine node and exit.');
  assert.equal(seeded.status, 'completed', JSON.stringify(seeded));
  await rpc.close();
  const before = await readJournal(sessionFile);
  assertHealthy(before);
  assert.equal(executions(before, 'close').length, 1);

  await runKeyboard(t, fixture, { kind: 'spine-tree', node: '1.1', answer, owner, memory }, { resume: sessionFile });
  assert.deepEqual(await journalPaths(fixture), [sessionFile]);
  const after = await readJournal(sessionFile);
  assert.deepEqual(after.slice(0, before.length), before, 'the original journal is not rewritten');
  const [exit, ...other] = after.slice(before.length);
  assert.equal(exit?.customType, 'session_exit', 'only ordinary native teardown may write to the journal');
  assert.equal(exit.parentId, before.at(-1).id, 'teardown still attaches to the original native leaf');
  assert.deepEqual(other, []);
});

test('stock keyboard Spawn Continue recovers a local provider 403 in the same child session', { timeout: phaseTimeoutMs * 5 }, async (t) => {
  const prompt = 'STOCK-SPAWN-PROMPT';
  const guidance = 'STOCK-SPAWN-CONTINUE-GUIDANCE';
  const answer = 'STOCK-SPAWN-RECOVERED-ANSWER';
  const owner = 'STOCK-SPAWN-OWNER';
  const denied = 'STOCK-SPAWN-403';
  const tasks = [
    { summary: 'Recover the first child', prompt: 'STOCK-SPAWN-CHILD-ALPHA' },
    { summary: 'Complete the second child', prompt: 'STOCK-SPAWN-CHILD-BETA' },
  ];
  const memories = ['STOCK-SPAWN-RECOVERED-MEMORY', 'STOCK-SPAWN-PEER-MEMORY'];
  const staged = 'STOCK-SPAWN-PARENT-STAGED';
  const peerSeen = 'STOCK-SPAWN-PARENT-SAW-PEER';
  const peerRelease = Promise.withResolvers();
  const failureRelease = Promise.withResolvers();
  let failedSession;
  let initialCalls = 0;
  let continuedCalls = 0;
  let peerCalls = 0;
  let parentCalls = 0;
  const fixture = await createNativeFixture(t, {
    label: 'stock-keyboard-spawn', settings,
    async onRequest(request, { send, fail }) {
      const user = visibleText(request.messages.findLast((message) => message.role === 'user')).trimEnd();
      const text = visibleText(request.messages);
      if (user.endsWith(tasks[0].prompt)) {
        assert.equal(++initialCalls, 1, 'Neither an auto-retry nor a fresh Retry may replay the assignment');
        const matches = (await journalPaths(fixture)).filter((path) => path.includes('/spine-spawn/') && basename(path).endsWith('.1.jsonl'));
        assert.equal(matches.length, 1, 'Capture the first child journal before the provider failure');
        const header = (await readJournal(matches[0])).find((row) => row.type === 'session');
        assert.ok(header);
        assert.ok(header.id);
        assert.equal(header.birth.at(-1), 1);
        failedSession = { path: matches[0], id: header.id, birth: header.birth };
        await failureRelease.promise;
        return fail(403, { error: { message: `${denied}: mock provider denied access`, type: 'permission_error' } });
      }
      if (user.endsWith(tasks[1].prompt)) {
        assert.equal(++peerCalls, 1, 'Continue must not relaunch the completed peer');
        await peerRelease.promise;
        return send(memories[1]);
      }
      if (user.includes(guidance)) {
        assert.equal(++continuedCalls, 1, 'Only one inference after the Continue guidance');
        assert.ok(failedSession);
        const header = (await readJournal(failedSession.path)).find((row) => row.type === 'session');
        assert.ok(header);
        assert.equal(header.id, failedSession.id, 'Continue must keep the original child journal identity');
        assert.match(user, /Continue the same active branch from the existing session history/);
        assert.ok(user.includes(`User guidance:\n${guidance}`));
        assert.equal(text.split(tasks[0].prompt).length - 1, 1, 'The resumed inference receives the assignment once');
        return send(memories[0]);
      }
      assert.ok(text.includes(prompt) && !user.includes('You are:'), 'Only the real parent may make other requests');
      switch (++parentCalls) {
        case 1: return send(spineCall('spine_open', { goal: owner }));
        case 2:
          assert.ok(text.includes(`summary="${owner}"`));
          return send(spineCall('spine_spawn', { tasks }));
        case 3:
          for (const memory of memories) assert.ok(!text.includes(memory));
          send(staged);
          peerRelease.resolve();
          return;
        case 4:
          assert.ok(text.includes(staged), 'The parent replied without waiting for its children');
          assert.ok(text.includes(memories[1]) && !text.includes(memories[0]), 'The peer wakes the parent independently');
          send(peerSeen);
          failureRelease.resolve();
          return;
        case 5:
          assert.deepEqual([initialCalls, continuedCalls, peerCalls], [1, 1, 1]);
          for (const memory of memories) assert.ok(text.includes(memory), `Missing child memory ${memory} in the resumed parent`);
          assert.ok(!text.includes(denied), 'The abandoned 403 must not replace the recovered memory');
          return send(answer);
        default: assert.fail(`Unexpected Spawn parent request ${parentCalls}`);
      }
    },
  });

  try {
    await runKeyboard(t, fixture, { kind: 'spawn', prompt, guidance, answer });
  } finally {
    peerRelease.resolve();
    failureRelease.resolve();
  }
  assert.equal(fixture.requests.length, 8);
  const paths = await journalPaths(fixture);
  const parentPaths = paths.filter((path) => !path.includes('/spine-spawn/'));
  assert.equal(parentPaths.length, 1);
  assert.equal(paths.length, 3, 'One parent and two original child journals; no replacement session for Continue');
  const parent = await readJournal(parentPaths[0]);
  assertHealthy(parent);
  const [spawnExecution, ...extra] = executions(parent, 'spawn');
  assert.ok(spawnExecution);
  assert.deepEqual(extra, [], 'Only one canonical Spawn execution');
  assert.deepEqual(spawnExecution.operation.tasks, tasks, 'Spawn commits assignments, not results');
  const arrivals = parent.filter((row) => row.type === 'custom' && row.customType === 'spine-arrival');
  assert.deepEqual(arrivals.map(({ data }) => [data.outcome, data.memory]), [
    ['completed', memories[1]], ['completed', memories[0]],
  ]);
  const spawnEntry = parent.find((row) => row.customType === 'spine.archive.v1'
    && row.data.record.type === 'sampling_commit'
    && row.data.record.record.executions.some(({ operation }) => operation.type === 'spawn'));
  assert.ok(spawnEntry);
  for (const arrival of arrivals) assert.ok(ancestorIds(parent, arrival).has(spawnEntry.id));
  const recovered = arrivals[1].data;
  assert.deepEqual(recovered.producer, failedSession.birth);
  assert.equal(recovered.execution_ref, `${spawnEntry.id}:${failedSession.birth.join('.')}:attempt-0:${failedSession.id}`);
  const resumed = await readJournal(failedSession.path);
  assertHealthy(resumed);
  assert.equal(resumed.find((row) => row.type === 'session')?.id, failedSession.id);
  assert.equal(resumed.filter((row) => row.message?.role === 'user' && visibleText(row.message).includes(guidance)).length, 1);
  assert.ok(resumed.some((row) => row.message?.role === 'assistant' && row.message.stopReason === 'error'
    && row.message.errorMessage?.includes(denied)), 'The original journal records the denied provider attempt and its recovery');
  const reply = journalMessage(resumed, 'assistant', memories[0]);
  assert.equal(reply.message.stopReason, 'stop', 'The continued child ends with a final plain reply');
  const peerPath = paths.find((path) => path.includes('/spine-spawn/') && path !== failedSession.path);
  assert.ok(peerPath);
  const peer = await readJournal(peerPath);
  assertHealthy(peer);
  assert.deepEqual(peer.find((row) => row.type === 'session')?.birth, arrivals[0].data.producer);
  assert.equal(journalMessage(peer, 'assistant', memories[1]).message.stopReason, 'stop');
});
