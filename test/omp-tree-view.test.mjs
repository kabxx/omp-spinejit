import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { stripTerminalSequences } from '@oh-my-pi/pi-tui';
import { initThemeSync, theme } from '@oh-my-pi/pi-tui/theme';
import { registerSpineTreeCommand } from '../dist/omp/tree-view.js';
import { linesComponent } from '../dist/omp/pretty-tree.js';
import { visibleWidth } from '../dist/omp/tui-width.js';

initThemeSync('unicode');

function panelBody(frame) {
  return frame.slice(3, -1).map(line => stripTerminalSequences(line).slice(1, -1).trim());
}

function harness(projection, branch = [], mode = 'tui') {
  let handler;
  let component;
  const editor = {};
  let focus = editor;
  const notices = [];
  registerSpineTreeCommand({ registerCommand(name, command) {
    assert.equal(name, 'spine-tree');
    handler = command.handler;
  } }, () => projection);
  const result = handler('', {
    mode,
    hasUI: true,
    sessionManager: { getBranch: () => branch },
    ui: {
      notify: (...args) => notices.push(args),
      setWidget(_key, factory) {
        if (factory) {
          component = factory({
            terminal: { rows: 22 }, requestRender() {},
            getFocused: () => focus, setFocus: value => { focus = value; },
          }, theme);
        } else {
          component?.dispose();
        }
      },
    },
  });
  return { result, component, notices, editor, getFocus: () => focus };
}

test('Spine tree reads current memory, Spawn nodes and full summaries on the active journal branch', async () => {
  const root = { id: [1], parent: null, children: [[1, 1], [1, 2]], kind: 'RootEpoch', status: 'Opened', summary: null, memory: null, spawn: null };
  const cursor = { id: [1, 1], parent: [1], children: [], kind: 'Task', status: 'Live', summary: 'Active task', spawn: null,
    memory: [{ Summary: { body: 'Saved memory\n第二行', owner_node: [1, 1] } }] };
  const spawn = { id: [1, 2], parent: [1], children: [], kind: 'Spawn', status: 'Closed', summary: 'Spawned task', memory: null, spawn: { arrived: 'errored' } };
  const { component, result, notices, editor, getFocus } = harness({ nodes: [root, cursor, spawn], cursor: cursor.id }, [
    { type: 'compaction', id: 'c1', summary: 'Full compaction text', shortSummary: 'Short text', timestamp: '2026-01-01' },
    { type: 'branch_summary', id: 'b1', summary: 'Native branch history', timestamp: '2026-01-02' },
  ]);
  assert.ok(component);
  const render = (width = 80) => component.render(width).map(stripTerminalSequences).join('\n');
  const list = render();
  assert.match(list, /^╭─ Spine Tree .*╮\n│.*Enter Read.*Esc Close.*│\n├─+┤\n/);
  assert.match(list, /╰─+╯$/);
  assert.match(list, /> .*1\.1 Active task \(current\)/);
  assert.match(list, /× 1\.2 Spawned task/);
  component.handleInput('\r');
  const detail = render();
  assert.match(detail, /^╭─ Spine Tree .*╮\n│.*Esc Back.*│\n├─+┤\n/);
  const activeFrame = component.render(80);
  assert.deepEqual(panelBody(activeFrame), ['◉ Active task', '', 'Saved memory', '第二行']);
  assert.ok(activeFrame[3].includes('\x1b[92m'), 'the current marker uses the pinned tree green');
  assert.match(detail, /╰─+╯$/);
  const narrow = render(24);
  assert.match(narrow, /Esc Back/);
  assert.ok(narrow.split('\n').every(line => visibleWidth(line) === 24));
  component.handleInput('\x1b');
  assert.equal(render(), list, 'Esc returns to the same selection');
  assert.match(render(24), /Enter · Esc/);
  component.handleInput('\x1b[6~');
  assert.match(render(), /> Past: Compaction/);
  component.handleInput('\r');
  assert.match(render(), /Full compaction text/);
  assert.doesNotMatch(render(), /Short text/);
  component.handleInput('\x1b');
  component.handleInput('\x1b[A');
  component.handleInput('\r');
  assert.match(render(), /Native branch history/);
  assert.ok(component.render(3).every(line => visibleWidth(line) <= 3));
  component.handleInput('\x1b');
  component.handleInput('\x1b[A');
  component.handleInput('\r');
  assert.deepEqual(panelBody(component.render(80)), ['× Spawned task', '', 'No saved memory for this node.']);
  component.handleInput('\x1b');
  component.handleInput('\x1b');
  await result;
  assert.equal(getFocus(), editor, 'dismissing the browser restores composer focus');
  assert.deepEqual(notices, []);
});

test('Spine tree wraps the heading and memory to the panel width without losing paragraph breaks', async () => {
  const goal = 'Check details on narrow terminals';
  const firstParagraph = `${'word '.repeat(15)}boundary word`;
  const memory = `${firstParagraph}\n\nNext paragraph`;
  const closed = { id: [1, 1], parent: [1], children: [], kind: 'Task', status: 'Closed', summary: goal, spawn: null,
    memory: [{ Summary: { body: memory, owner_node: [1, 1] } }] };
  const root = { id: [1], parent: null, children: [closed.id], kind: 'RootEpoch', status: 'Opened', summary: null, memory: null, spawn: null };
  const { component, result } = harness({ nodes: [root, closed], cursor: root.id });
  component.handleInput('\x1b[B');
  component.handleInput('\r');
  const heading = `✓ ${goal}`;
  assert.deepEqual(panelBody(component.render(132)), [heading, '', firstParagraph, '', 'Next paragraph']);

  const narrowFrame = component.render(24);
  const narrow = panelBody(narrowFrame);
  const separator = narrow.indexOf('');
  assert.ok(separator > 1, 'the long heading wraps rather than clipping');
  assert.equal(narrow.slice(0, separator).join(' '), heading);
  assert.ok(narrow.every(line => visibleWidth(line) <= 20));
  const paragraphBreak = narrow.indexOf('', separator + 1);
  assert.ok(paragraphBreak > separator + 2, 'the summary wraps on a narrow panel');
  assert.equal(narrow.slice(separator + 1, paragraphBreak).join(' '), firstParagraph);
  assert.deepEqual(narrow.slice(paragraphBreak), ['', 'Next paragraph']);
  for (const [index, line] of narrow.entries()) {
    if (index > separator && line) {
      assert.ok(narrowFrame[index + 3].includes(theme.fg('muted', line)), 'each wrapped summary row uses the theme muted color');
    }
  }
  assert.equal(closed.memory[0].Summary.body, memory, 'wrapping does not modify saved memory');

  component.handleInput('\x1b');
  component.handleInput('\x1b');
  await result;
});

test('Spine tree handles inactive and non-interactive invocations without opening a panel', async () => {
  const inactive = harness(null);
  await inactive.result;
  assert.equal(inactive.component, undefined);
  assert.match(inactive.notices[0][0], /no active Spine tree/);
  const headless = harness(null, [], 'rpc');
  await headless.result;
  assert.equal(headless.component, undefined);
  assert.deepEqual(headless.notices, []);
});

test('Spawn lines component remains available and clips styled wide text', () => {
  const component = linesComponent(['\x1b[92mSpawned界界\x1b[39m']);
  assert.ok(component.render(6).every(line => visibleWidth(line) <= 6));
  assert.deepEqual(component.render(0), []);
  component.invalidate();
});
