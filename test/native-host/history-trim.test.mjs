import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createNativeFixture, spineCall, visibleText, readJournal } from './fixture.mjs';
import { assertFoldedMemory, assertPendingFold } from './fold-assertions.mjs';

const bridge = new URL('./history-trim.bridge.mjs', import.meta.url);
const OWNER = 'NATIVE-TRIM-ACTIVE-OWNER';
const CONSTRAINT = 'NATIVE-TRIM-LATEST-CONSTRAINT';
const OLD_USER = 'OLD-REQUEST-BLOCK';
const OLD_ASSISTANT = 'OLD-ASSISTANT-BLOCK';
const OLD_TOOL = 'OLD-TOOL-PAYLOAD';
const fenced = (marker) => '```text\n' + Array.from({ length: 64 }, (_, index) => `${marker} disposable line ${index}: value ${index * 37}\n`).join('') + '```';

async function completed(rpc, message, fields = {}) {
  const result = await rpc.prompt(message, fields);
  assert.equal(result.status, 'completed', JSON.stringify(result));
  return result;
}

async function inspect(rpc, operation = 'inspect') {
  const nonce = randomUUID();
  await completed(rpc, '/native-history-trim ' + JSON.stringify({ operation, nonce }));
  const frame = await rpc.event((event) => event.type === 'extension_ui_request'
    && event.method === 'notify' && event.message?.startsWith('CASE-RESULT:')
    && JSON.parse(event.message.slice('CASE-RESULT:'.length)).nonce === nonce,
  `native history ${operation}`);
  return JSON.parse(frame.message.slice('CASE-RESULT:'.length));
}

function nativeMessages(branch) {
  return branch.filter((entry) => entry.type === 'message').map((entry) => entry.message);
}

function assertCallResultPairs(messages, names = ['native_trim_heavy', 'native_trim_kept']) {
  const calls = messages.flatMap((message) => message.tool_calls ?? []);
  const results = messages.filter((message) => message.role === 'tool');
  for (const result of results) {
    assert.ok(calls.some((call) => call.id === result.tool_call_id),
      `Native result ${result.tool_call_id} must retain its matching model call`);
  }
  for (const name of names) {
    const call = calls.find((candidate) => candidate.function?.name === name);
    assert.ok(call, `Retain ${name} model call`);
    assert.ok(results.some((result) => result.tool_call_id === call.id), `Retain ${name} result`);
  }
}

function assertTrimmedProvider(request) {
  const text = visibleText(request.messages);
  for (const marker of [OLD_USER, OLD_ASSISTANT, OLD_TOOL]) {
    assert.ok(!text.includes(marker), `${marker} must not be resurrected by Spine projection`);
  }
  for (const marker of [OWNER, CONSTRAINT, 'KEPT-TOOL-RESULT']) {
    assert.ok(text.includes(marker), `${marker} must survive native rewrite`);
  }
  assertCallResultPairs(request.messages);
}

