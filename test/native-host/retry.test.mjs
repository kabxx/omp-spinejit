import assert from 'node:assert/strict';
import test from 'node:test';
import { createNativeFixture, spineCall, visibleText, readJournal } from './fixture.mjs';
import { assertFoldedMemory, assertPendingFold } from './fold-assertions.mjs';

const bridge = new URL('./retry.bridge.mjs', import.meta.url);
const initial = 'RETRY-ORIGINAL-HUMAN: preserve CONSTRAINT-INITIAL throughout this task';
const constraint = 'RETRY-LATEST-HUMAN: preserve CONSTRAINT-LATEST and finish the existing owner';
const failed = 'FAILED-PARTIAL-RAW=$$RETRY_CANONICAL$$';
const owner = 'RETRY-CURRENT-OWNER';
const child = 'RETRY-AFTER-RECOVERY-CHILD';
const streamError = { message: '503 service unavailable', status: 503, type: 'server_error', code: 'service_unavailable' };

function retrySettings(overrides = {}) {
  return { retry: {
    enabled: true,
    maxRetries: 1,
    baseDelayMs: 25,
    maxDelayMs: 60_000,
    modelFallback: false,
    usageAwareFallback: false,
    ...overrides,
  } };
}

function assertContext(request, { ownerId = '1.1', forbidden = [failed] } = {}) {
  const text = visibleText(request.messages);
  for (const marker of ['RETRY-ORIGINAL-HUMAN', 'CONSTRAINT-INITIAL', 'RETRY-LATEST-HUMAN', 'CONSTRAINT-LATEST']) {
    assert.equal(text.split(marker).length - 1, 1, `${marker} must appear exactly once in provider context`);
  }
  assert.match(text, new RegExp(`<spine_node id="${ownerId.replaceAll('.', '\\.')}"[^>]*summary="${owner}"[^>]*status="(?:live|opened)"`));
  for (const marker of forbidden) assert.ok(!JSON.stringify(request.messages).includes(marker), `failed assistant leaked to provider: ${marker}`);
}

function sourceMessages(source) {
  return source.cells.flatMap((cell) => cell.item.Message ? [cell.item.Message.message] : []);
}

function assertCanonical(source, failures = [failed]) {
  const messages = sourceMessages(source);
  assert.equal(messages.filter((message) => message.role === 'User' && message.content === initial).length, 1);
  assert.equal(messages.filter((message) => message.role === 'User' && message.content === constraint).length, 1);
  // SourceCharacter records text, not private thinking; failed thinking stays
  // raw in the native journal while its canonical text Source is empty.
  for (const text of failures) assert.ok(!JSON.stringify(source).includes(text));
}

async function snapshot(rpc, token) {
  const prefix = `RETRY-SNAPSHOT:${token}:`;
  await rpc.prompt(`/retry-snapshot ${token}`);
  const frame = await rpc.event((event) => event.type === 'extension_ui_request'
    && event.method === 'notify' && event.message?.startsWith(prefix), `native retry snapshot ${token}`);
  return JSON.parse(frame.message.slice(prefix.length));
}

function assertJournalHumanOnce(journal) {
  const messages = journal.filter((entry) => entry.type === 'message').map((entry) => entry.message);
  for (const marker of [initial, constraint]) {
    assert.equal(messages.filter((message) => message.role === 'user' && visibleText([message]) === marker).length, 1);
  }
  return messages.filter((message) => message.role === 'assistant' && message.stopReason === 'error');
}
function assertFailedThinking(errors, failures) {
  assert.equal(errors.length, failures.length);
  assert.deepEqual(errors.map((message) => message.content.filter((block) => block.type === 'thinking').map((block) => block.thinking).join('')), failures);
  for (const error of errors) assert.equal(visibleText(error), '');
}


async function seedOwner(rpc) {
  assert.equal((await rpc.prompt(initial)).status, 'completed');
}

