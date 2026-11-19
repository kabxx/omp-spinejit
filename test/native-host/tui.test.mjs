import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNativeFixture, spineCall, visibleText } from './fixture.mjs';

const bridge = new URL('./tui.bridge.mjs', import.meta.url);
const owner = 'TUI-OWNER 中文目标';
test('real TUI keyboard submission, staged Spawn panels, resize and new-session tree teardown', { timeout: 180_000 }, async (t) => {
  let step = 0;
  const children = new Map();
  const releaseAlpha = Promise.withResolvers();
  const releaseBeta = Promise.withResolvers();
  let driver;
  let exited;
  let stdout = '';
  let stderr = '';
  let fixture;
  t.after(async () => {
    releaseAlpha.resolve();
    releaseBeta.resolve();
    if (driver?.exitCode === null && driver.signalCode === null) { try { process.kill(-driver.pid, 'SIGKILL'); } catch { driver.kill('SIGKILL'); } }
    await exited?.catch(() => {});
    if (fixture) {
      await writeFile(join(fixture.root, 'tui-driver.stdout.log'), stdout);
      await writeFile(join(fixture.root, 'tui-driver.stderr.log'), stderr);
    }
  });
  fixture = await createNativeFixture(t, {
    label: 'tui-keyboard-panels', bridge,
    settings: { startup: { setupWizard: false, showSplash: false, checkUpdate: false } },
    async onRequest(request, { send }) {
      const users = request.messages.filter((message) => message.role === 'user');
      const content = visibleText(users);
      const assignment = visibleText(users.at(-1)).trimEnd();
      for (const name of ['ALPHA', 'BETA']) {
        if (!assignment.endsWith(`TUI CHILD ${name}`)) continue;
        const count = (children.get(name) ?? 0) + 1;
        children.set(name, count);
        assert.equal(count, 1, 'each child samples once and ends with a plain reply');
        await (name === 'ALPHA' ? releaseAlpha : releaseBeta).promise;
        return send(`TUI-${name}-MEMORY`);
      }
      assert.equal(content.split('TUI-SUBMIT').length - 1, 1, 'actual Backspace/Enter keyboard editing reaches the native model input exactly once');
      const text = visibleText(request.messages);
      switch (++step) {
        case 1:
          return send(spineCall('spine_open', { goal: owner }));
        case 2:
          return send(spineCall('spine_spawn', { tasks: [
            { summary: 'TUI Alpha task', prompt: 'TUI CHILD ALPHA' },
            { summary: 'TUI Beta task', prompt: 'TUI CHILD BETA' },
          ] }));
        case 3:
          assert.ok(!text.includes('TUI-ALPHA-MEMORY') && !text.includes('TUI-BETA-MEMORY'));
          return send('TUI-MODEL-STAGED');
        case 4:
          assert.ok(text.includes('TUI-ALPHA-MEMORY') && !text.includes('TUI-BETA-MEMORY'));
          send('TUI-MODEL-SAW-ALPHA');
          releaseBeta.resolve();
          return;
        case 5:
          assert.ok(text.includes('TUI-ALPHA-MEMORY') && text.includes('TUI-BETA-MEMORY'));
          return send('TUI-MODEL-DONE');
        default:
          assert.fail(`Unexpected TUI parent request ${step}`);
      }
    },
  });
  const probe = join(fixture.root, 'native-state.jsonl');
  const configPath = join(fixture.root, 'tui-driver.json');
  await writeFile(configPath, JSON.stringify({
    ...fixture.invocation, workspace: fixture.workspace, root: fixture.root,
    env: { ...fixture.environment, OMP_TUI_PROBE_PATH: probe },
  }));
  driver = spawn(process.env.OMP_NATIVE_BUN ?? 'bun', [fileURLToPath(new URL('./tui.driver.mjs', import.meta.url)), configPath], {
    cwd: fixture.workspace, env: fixture.environment, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  fixture.onError = () => { try { process.kill(-driver.pid, 'SIGKILL'); } catch { driver.kill('SIGKILL'); } };
  driver.stdout.setEncoding('utf8').on('data', (chunk) => {
    stdout += chunk;
    if (stdout.includes('Actual TUI 100x32-staged:')) releaseAlpha.resolve();
  });
  driver.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  exited = new Promise((resolve, reject) => { driver.once('error', reject); driver.once('close', (code, signal) => resolve({ code, signal })); });
  const result = await exited;
  assert.ifError(fixture.error);
  assert.equal(result.code, 0, `${stderr}\n${stdout}`);
  assert.equal(result.signal, null);
  assert.equal(children.get('ALPHA'), 1);
  assert.equal(children.get('BETA'), 1);
  const [before, after] = (await readFile(probe, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.notEqual(after.sessionId, before.sessionId);
  assert.deepEqual(before.projection.cursor, [1, 1]);
  assert.ok(JSON.stringify(before.projection).includes(owner));
  assert.ok(JSON.stringify(before.projection).includes('TUI-ALPHA-MEMORY'));
  assert.equal(after.source.cells.length, 0, 'new-session keyboard command starts an empty real Source');
  assert.deepEqual(after.projection.cursor, [1]);
  assert.ok(!JSON.stringify(after.projection).includes(owner));
  console.log(stdout);
});