// OMP 18.8.6 exposes shake, not a generic text-message omit/context_edit producer.
// Elide rewrites fenced/XML text and whole tool-result text in place; tool-call
// entries and non-fenced constraints remain. Thinking below tests its real omit mode.
test('native shake elide rewrites old request/assistant/results without resurrection, including resume', async (t) => {
  const fixture = await createNativeFixture(t, {
    label: 'history-elide', bridge,
    onRequest(request, { send, index }) {
      index -= 1;
      switch (index) {
        case 0: return send(spineCall('spine_open', { goal: OWNER }));
        case 1: return send('KEEP-ASSISTANT-PROSE\n' + fenced(OLD_ASSISTANT));
        case 2: return send([
          { name: 'native_trim_heavy', arguments: {} },
          { name: 'native_trim_kept', arguments: {} },
        ]);
        case 3: {
          const text = visibleText(request.messages);
          for (const marker of [OLD_USER, OLD_ASSISTANT, OLD_TOOL, 'KEPT-TOOL-RESULT']) {
            assert.ok(text.includes(marker), `${marker} must be visible before real native trimming`);
          }
          assertCallResultPairs(request.messages);
          return send('NATIVE-TRIM-READY');
        }
        case 4:
        case 5:
          assertTrimmedProvider(request);
          return send(index === 4 ? 'LIVE-TRIM-HEALTHY' : 'RESUMED-TRIM-HEALTHY');
        default: throw new Error(`Unexpected native history inference ${index}`);
      }
    },
  });
  const rpc = await fixture.start();
  await completed(rpc, 'BASE-TRIM-CONSTRAINT: open and preserve the active owner.');
  await completed(rpc, CONSTRAINT + ': keep this instruction outside the disposable block.\n' + fenced(OLD_USER));
  const before = await inspect(rpc);
  const trimmed = await inspect(rpc, 'elide');
  assert.equal(trimmed.result.mode, 'elide');
  assert.equal(trimmed.result.toolResultsDropped, 1);
  assert.equal(trimmed.result.blocksDropped, 2);
  assert.ok(trimmed.result.tokensFreed > 0);
  assert.ok(trimmed.result.artifactId, 'Native rewrite must publish its recoverable artifact');
  assert.deepEqual(trimmed.branch.map((entry) => entry.id), before.branch.map((entry) => entry.id),
    'Shake rewrites the same native history, not a branch or session substitute');
  assert.deepEqual(trimmed.source, before.source, 'Native view rewrite must not mutate canonical Source');
  const nativeText = visibleText(nativeMessages(trimmed.branch));
  for (const marker of [OLD_USER, OLD_ASSISTANT, OLD_TOOL]) assert.ok(!nativeText.includes(marker));
  for (const marker of [CONSTRAINT, 'KEEP-ASSISTANT-PROSE', 'KEPT-TOOL-RESULT']) assert.ok(nativeText.includes(marker));
  const disk = await readJournal(trimmed.sessionPath);
  assert.deepEqual(disk.filter((entry) => entry.type === 'message'), trimmed.branch.filter((entry) => entry.type === 'message'),
    'Native session rewrite must be durable before reporting success');
  const artifact = await readFile(trimmed.artifactPath, 'utf8');
  for (const marker of [OLD_USER, OLD_ASSISTANT, OLD_TOOL]) assert.ok(artifact.includes(marker));
  await completed(rpc, 'Verify the live trimmed provider context.');
  const live = await inspect(rpc);
  assert.deepEqual(live.source.cells.slice(0, before.source.cells.length), before.source.cells,
    'Further sampling preserves already committed Source boundaries');
  await rpc.close();
  const resumed = await fixture.restart(trimmed.sessionPath);
  const restored = await inspect(resumed);
  assert.deepEqual(restored.source, live.source, 'Replay restores Source across a native in-place rewrite');
  await completed(resumed, 'Verify resumed native trimming and the retained active owner.');
  assert.equal(fixture.requests.length, 6);
  await resumed.close();
});

test('native shake thinking omits real provider reasoning while retaining assistant text, owner and Source on resume', async (t) => {
  const secret = 'NATIVE-THINKING-TO-OMIT';
  const answer = 'NATIVE-ASSISTANT-TEXT-TO-KEEP';
  const fixture = await createNativeFixture(t, {
    label: 'history-thinking', bridge,
    model: { reasoning: true, compat: { replayReasoningContent: true } },
    onRequest(request, { send, index }) {
      index -= 1;
      switch (index) {
        case 0: return send(spineCall('spine_open', { goal: OWNER }));
        case 1: return send(answer, { reasoningText: secret });
        case 2:
          assert.ok(JSON.stringify(request.messages).includes(secret), 'Reasoning is provider-visible before omission');
          return send('THINKING-TRIM-READY');
        case 3:
        case 4: {
          assert.ok(!JSON.stringify(request.messages).includes(secret), 'Native omitted reasoning stays omitted');
          const text = visibleText(request.messages);
          for (const marker of [answer, OWNER, CONSTRAINT]) assert.ok(text.includes(marker));
          return send(index === 3 ? 'THINKING-LIVE-HEALTHY' : 'THINKING-RESUME-HEALTHY');
        }
        default: throw new Error(`Unexpected native thinking inference ${index}`);
      }
    },
  });
  const rpc = await fixture.start();
  await completed(rpc, CONSTRAINT + ': retain the owner and visible assistant answer.');
  await completed(rpc, 'Confirm untrimmed reasoning replay.');
  const before = await inspect(rpc);
  const assistantBefore = nativeMessages(before.branch).find((message) => message.role === 'assistant'
    && message.content.some((part) => part.type === 'thinking' && part.thinking === secret));
  assert.ok(assistantBefore, 'Reasoning must originate from the actual native SSE consumer');
  const trimmed = await inspect(rpc, 'thinking');
  assert.equal(trimmed.result.thinkingBlocksDropped, 1);
  assert.deepEqual(trimmed.branch.map((entry) => entry.id), before.branch.map((entry) => entry.id));
  assert.deepEqual(trimmed.source, before.source);
  assert.ok(!JSON.stringify(nativeMessages(trimmed.branch)).includes(secret));
  assert.ok(visibleText(nativeMessages(trimmed.branch)).includes(answer));
  assert.ok(!JSON.stringify((await readJournal(trimmed.sessionPath)).filter((entry) => entry.type === 'message')).includes(secret));
  await completed(rpc, 'Verify thinking omission in live provider history.');
  const live = await inspect(rpc);
  await rpc.close();
  const resumed = await fixture.restart(trimmed.sessionPath);
  assert.deepEqual((await inspect(resumed)).source, live.source);
  await completed(resumed, 'Verify thinking omission after native session resume.');
  assert.equal(fixture.requests.length, 5);
  await resumed.close();
});

