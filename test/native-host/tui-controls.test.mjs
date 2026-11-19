import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createNativeFixture, readJournal, spineCall, visibleText } from './fixture.mjs';

const firstOwner = 'CONTROL-FIRST-OWNER';
const secondOwner = 'CONTROL-SECOND-OWNER';
const firstMemory = 'CONTROL-FIRST-MEMORY';
const secondMemory = 'CONTROL-SECOND-MEMORY';
const calls = {
  OPEN: { tool: 'spine_open', input: { goal: firstOwner } },
  NEXT: { tool: 'spine_next', input: { memory: firstMemory, goal: secondOwner } },
  CLOSE: { tool: 'spine_close', input: { memory: secondMemory } },
  ERROR: { tool: 'spine_close', input: { memory: 'CONTROL-MUST-NOT-COMMIT' } },
};
const normalized = (text) => text.replace(/\s+/g, ' ').trim();

test('real TUI hides successful controls but retains tree transitions, model receipts and visible root denial', { timeout: 180_000 }, async (t) => {
  const observed = new Map();
  let driver;
  let exited;
  let stdout = '';
  let stderr = '';
  let fixture;
  t.after(async () => {
    if (driver?.exitCode === null && driver.signalCode === null) {
      try { process.kill(-driver.pid, 'SIGKILL'); } catch { driver.kill('SIGKILL'); }
    }
    await exited?.catch(() => {});
    if (fixture) {
      await writeFile(join(fixture.root, 'control-driver.stdout.log'), stdout);
      await writeFile(join(fixture.root, 'control-driver.stderr.log'), stderr);
    }
  });
  fixture = await createNativeFixture(t, {
    label: 'tui-control-visibility', bridge: new URL('./tui.bridge.mjs', import.meta.url),
    settings: { startup: { setupWizard: false, showSplash: false, checkUpdate: false } },
    onRequest(request, { index, send }) {
      const user = request.messages.findLast((message) => message.role === 'user' && Object.keys(calls).some((name) =>
        visibleText(message).trimEnd().endsWith(`CONTROL-${name}`)));
      const phase = Object.keys(calls).find((name) => user && visibleText(user).trimEnd().endsWith(`CONTROL-${name}`));
      assert.ok(phase, 'Actual keyboard input must select a control workflow');
      const previous = observed.get(phase);
      if (previous === undefined) {
        observed.set(phase, { callId: `native-path-${index}-0` });
        return send(spineCall(calls[phase].tool, calls[phase].input));
      }
      assert.equal(previous.modelReceipt, undefined, 'A settled control workflow must not request another model continuation');
      const receipt = request.messages.find((message) => message.role === 'tool' && message.tool_call_id === previous.callId);
      assert.ok(receipt, 'UI suppression must not delete the real model-facing tool reply');
      previous.modelReceipt = receipt.content;
      return send(`CONTROL-${phase}-DONE`);
    },
  });
  const probe = join(fixture.root, 'native-state.jsonl');
  const config = join(fixture.root, 'control-driver.json');
  await writeFile(config, JSON.stringify({
    ...fixture.invocation, workspace: fixture.workspace, root: fixture.root,
    env: { ...fixture.environment, OMP_TUI_PROBE_PATH: probe },
  }));
  driver = spawn(process.env.OMP_NATIVE_BUN ?? 'bun', [fileURLToPath(new URL('./tui-controls.driver.mjs', import.meta.url)), config], {
    cwd: fixture.workspace, env: fixture.environment, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  fixture.onError = () => { try { process.kill(-driver.pid, 'SIGKILL'); } catch { driver.kill('SIGKILL'); } };
  driver.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  driver.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  exited = new Promise((resolve, reject) => { driver.once('error', reject); driver.once('close', (code, signal) => resolve({ code, signal })); });
  const result = await exited;
  assert.ifError(fixture.error);
  assert.equal(result.code, 0, `${stderr}\n${stdout}`);
  assert.equal(result.signal, null);
  const states = (await readFile(probe, 'utf8')).trim().split('\n').map(JSON.parse);
  const state = (label) => states.find((snapshot) => snapshot.label === label);
  const rows = await readJournal(state('error').sessionFile);
  for (const [phase, call] of observed) {
    const receipt = rows.find((entry) => entry.message?.role === 'toolResult' && entry.message.toolCallId === call.callId)?.message;
    assert.ok(receipt, 'Actual Native journal retains each executed or rejected control');
    assert.equal(normalized(call.modelReceipt), normalized(visibleText(receipt)), 'Model receives the persisted execution reply despite quiet TUI success');
    const screen = normalized(await readFile(join(fixture.root, `${phase.toLowerCase()}.screen.txt`), 'utf8'));
    const receiptText = normalized(visibleText(receipt));
    if (phase === 'ERROR') {
      assert.equal(receipt.isError, true);
      assert.ok(screen.includes(receiptText), 'A genuine root denial must remain visible to the user');
    } else {
      assert.equal(receipt.isError, false);
      assert.ok(!screen.includes(receiptText), 'Successful control receipts belong to model/journal, not duplicate tree state in TUI');
      const expanded = normalized(await readFile(join(fixture.root, 'next-expanded.screen.txt'), 'utf8'));
      assert.ok(!expanded.includes(receiptText), 'Ctrl+O must not reveal suppressed success receipts');
    }
  }
  const currentNode = (snapshot) => snapshot.projection.nodes.find((node) =>
    JSON.stringify(node.id) === JSON.stringify(snapshot.projection.cursor));
  assert.equal(currentNode(state('open')).summary, firstOwner);
  assert.equal(currentNode(state('next')).summary, secondOwner);
  assert.equal(currentNode(state('close')).kind, 'RootEpoch');
  assert.deepEqual(state('error').projection.nodes, state('close').projection.nodes, 'Rejected root close cannot change committed tree or memory');
  assert.deepEqual(state('error').projection.cursor, state('close').projection.cursor);
  assert.equal(rows.filter((entry) => entry.customType === 'spine.fault.v1').length, 0);
  const memories = rows.filter((entry) => entry.customType === 'spine.archive.v1' && entry.data.record.type === 'sampling_commit')
    .flatMap((entry) => entry.data.record.record.executions)
    .map(({ operation }) => operation.type === 'next' ? operation.closed_memory : operation.memory);
  assert.equal(memories.filter((memory) => memory === firstMemory).length, 1);
  assert.equal(memories.filter((memory) => memory === secondMemory).length, 1);
  assert.ok(!memories.includes('CONTROL-MUST-NOT-COMMIT'));
  console.log(stdout);
});
