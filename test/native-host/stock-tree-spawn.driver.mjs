import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import vterm from '@oh-my-pi/pi-utils/vterm';

// This process supplies only a terminal and keystrokes; it loads no test bridge.
const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
let cols = 132;
let rows = 42;
const screen = new vterm.Terminal({ cols, rows, scrollback: 2000, allowProposedApi: true });
const decoder = new TextDecoder();
let raw = '';
let proc;
let pending;
let exitError;
const text = () => Array.from({ length: rows }, (_, row) =>
  screen.buffer.active.getLine(screen.buffer.active.baseY + row)?.translateToString(true) ?? '').join('\n');

function clearWaiter() {
  const waiter = pending;
  if (waiter) clearTimeout(waiter.timer);
  pending = undefined;
  return waiter;
}

function check() {
  if (!pending) return;
  const value = text();
  if (pending.predicate(value)) clearWaiter().resolve(value);
}

function waitScreen(label, predicate) {
  if (exitError) return Promise.reject(exitError);
  const value = text();
  if (predicate(value)) return Promise.resolve(value);
  assert.equal(pending, undefined);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      clearWaiter();
      reject(new Error(`Stock TUI did not reach ${label}\n${text()}`));
    }, config.phaseTimeoutMs);
    pending = { predicate, resolve, reject, timer };
  });
}

const key = (value) => proc.terminal.write(value);
const submit = (value) => key(`${value}\r`);
const reply = (marker) => waitScreen(marker, (value) => value.includes(marker) && !value.includes('Working…'));
const treeOpen = (value) => /Session Tree/i.test(value);
const composer = (value) => /^╰─/m.test(value);
const capture = (label, value) => writeFile(join(config.root, `${label}.screen.txt`), `${value}\n`);

async function selectTree(target, label, settled) {
  submit('/tree');
  await waitScreen('native /tree picker', treeOpen);
  const query = target.toLowerCase(); // Distinct from the transcript's uppercase marker.
  key(query);
  await capture(`${label}-picker`, await waitScreen(`search for ${target}`, (value) =>
    treeOpen(value) && value.includes(query)));
  key('\r');
  await capture(label, await waitScreen(label, (value) => !treeOpen(value) &&
    value.includes('Navigated to selected point') && settled(value)));
}

try {
  proc = Bun.spawn([config.binary, ...config.prefix, ...config.args], {
    cwd: config.workspace, env: { ...config.env, TERM: 'xterm-256color' },
    terminal: { cols, rows, data(_terminal, data) {
      raw += decoder.decode(data, { stream: true });
      screen.write(data, check);
    } },
  });
  screen.onData((data) => proc.terminal.write(data));
  proc.exited.then((code) => {
    exitError = new Error(`Stock OMP exited (${code})\n${text()}`);
    clearWaiter()?.reject(exitError);
  });
  const model = config.model.split('/').at(-1);
  await waitScreen(`local model ${model}`, (value) => value.includes(model));

  const script = config.script;
  if (script.kind === 'tree') {
    const { root, main, fork, back } = script;
    submit(root.prompt);
    await reply(root.answer);
    submit(main.prompt);
    await reply(main.answer);
    // Picking a user turn rewinds to its parent and restores its draft in the composer.
    await selectTree(main.prompt, 'tree-rewound', (value) => value.includes(main.prompt) && !value.includes(main.answer));
    key('\x01\x0b'); // Ctrl+A, Ctrl+K: clear the restored single-line draft.
    submit(fork.prompt);
    await capture('tree-forked', await reply(fork.answer));
    // Selecting an assistant answer keeps that entry and resumes its original branch.
    await selectTree(main.answer, 'tree-switched-back', (value) => value.includes(main.answer) && !value.includes(fork.answer));
    submit(back.prompt);
    await capture('tree-returned-answer', await reply(back.answer));
  } else if (script.kind === 'spine-tree') {
    await waitScreen('resumed transcript and composer', (value) => value.includes(script.answer) && composer(value));
    submit(`/spine-tree ${script.node}`);
    const panel = (value) => value.match(/^[╭+][─-] Spine Tree [─-]+[╮+]\n([│|].*\n)[├+][─-]+[┤+]\n([\s\S]*?)^[╰+][─-]+[╯+]/m);
    const selected = (value) => panel(value)?.[2].split('\n').find(line => line.startsWith('│ > ') || line.startsWith('| > '));
    const list = (value) => panel(value)?.[1].includes('Enter Read') && selected(value)?.includes(`${script.node} ${script.owner}`);
    const aboveComposer = (value) => {
      const frame = panel(value);
      return frame !== null && composer(value.slice(frame.index + frame[0].length));
    };
    await capture('spine-tree-list', await waitScreen('framed Spine tree above the composer', (value) => list(value) && aboveComposer(value)));
    key('\r');
    const detail = (value) => {
      const frame = panel(value);
      if (!frame?.[1].includes('Esc Back')) return false;
      const lines = frame[2].trimEnd().split('\n').map(line => line.slice(1, -1).trim());
      return lines.length === 3 && lines[0] === `✓ ${script.owner}` &&
        lines[1] === '' && lines[2] === script.memory;
    };
    await capture('spine-tree-memory', await waitScreen('closed Spine memory above the composer', (value) => detail(value) && aboveComposer(value)));
    cols = 42;
    rows = 20;
    screen.resize(cols, rows);
    proc.terminal.resize(cols, rows);
    const narrow = (value) => detail(value) && aboveComposer(value) && panel(value)[0].split('\n')[0].length === cols;
    await capture('spine-tree-narrow', await waitScreen('closed memory in the narrower frame', narrow));
    key('\x1b');
    await waitScreen('Spine browser list with the same selection', (value) => list(value) && aboveComposer(value));
    key('\x1b');
    await waitScreen('Spine browser dismissed', (value) => !panel(value) && composer(value));
    const draft = 'COMPOSER-FOCUS';
    key(draft);
    await waitScreen('keyboard input restored to the composer', (value) => value.includes(draft));
    key('\x01\x0b');
  } else {
    assert.equal(script.kind, 'spawn');
    submit(script.prompt);
    await capture('spawn-403-picker', await waitScreen('child recovery selector', (value) =>
      /Spine Spawn [\d.]+ failed:/.test(value) && ['Continue', 'Retry', 'Abandon'].every((choice) => value.includes(choice))));
    key('\r'); // Continue is first; verify the resulting guidance input before typing.
    await capture('spawn-continue-guidance', await waitScreen('Continue guidance input', (value) =>
      value.includes('Continue guidance (optional)')));
    submit(script.guidance);
    await capture('spawn-recovered-answer', await reply(script.answer));
  }

  submit('/exit');
  let timer;
  try {
    const code = await Promise.race([proc.exited, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Keyboard /exit did not complete\n${text()}`)), config.phaseTimeoutMs);
    })]);
    assert.equal(code, 0, 'keyboard /exit must perform native teardown');
  } finally {
    clearTimeout(timer);
  }
} finally {
  if (proc && proc.exitCode === null) {
    proc.kill('SIGKILL');
    await proc.exited;
  }
  proc?.terminal.close();
  screen.dispose();
  await writeFile(join(config.root, 'stock-keyboard.ansi.log'), raw + decoder.decode());
}
