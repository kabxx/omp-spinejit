import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import vterm from '@oh-my-pi/pi-utils/vterm';

const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
const screen = new vterm.Terminal({ cols: 100, rows: 32, scrollback: 2000, allowProposedApi: true });
const waiters = new Set();
let raw = '';
let failed;
let proc;
const text = () => Array.from({ length: screen.rows }, (_, index) => screen.buffer.active.getLine(screen.buffer.active.baseY + index)?.translateToString(true) ?? '').join('\n');
function check() {
  const value = text();
  for (const waiter of waiters) {
    if (!waiter.predicate(value)) continue;
    clearTimeout(waiter.timer);
    waiters.delete(waiter);
    waiter.resolve(value);
  }
}
function waitScreen(predicate, label) {
  if (failed) return Promise.reject(failed);
  if (predicate(text())) return Promise.resolve(text());
  return new Promise((resolve, reject) => {
    const waiter = { predicate, resolve, reject };
    waiter.timer = setTimeout(() => { waiters.delete(waiter); reject(new Error(`TUI ${label} timed out\n${text()}`)); }, 30_000);
    waiters.add(waiter);
  });
}
async function snapshot(label) {
  const value = text();
  await writeFile(join(config.root, `${label}.screen.txt`), value + '\n');
  console.log(`Actual TUI ${label}:\n${value}`);
}
try {
  proc = Bun.spawn([config.binary, ...config.prefix, ...config.args], {
    cwd: config.workspace, env: { ...config.env, TERM: 'xterm-256color' },
    terminal: { cols: 100, rows: 32, data(terminal, data) {
      raw += new TextDecoder().decode(data);
      screen.write(data, check);
    } },
  });
  screen.onData((data) => proc.terminal.write(data));
  proc.exited.then((code) => {
    if (code === 0) return;
    failed = new Error(`Actual TUI exited ${code}\n${text()}`);
    for (const waiter of waiters) { clearTimeout(waiter.timer); waiter.reject(failed); }
    waiters.clear();
  });
  await waitScreen((value) => value.includes('TUI-NATIVE-READY'), 'startup');
  proc.terminal.write('TUI-SUBMIx\x7fT\r');
  await waitScreen((value) => value.includes('TUI-MODEL-STAGED') && value.includes('TUI Alpha task')
    && value.includes('TUI Beta task'), 'staged Spine Spawn panel before either child arrives');
  await snapshot('100x32-staged');
  await waitScreen((value) => value.includes('TUI-MODEL-DONE'), 'independent Spine arrivals reach the parent');
  screen.resize(48, 24);
  proc.terminal.resize(48, 24);
  proc.terminal.write('/native-tui-inspect before-new\r');
  await waitScreen((value) => value.includes('TUI-INSPECTED-before-new'), 'native state inspection');
  assert.ok(text().includes('TUI-OWNER') && text().includes('TUI-MODEL-DONE'), 'Native resize preserves the active tree and transcript');
  await snapshot('48x24-resized');
  proc.terminal.write('/new\r');
  await waitScreen((value) => !value.includes('TUI-OWNER') && !value.includes('TUI-MODEL-DONE'), 'new-session tree clearing');
  proc.terminal.write('/native-tui-inspect after-new\r');
  await waitScreen((value) => value.includes('TUI-INSPECTED-after-new'), 'fresh native state inspection');
  assert.ok(!text().includes('TUI-OWNER') && !text().includes('TUI-MODEL-DONE'), 'The new native session has no stale Spine panel or transcript');
  await snapshot('48x24-new-session');
  proc.terminal.write('/exit\r');
  assert.equal(await proc.exited, 0, 'keyboard /exit performs healthy native teardown');
} finally {
  if (proc && proc.exitCode === null) { proc.kill('SIGKILL'); await proc.exited; }
  proc?.terminal.close();
  screen.dispose();
  await writeFile(join(config.root, 'terminal.ansi.log'), raw);
}