// Thinking-only failure is explicitly replay-safe for Native TurnRecovery.
// pi-ai commits its nonempty thinking_delta, so its transport retry cannot
// discard this attempt; native events and retryRecovery prove ordinary retry.
test('native ordinary retry preserves owner, constraints and raw Source across physical restart', { timeout: 120_000 }, async (t) => {
  const fixture = await createNativeFixture(t, {
    label: 'ordinary-retry-recovered', bridge, settings: retrySettings(),
    model: { reasoning: true },
    onRequest(request, { index, send }) {
      index -= 1; // Fixture request ordinals are one-based.
      switch (index) {
        case 0: return send(spineCall('spine_open', { goal: owner }));
        case 1: return send('OWNER-READY');
        case 2:
          assertContext(request);
          return send('', { reasoningText: failed, streamError });
        case 3:
          assertContext(request);
          return send('ORDINARY-RETRY-RECOVERED');
        case 4:
          assertContext(request);
          return send(spineCall('spine_open', { goal: child }));
        case 5:
          assert.ok(!visibleText(request.messages).includes(failed));
          assert.match(visibleText(request.messages), /<spine_node id="1\.1\.1"[^>]*summary="RETRY-AFTER-RECOVERY-CHILD"/);
          return send('CHILD-OPENED');
        case 6: return send(spineCall('spine_close', { memory: 'RETRY-CHILD-MEMORY' }));
        case 7:
          assertContext(request);
          assertPendingFold(request, '1.1.1', 'RETRY-CHILD-MEMORY');
          return send('CHILD-CLOSED');
        case 8:
          assertContext(request);
          assertFoldedMemory(request, '1.1.1', 'RETRY-CHILD-MEMORY');
          return send(spineCall('spine_close', { memory: 'RETRY-OWNER-MEMORY' }));
        case 9:
          assert.ok(!visibleText(request.messages).includes(failed));
          assertPendingFold(request, '1.1', 'RETRY-OWNER-MEMORY');
          return send('OWNER-CLOSED');
        case 10:
          assert.ok(!visibleText(request.messages).includes(failed));
          assertFoldedMemory(request, '1.1', 'RETRY-OWNER-MEMORY');
          return send('RETRY-OWNER-MEMORY-VERIFIED');
        default: throw new Error(`unexpected provider request ${index}`);
      }
    },
  });
  let rpc = await fixture.start({ autoRetry: true });
  await seedOwner(rpc);
  const before = await snapshot(rpc, 'before');
  assert.deepEqual(before.projection.cursor, [1, 1]);
  assert.equal((await rpc.prompt(constraint)).status, 'completed');
  const start = await rpc.event((frame) => frame.type === 'auto_retry_start', 'ordinary retry starts');
  const end = await rpc.event((frame) => frame.type === 'auto_retry_end', 'ordinary retry ends');
  assert.equal(start.attempt, 1);
  assert.equal(end.success, true);
  assert.equal(end.attempt, 1);
  assert.equal(fixture.requests.length, 4, 'exactly one native retry request, not a hidden transport retry');
  const recovered = await snapshot(rpc, 'recovered');
  assert.deepEqual(recovered.projection.cursor, [1, 1]);
  assertCanonical(recovered.source);
  const sessionPath = (await rpc.command('get_state')).sessionFile;
  assert.ok(sessionPath, 'real persistent native session path');
  const errors = assertJournalHumanOnce(await readJournal(sessionPath));
  assertFailedThinking(errors, [failed]);
  assert.equal(errors[0].retryRecovery?.kind, 'auto-retry');
  assert.equal(errors[0].retryRecovery?.status, 'recovered');
  assert.equal(errors[0].retryRecovery?.attempt, 1);

  await rpc.close();
  rpc = await fixture.restart(sessionPath, { autoRetry: true });
  const restored = await snapshot(rpc, 'restored');
  assert.deepEqual(restored.source, recovered.source, 'restart replays exact canonical Sources including failed raw bytes');
  assert.deepEqual(restored.projection.cursor, [1, 1]);
  assert.equal((await rpc.prompt('RETRY-OPEN-AFTER-RESTART')).status, 'completed');
  assert.deepEqual((await snapshot(rpc, 'child')).projection.cursor, [1, 1, 1]);
  assert.equal((await rpc.prompt('RETRY-CLOSE-CHILD')).status, 'completed');
  assert.deepEqual((await snapshot(rpc, 'parent')).projection.cursor, [1, 1]);
  assert.equal((await rpc.prompt('RETRY-CLOSE-OWNER')).status, 'completed');
  const finished = await snapshot(rpc, 'finished');
  assert.deepEqual(finished.projection.cursor, [1]);
  assertCanonical(finished.source);
  await rpc.close();
  rpc = await fixture.restart(sessionPath, { autoRetry: true });
  const finalRestored = await snapshot(rpc, 'final-restored');
  assert.deepEqual(finalRestored.source, finished.source);
  assert.deepEqual(finalRestored.projection.cursor, [1]);
  assertJournalHumanOnce(await readJournal(sessionPath));
  assert.equal((await rpc.prompt('Recall the folded owner memory after restart.')).status, 'completed');
  assert.equal(fixture.requests.length, 11);
  await rpc.close();
});

