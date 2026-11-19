import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import vterm from '@oh-my-pi/pi-utils/vterm';

const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
const screen = new vterm.Terminal({ cols: 120, rows: 36, scrollback: 2000, allowProposedApi: true });
const waiters = new Set();
let raw = '';
let failure;
let proc;
const text = () => Array.from({ length: screen.rows }, (_, row) =>
  screen.buffer.active.getLine(screen.buffer.active.baseY + row)?.translateToString(true) ?? '').join('\n');
function check() {
  const value = text();
  for (const waiter of waiters) {
    if (!value.includes(waiter.marker)) continue;
    clearTimeout(waiter.timer);
    waiters.delete(waiter);
    waiter.resolve();
  }
}
function waitFor(marker) {
  if (failure) return Promise.reject(failure);
  if (text().includes(marker)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const waiter = { marker, resolve, reject };
    waiter.timer = setTimeout(() => {
      waiters.delete(waiter);
      reject(new Error(`TUI did not reach ${marker}\n${text()}`));
    }, 30_000);
    waiters.add(waiter);
  });
}
async function capture(label) {
  await writeFile(join(config.root, `${label}.screen.txt`), text() + '\n');
  console.log(`Actual control TUI ${label}:\n${text()}`);
}
try {
  proc = Bun.spawn([config.binary, ...config.prefix, ...config.args], {
    cwd: config.workspace, env: { ...config.env, TERM: 'xterm-256color' },
    terminal: { cols: 120, rows: 36, data(_terminal, data) {
      raw += new TextDecoder().decode(data);
      screen.write(data, check);
    } },
  });
  screen.onData((data) => proc.terminal.write(data));
  proc.exited.then((code) => {
    if (code === 0) return;
    failure = new Error(`Actual control TUI exited ${code}\n${text()}`);
    for (const waiter of waiters) { clearTimeout(waiter.timer); waiter.reject(failure); }
    waiters.clear();
  });
  await waitFor('TUI-NATIVE-READY');
  for (const phase of ['OPEN', 'NEXT', 'CLOSE', 'ERROR']) {
    proc.terminal.write(`CONTROL-${phase}\r`);
    await waitFor(`CONTROL-${phase}-DONE`);
    proc.terminal.write(`/native-tui-inspect ${phase.toLowerCase()}\r`);
    await waitFor(`TUI-INSPECTED-${phase.toLowerCase()}`);
    await capture(phase.toLowerCase());
    if (phase === 'NEXT') {
      proc.terminal.write('\x0f');
      proc.terminal.write('/native-tui-inspect next-expanded\r');
      await waitFor('TUI-INSPECTED-next-expanded');
      await capture('next-expanded');
    }
  }
  proc.terminal.write('/exit\r');
  assert.equal(await proc.exited, 0, 'keyboard /exit must complete real Native teardown');
} finally {
  if (proc && proc.exitCode === null) { proc.kill('SIGKILL'); await proc.exited; }
  proc?.terminal.close();
  screen.dispose();
  await writeFile(join(config.root, 'control-terminal.ansi.log'), raw);
}