test('native shake images consumes real user and tool PNGs, preserves Source and owner, and survives physical resume', async (t) => {
  // Generated one-pixel RGB PNG, also emitted by the bridge's native tool.
  // RPC uses public ImageContent { type, data, mimeType }, not provider image_url.
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNQ6tgNAAI1AWbwtPEaAAAAAElFTkSuQmCC';
  const image = { type: 'image', data: png, mimeType: 'image/png' };
  const requestText = CONSTRAINT + ': preserve this user text while removing only the attached PNG.';
  const toolText = 'IMAGE-TOOL-TEXT-TO-KEEP';
  const answerText = 'IMAGE-ASSISTANT-TEXT-TO-KEEP';
  const memory = 'IMAGE-TRIM-RESUMED-OWNER-CLOSED';
  const providerImages = (request) => request.messages.flatMap((message) =>
    Array.isArray(message.content) ? message.content.filter((part) => part.type === 'image_url') : []);
  const nativeImages = (messages) => messages.flatMap((message) =>
    Array.isArray(message.content) ? message.content.filter((part) => part.type === 'image') : []);
  function assertNoProviderImages(request) {
    assert.deepEqual(providerImages(request), [], 'Real provider context must not resurrect removed image blocks');
  }
  function assertProviderWithoutImages(request) {
    assertNoProviderImages(request);
    const text = visibleText(request.messages);
    for (const marker of [requestText, toolText, answerText]) assert.ok(text.includes(marker), `Retain ${marker}`);
    assertCallResultPairs(request.messages, ['native_trim_image']);
  }
  function assertActiveOwner(request) {
    assert.match(visibleText(request.messages), /<spine_node id="1\.1"[^>]*summary="NATIVE-TRIM-ACTIVE-OWNER"[^>]*status="(?:live|opened)"/);
  }
  const fixture = await createNativeFixture(t, {
    label: 'history-images', bridge,
    model: { input: ['text', 'image'] },
    onRequest(request, { send, index }) {
      switch (index) {
        case 1: return send(spineCall('spine_open', { goal: OWNER }));
        case 2: return send(answerText);
        case 3: {
          assertActiveOwner(request);
          const images = providerImages(request);
          assert.equal(images.length, 1, 'The actual native user RPC image must reach the provider before surgery');
          assert.ok(visibleText(request.messages).includes(requestText));
          return send({ name: 'native_trim_image', arguments: {} });
        }
        case 4: {
          const images = providerImages(request);
          assert.equal(images.length, 2, 'Native user and native tool-result images must both reach the provider');
          assert.ok(visibleText(request.messages).includes(toolText));
          assertCallResultPairs(request.messages, ['native_trim_image']);
          return send('IMAGE-TRIM-READY');
        }
        case 5:
          assertProviderWithoutImages(request);
          assertActiveOwner(request);
          return send('IMAGE-LIVE-HEALTHY');
        case 6:
          assertProviderWithoutImages(request);
          assertActiveOwner(request);
          return send(spineCall('spine_close', { memory }));
        case 7:
          assertNoProviderImages(request);
          assertPendingFold(request, '1.1', memory);
          return send('IMAGE-RESUMED-CONTROL-HEALTHY');
        case 8:
          assertNoProviderImages(request);
          assertFoldedMemory(request, '1.1', memory);
          return send('IMAGE-FOLDED-CONTROL-HEALTHY');
        default: throw new Error(`Unexpected native image inference ${index}`);
      }
    },
  });
  const rpc = await fixture.start();
  await completed(rpc, 'Open the image-trim owner and retain the assistant prose.');
  await completed(rpc, requestText, { images: [image] });
  const before = await inspect(rpc);
  const messagesBefore = nativeMessages(before.branch);
  const userBefore = messagesBefore.find((message) => message.role === 'user' && visibleText(message) === requestText);
  assert.ok(userBefore, 'User image must be stored by the actual native prompt consumer');
  assert.equal(nativeImages([userBefore]).length, 1, 'The native user producer stores its normalized image');
  const toolBefore = messagesBefore.find((message) => message.role === 'toolResult' && message.toolName === 'native_trim_image');
  assert.ok(toolBefore, 'Tool image must originate from a real registered native tool');
  assert.equal(nativeImages([toolBefore]).length, 1, 'The native tool producer stores its normalized image');
  assert.equal(visibleText(toolBefore), toolText);
  assert.equal(nativeImages(messagesBefore).length, 2);
  const sourceUser = before.source.cells.flatMap((cell) => cell.item.Message ? [cell.item.Message.message] : [])
    .find((message) => message.role === 'User' && message.content.includes(requestText));
  assert.ok(sourceUser?.content.includes('<image>'), 'Canonical Source must retain the user image character');
  const diskBefore = await readJournal(before.sessionPath);
  assert.deepEqual(diskBefore.filter((entry) => entry.type === 'message').map((entry) => entry.id), before.branch.filter((entry) => entry.type === 'message').map((entry) => entry.id));
  assert.equal(nativeImages(nativeMessages(diskBefore)).length, 2, 'Both image-producing messages are actually on disk');

  const trimmed = await inspect(rpc, 'images');
  assert.equal(trimmed.result.mode, 'images');
  assert.equal(trimmed.result.imagesDropped, 2);
  assert.equal(trimmed.result.toolResultsDropped, 0);
  assert.equal(trimmed.result.blocksDropped, 0);
  assert.deepEqual(trimmed.branch.map((entry) => entry.id), before.branch.map((entry) => entry.id),
    'Native image surgery must retain every original journal identity');
  const expectedMessages = structuredClone(messagesBefore);
  for (const message of expectedMessages) {
    if (Array.isArray(message.content)) message.content = message.content.filter((part) => part.type !== 'image');
  }
  const anchor = expectedMessages.findLast((message) => message.role === 'assistant' && message.contextSnapshot);
  assert.ok(anchor, 'Image surgery has a native token accounting anchor');
  assert.ok(trimmed.result.tokensFreed > 0);
  anchor.contextSnapshot.historyRewriteTokensRemoved =
    (anchor.contextSnapshot.historyRewriteTokensRemoved ?? 0) + trimmed.result.tokensFreed;
  assert.deepEqual(nativeMessages(trimmed.branch), expectedMessages,
    'Image surgery preserves all non-image text, call/result pairs, metadata and owner-producing entries');
  assert.deepEqual(trimmed.source, before.source, 'Live canonical Source must keep its original <image> character');
  assert.equal(nativeImages(nativeMessages(trimmed.branch)).length, 0);
  const diskAfter = await readJournal(trimmed.sessionPath);
  assert.equal(nativeImages(nativeMessages(diskAfter)).length, 0, 'Physical native journal contains the completed image removal');
  for (const part of nativeImages(messagesBefore)) assert.ok(!JSON.stringify(diskAfter).includes(part.data), 'Stored image bytes must disappear from the physical journal');
  const noOp = await inspect(rpc, 'images');
  assert.equal(noOp.result.imagesDropped, 0);
  assert.deepEqual(noOp.branch, trimmed.branch);
  assert.deepEqual(noOp.source, trimmed.source);

  await completed(rpc, 'Verify images stay absent in live model context.');
  const live = await inspect(rpc);
  assert.deepEqual(live.source.cells.slice(0, before.source.cells.length), before.source.cells);
  await rpc.close();
  const resumed = await fixture.restart(trimmed.sessionPath);
  const restored = await inspect(resumed);
  assert.deepEqual(restored.source, live.source, 'Physical restart must restore exact canonical Source including <image>');
  assert.equal(nativeImages(nativeMessages(restored.branch)).length, 0);
  await completed(resumed, 'Close the retained owner through real Spine control after image surgery and restart.');
  await completed(resumed, 'Verify that the folded memory does not resurrect the removed images.');
  const controlled = await inspect(resumed);
  assert.deepEqual(controlled.source.cells.slice(0, live.source.cells.length), live.source.cells);
  assert.equal(fixture.requests.length, 8);
  await resumed.close();
});