for (const boundary of ['exhausted', 'cancelled']) {
  test(`native ordinary retry ${boundary} settles and cannot poison a later prompt or restart`, { timeout: 120_000 }, async (t) => {
    const secondFailed = 'FAILED-SUPERSEDING-RAW';
    const failures = boundary === 'exhausted' ? [failed, secondFailed] : [failed];
    const fixture = await createNativeFixture(t, {
      label: `ordinary-retry-${boundary}`, bridge,
      settings: retrySettings(boundary === 'cancelled' ? { baseDelayMs: 30_000 } : {}),
      model: { reasoning: true },
      onRequest(request, { index, send }) {
        index -= 1;
        if (index === 0) return send(spineCall('spine_open', { goal: owner }));
        if (index === 1) return send('OWNER-READY');
        const closeIndex = boundary === 'exhausted' ? 4 : 3;
        if (index === closeIndex + 1) {
          const text = visibleText(request.messages);
          for (const marker of failures) assert.ok(!text.includes(marker));
          assert.match(text, new RegExp(`RETRY-${boundary.toUpperCase()}-CLOSE`));
          return send('BOUNDARY-NEXT-PROMPT-COMPLETED');
        }
        assertContext(request, { forbidden: failures });
        if (index === 2) return send('', { reasoningText: failed, streamError });
        if (boundary === 'exhausted' && index === 3) return send('', { reasoningText: secondFailed, streamError });
        if (index === closeIndex) return send(spineCall('spine_close', { memory: `RETRY-${boundary.toUpperCase()}-CLOSE` }));
        throw new Error(`unexpected provider request ${index}`);
      },
    });
    let rpc = await fixture.start({ autoRetry: true });
    await seedOwner(rpc);
    const pending = rpc.prompt(constraint);
    await rpc.event((frame) => frame.type === 'auto_retry_start', 'ordinary boundary retry starts');
    if (boundary === 'cancelled') await rpc.command('abort_retry');
    const result = await pending;
    const end = await rpc.event((frame) => frame.type === 'auto_retry_end', 'ordinary boundary retry ends');
    assert.equal(end.success, false);
    assert.equal(end.attempt, 1);
    assert.notEqual(result.status, 'completed');
    assert.equal(fixture.requests.length, boundary === 'exhausted' ? 4 : 3,
      'cancelled retry must not issue its scheduled provider request');
    const terminal = await snapshot(rpc, 'terminal');
    assert.deepEqual(terminal.projection.cursor, [1, 1]);
    assertCanonical(terminal.source, failures);
    const sessionPath = (await rpc.command('get_state')).sessionFile;
    const errors = assertJournalHumanOnce(await readJournal(sessionPath));
    assertFailedThinking(errors, failures);
    if (boundary === 'exhausted') {
      assert.equal(errors[0].retryRecovery?.kind, 'auto-retry');
      assert.equal(errors[0].retryRecovery?.status, 'superseded');
    }
    await rpc.close();
    rpc = await fixture.restart(sessionPath, { autoRetry: true });
    const restored = await snapshot(rpc, 'restored');
    assert.deepEqual(restored.source, terminal.source);
    assert.deepEqual(restored.projection.cursor, [1, 1]);
    assert.equal((await rpc.prompt(`RETRY-AFTER-${boundary.toUpperCase()}`)).status, 'completed');
    assert.deepEqual((await snapshot(rpc, 'closed')).projection.cursor, [1]);
    assertJournalHumanOnce(await readJournal(sessionPath));
    assert.equal(fixture.requests.length, boundary === 'exhausted' ? 6 : 5);
    await rpc.close();
  });
}

test('native ordinary retry refuses committed partial text instead of duplicating visible output', { timeout: 120_000 }, async (t) => {
  const fixture = await createNativeFixture(t, {
    label: 'ordinary-retry-unsafe-partial', bridge, settings: retrySettings(),
    model: { reasoning: true },
    onRequest(request, { index, send }) {
      if (index === 1) return send(spineCall('spine_open', { goal: owner }));
      if (index === 2) return send('OWNER-READY');
      if (index === 3) {
        assertContext(request);
        return send(failed, { streamError });
      }
      if (index === 4) {
        // Unlike recovered/superseded retry turns, unsafe committed output was
        // delivered and remains ordinary history; do not force a host replay.
        assertContext(request, { forbidden: [] });
        return send(spineCall('spine_close', { memory: 'UNSAFE-PARTIAL-CLOSED-WITHOUT-REPLAY' }));
      }
      if (index === 5) return send('UNSAFE-PARTIAL-CLOSE-COMPLETED');
      throw new Error(`unexpected provider request ${index}`);
    },
  });
  let rpc = await fixture.start({ autoRetry: true });
  await seedOwner(rpc);
  assert.equal((await rpc.prompt(constraint)).status, 'error');
  assert.equal(fixture.requests.length, 3, 'committed text must never schedule an automatic replay');
  assert.equal(rpc.frames.filter((frame) => frame.type === 'auto_retry_start' || frame.type === 'auto_retry_end').length, 0);
  const terminal = await snapshot(rpc, 'unsafe-terminal');
  assert.deepEqual(terminal.projection.cursor, [1, 1]);
  assert.equal(sourceMessages(terminal.source).filter((message) => message.role === 'Assistant' && message.content === failed).length, 1);
  const sessionPath = (await rpc.command('get_state')).sessionFile;
  const errors = assertJournalHumanOnce(await readJournal(sessionPath));
  assert.equal(errors.length, 1);
  assert.equal(visibleText(errors[0]), failed);
  assert.equal(errors[0].retryRecovery, undefined);
  await rpc.close();
  rpc = await fixture.restart(sessionPath, { autoRetry: true });
  const restored = await snapshot(rpc, 'unsafe-restored');
  assert.deepEqual(restored.source, terminal.source, 'raw delivered partial remains canonical across restart');
  assert.deepEqual(restored.projection.cursor, [1, 1]);
  assert.equal((await rpc.prompt('UNSAFE-PARTIAL-FRESH-PROMPT')).status, 'completed');
  assert.deepEqual((await snapshot(rpc, 'unsafe-closed')).projection.cursor, [1]);
  assert.equal(fixture.requests.length, 5);
  assertJournalHumanOnce(await readJournal(sessionPath));
  await rpc.close();
});
