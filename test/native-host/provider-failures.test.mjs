import assert from 'node:assert/strict';
import test from 'node:test';
import { createNativeFixture, spineCall, visibleText, readJournal } from './fixture.mjs';

const bridge = new URL('./provider-failures.bridge.mjs', import.meta.url);
const initial = 'PROVIDER-INITIAL-HUMAN preserve PROVIDER-CONSTRAINT-INITIAL';
const latest = 'PROVIDER-LATEST-HUMAN preserve PROVIDER-CONSTRAINT-LATEST';
const owner = 'PROVIDER-CURRENT-OWNER';
const failedThinking = 'PROVIDER-FAILED-PRIVATE-THINKING';
const refusedText = 'PROVIDER-REFUSAL-VISIBLE';
const recovery = 'PROVIDER-RECOVERED';
const memory = 'PROVIDER-OWNER-MEMORY';
const apis = ['openai-completions', 'openai-responses', 'anthropic-messages'];
const routes = { 'openai-completions': '/v1/chat/completions', 'openai-responses': '/v1/responses', 'anthropic-messages': '/v1/messages' };

function settings(extra = {}) {
  return {
    retry: { enabled: true, maxRetries: 1, baseDelayMs: 25, maxDelayMs: 60_000, modelFallback: false, usageAwareFallback: false },
    ...extra,
  };
}

function strings(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  return value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
}

function requestText(request) {
  return strings(request.messages ?? request.input).join('\n');
}

function assertContext(request, { closed = false, allowRefusal = false } = {}) {
  const text = requestText(request);
  if (closed) {
    assert.ok(text.includes(memory), 'closed owner memory reaches the real model request');
  } else {
    for (const marker of ['PROVIDER-INITIAL-HUMAN', 'PROVIDER-CONSTRAINT-INITIAL', 'PROVIDER-LATEST-HUMAN', 'PROVIDER-CONSTRAINT-LATEST']) {
      assert.equal(text.split(marker).length - 1, 1, `${marker} must occur once, never duplicate the human on replay`);
    }
    assert.match(text, /<spine_node id="1\.1"[^>]*summary="PROVIDER-CURRENT-OWNER"[^>]*status="(?:live|opened)"/);
  }
  assert.ok(!text.includes(failedThinking), 'failed private thinking is filtered from provider input');
  if (!allowRefusal) assert.ok(!text.includes(refusedText), 'discarded refusal is filtered from provider input');
}

function startSse(response) {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  response.flushHeaders();
  let sequence = 0;
  return (event) => response.write(`event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number: sequence++ })}\n\n`);
}

// These are actual provider wire formats consumed by the bundled SDK parsers,
// not synthesized AssistantMessages or replacement stream functions.
function responsesWire(request, { response, index }, action, { thinking, error, refusal = false } = {}) {
  const emit = startSse(response);
  const id = `resp_provider_${index}`;
  emit({ type: 'response.created', response: { id, object: 'response', status: 'in_progress', model: request.model, output: [] } });
  const output = [];
  if (thinking !== undefined) {
    const item = { id: `rs_${index}`, type: 'reasoning', summary: [{ type: 'summary_text', text: thinking }] };
    emit({ type: 'response.output_item.added', output_index: 0, item: { ...item, summary: [] } });
    emit({ type: 'response.reasoning_summary_part.added', output_index: 0, item_id: item.id, summary_index: 0, part: { type: 'summary_text', text: '' } });
    emit({ type: 'response.reasoning_summary_text.delta', output_index: 0, item_id: item.id, summary_index: 0, delta: thinking });
    emit({ type: 'response.output_item.done', output_index: 0, item });
    output.push(item);
  }
  if (error) {
    emit({ type: 'response.failed', response: { id, status: 'failed', error, output, usage: { input_tokens: 100, output_tokens: 7, total_tokens: 107 } } });
    response.end();
    return;
  }
  if (action !== undefined) {
    const ordinal = output.length;
    const item = typeof action === 'string'
      ? { id: `msg_${index}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: refusal ? 'refusal' : 'output_text', ...(refusal ? { refusal: action } : { text: action, annotations: [] }) }] }
      : { id: `fc_${index}`, type: 'function_call', call_id: `call_${index}`, name: action.name, arguments: JSON.stringify(action.arguments), status: 'completed' };
    emit({ type: 'response.output_item.added', output_index: ordinal, item: { ...item, ...(typeof action === 'string' ? { content: [] } : { arguments: '' }) } });
    emit(typeof action === 'string'
      ? { type: refusal ? 'response.refusal.delta' : 'response.output_text.delta', output_index: ordinal, item_id: item.id, content_index: 0, delta: action }
      : { type: 'response.function_call_arguments.delta', output_index: ordinal, item_id: item.id, delta: item.arguments });
    emit({ type: 'response.output_item.done', output_index: ordinal, item });
    output.push(item);
  }
  emit({ type: refusal ? 'response.incomplete' : 'response.completed', response: {
    id, object: 'response', model: request.model, status: refusal ? 'incomplete' : 'completed', output,
    ...(refusal ? { incomplete_details: { reason: 'content_filter' } } : {}),
    usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
  } });
  response.end();
}

function anthropicWire(request, { response, index }, action, { thinking, error, refusal = false } = {}) {
  const emit = startSse(response);
  emit({ type: 'message_start', message: { id: `msg_provider_${index}`, type: 'message', role: 'assistant', model: request.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } });
  let ordinal = 0;
  if (thinking !== undefined) {
    emit({ type: 'content_block_start', index: ordinal, content_block: { type: 'thinking', thinking: '', signature: '' } });
    emit({ type: 'content_block_delta', index: ordinal, delta: { type: 'thinking_delta', thinking } });
    emit({ type: 'content_block_delta', index: ordinal, delta: { type: 'signature_delta', signature: 'local-fixture-signature' } });
    emit({ type: 'content_block_stop', index: ordinal++ });
  }
  if (error) {
    emit({ type: 'error', error });
    response.end();
    return;
  }
  if (action !== undefined) {
    const text = typeof action === 'string';
    emit({ type: 'content_block_start', index: ordinal, content_block: text ? { type: 'text', text: '' } : { type: 'tool_use', id: `tool_provider_${index}`, name: action.name, input: {} } });
    emit({ type: 'content_block_delta', index: ordinal, delta: text ? { type: 'text_delta', text: action } : { type: 'input_json_delta', partial_json: JSON.stringify(action.arguments) } });
    emit({ type: 'content_block_stop', index: ordinal });
  }
  emit({ type: 'message_delta', delta: {
    stop_reason: refusal ? 'refusal' : typeof action === 'object' ? 'tool_use' : 'end_turn', stop_sequence: null,
    ...(refusal ? { stop_details: { type: 'refusal', category: 'safety', explanation: 'LOCAL-PROVIDER-REFUSAL-DETAIL' } } : {}),
  }, usage: { output_tokens: 20 } });
  emit({ type: 'message_stop' });
  response.end();
}

function sendWire(api, request, io, action, options = {}) {
  assert.equal(io.path, routes[api], 'actual native provider route');
  assert.equal(request.stream, true);
  if (api === 'openai-responses') return responsesWire(request, io, action, options);
  if (api === 'anthropic-messages') return anthropicWire(request, io, action, options);
  return io.send(action ?? '', { reasoningText: options.thinking, streamError: options.error });
}

async function snapshot(rpc, token) {
  const prefix = `PROVIDER-SNAPSHOT:${token}:`;
  await rpc.prompt(`/provider-snapshot ${token}`);
  const event = await rpc.event((frame) => frame.type === 'extension_ui_request' && frame.method === 'notify' && frame.message?.startsWith(prefix), `provider snapshot ${token}`);
  return JSON.parse(event.message.slice(prefix.length));
}

function assertHumans(source) {
  const messages = source.cells.flatMap((cell) => cell.item.Message ? [cell.item.Message.message] : []);
  for (const human of [initial, latest]) {
    assert.equal(messages.filter((message) => message.role === 'User' && message.content === human).length, 1);
  }
  assert.ok(!JSON.stringify(source).includes(failedThinking), 'private failed thinking never becomes text Source');
}

async function assertDurable(rpc, state) {
  assertHumans(state.source);
  const path = (await rpc.command('get_state')).sessionFile;
  assert.ok(path);
  const journal = await readJournal(path);
  for (const human of [initial, latest]) {
    assert.equal(journal.filter((entry) => entry.type === 'message' && entry.message.role === 'user' && visibleText(entry.message) === human).length, 1);
  }
  assert.ok(journal.some((entry) => entry.type === 'custom' && entry.customType === 'spine.source.v1'), 'canonical Source is durably checkpointed in the real native journal');
  return path;
}

async function restartAndCloseOwner(fixture, rpc, state, { autoRetry = true } = {}) {
  const path = await assertDurable(rpc, state);
  assert.deepEqual(state.projection.cursor, [1, 1]);
  await rpc.close();
  rpc = await fixture.restart(path, { autoRetry });
  const restored = await snapshot(rpc, 'restored');
  assert.deepEqual(restored.source, state.source, 'physical restart restores canonical Source exactly');
  assert.deepEqual(restored.projection.cursor, [1, 1]);
  assert.equal((await rpc.prompt('PROVIDER-CLOSE-AFTER-RESTART')).status, 'completed');
  const closed = await snapshot(rpc, 'closed');
  assert.deepEqual(closed.projection.cursor, [1]);
  assertHumans(closed.source);
  await rpc.close();
  rpc = await fixture.restart(path, { autoRetry });
  assert.deepEqual((await snapshot(rpc, 'closed-restored')).source, closed.source);
  await rpc.close();
}

function seedAndTail(api, request, io, tailStart, { allowRefusal = false } = {}) {
  if (io.index === 1) return { handled: true, value: sendWire(api, request, io, spineCall('spine_open', { goal: owner })) };
  if (io.index === 2) return { handled: true, value: sendWire(api, request, io, 'PROVIDER-OWNER-READY') };
  if (io.index === tailStart) {
    assertContext(request, { allowRefusal });
    return { handled: true, value: sendWire(api, request, io, spineCall('spine_close', { memory })) };
  }
  if (io.index === tailStart + 1) {
    assertContext(request, { closed: true, allowRefusal });
    return { handled: true, value: sendWire(api, request, io, 'PROVIDER-OWNER-CLOSED') };
  }
  return { handled: false };
}

for (const api of apis) {
  for (const status of [400, 401]) {
    test(`${api} HTTP ${status} settles visibly without transport/native replay and accepts control after restart`, { timeout: 120_000 }, async (t) => {
      const fixture = await createNativeFixture(t, {
        label: `provider-${api}-${status}`, bridge, api, settings: settings(),
        onRequest(request, io) {
          assert.equal(io.path, routes[api]);
          const seeded = seedAndTail(api, request, io, 4);
          if (seeded.handled) return seeded.value;
          assert.equal(io.index, 3);
          assertContext(request);
          io.fail(status, { type: 'error', error: { type: status === 401 ? 'authentication_error' : 'invalid_request_error', code: status === 401 ? 'invalid_api_key' : 'invalid_request', message: `LOCAL-FAULT-${status}` } });
        },
      });
      const rpc = await fixture.start({ autoRetry: true });
      assert.equal((await rpc.prompt(initial)).status, 'completed');
      assert.equal((await rpc.prompt(latest)).status, 'error');
      assert.equal(fixture.requests.length, 3, 'nonretryable 4xx is not resubmitted');
      assert.equal(rpc.frames.filter((frame) => frame.type === 'auto_retry_start').length, 0);
      const state = await snapshot(rpc, 'terminal');
      assert.equal(state.errors.length, 1, 'terminal empty error is durable, not silently discarded');
      assert.equal(state.errors[0].message.errorStatus, status);
      assert.equal(state.errors[0].retriable, false, 'SDK-classified terminal status');
      assert.ok(rpc.frames.some((frame) => frame.type === 'message_end' && frame.message?.role === 'assistant' && frame.message.stopReason === 'error' && frame.message.errorStatus === status));
      await restartAndCloseOwner(fixture, rpc, state);
      assert.equal(fixture.requests.length, 5);
    });
  }
}

for (const api of ['openai-responses', 'anthropic-messages']) {
  test(`${api} retryable SSE error preserves Source, owner and filtered model view through native recovery`, { timeout: 120_000 }, async (t) => {
    const fixture = await createNativeFixture(t, {
      label: `provider-${api}-inband`, bridge, api, settings: settings(), model: { reasoning: true, compat: { statefulResponses: false } },
      onRequest(request, io) {
        const seeded = seedAndTail(api, request, io, 5);
        if (seeded.handled) return seeded.value;
        assertContext(request);
        if (io.index === 3) return sendWire(api, request, io, undefined, { thinking: failedThinking, error: { type: 'overloaded_error', code: 'service_unavailable', message: 'LOCAL-RETRYABLE-FAULT', status: 503 } });
        assert.equal(io.index, 4);
        return sendWire(api, request, io, recovery);
      },
    });
    const rpc = await fixture.start({ autoRetry: true });
    assert.equal((await rpc.prompt(initial)).status, 'completed');
    assert.equal((await rpc.prompt(latest)).status, 'completed');
    const started = await rpc.event((frame) => frame.type === 'auto_retry_start', 'real native provider retry');
    assert.equal(started.attempt, 1);
    assert.equal((await rpc.event((frame) => frame.type === 'auto_retry_end', 'native retry outcome')).success, true);
    assert.equal(fixture.requests.length, 4);
    const state = await snapshot(rpc, 'recovered');
    assert.equal(state.errors.length, 1);
    assert.equal(state.errors[0].transient, true, 'the corresponding SDK classifies the in-band provider envelope');
    assert.equal(state.errors[0].message.retryRecovery?.status, 'recovered');
    assert.equal(visibleText(state.errors[0].message), '');
    assert.ok(JSON.stringify(state.errors[0].message.content).includes(failedThinking));
    assert.ok(!JSON.stringify(state.messages).includes(failedThinking), 'recovered fault is absent from native active model view');
    await restartAndCloseOwner(fixture, rpc, state);
    assert.equal(fixture.requests.length, 6);
  });

  test(`${api} wire refusal is fault-visible and committed text is never automatically replayed`, { timeout: 120_000 }, async (t) => {
    const fixture = await createNativeFixture(t, {
      label: `provider-${api}-refusal`, bridge, api, settings: settings(),
      onRequest(request, io) {
        const seeded = seedAndTail(api, request, io, 4, { allowRefusal: api === 'openai-responses' });
        if (seeded.handled) return seeded.value;
        assert.equal(io.index, 3);
        assertContext(request);
        return sendWire(api, request, io, refusedText, { refusal: true });
      },
    });
    const rpc = await fixture.start({ autoRetry: true });
    assert.equal((await rpc.prompt(initial)).status, 'completed');
    assert.equal((await rpc.prompt(latest)).status, 'error');
    assert.equal(fixture.requests.length, 3);
    assert.equal(rpc.frames.filter((frame) => frame.type === 'auto_retry_start').length, 0);
    const state = await snapshot(rpc, 'refusal');
    if (api === 'openai-responses') {
      assert.equal(state.errors.length, 1);
      assert.equal(state.errors[0].contentBlocked, true, 'Responses content_filter uses the SDK ContentBlocked flag');
      assert.equal(visibleText(state.errors[0].message), refusedText);
      assert.ok(JSON.stringify(state.source).includes(refusedText), 'persisted content-blocked output stays canonical');
    } else {
      assert.equal(state.errors.length, 0, 'Native does not persist structured Anthropic refusals');
      assert.ok(!JSON.stringify(state.source).includes(refusedText), 'display-only classifier refusal cannot become Source');
      assert.ok(rpc.frames.some((frame) => frame.type === 'message_end' && frame.message?.stopDetails?.type === 'refusal'));
    }
    assert.ok(rpc.frames.some((frame) => frame.type === 'message_end' && frame.message?.stopReason === 'error' && visibleText(frame.message) === refusedText));
    await restartAndCloseOwner(fixture, rpc, state);
    assert.equal(fixture.requests.length, 5);
  });
}

test('HTTP 429 Retry-After paces real transport retry without duplicating native human/owner', { timeout: 120_000 }, async (t) => {
  const timestamps = [];
  const fixture = await createNativeFixture(t, {
    label: 'provider-http429-retry-after', bridge, settings: settings(),
    onRequest(request, io) {
      const seeded = seedAndTail('openai-completions', request, io, 5);
      if (seeded.handled) return seeded.value;
      assertContext(request);
      timestamps.push(performance.now());
      if (io.index === 3) return io.fail(429, { error: { type: 'rate_limit_error', message: 'LOCAL-RPM-THROTTLE' } }, { 'retry-after': '1' });
      assert.equal(io.index, 4);
      return sendWire('openai-completions', request, io, recovery);
    },
  });
  const rpc = await fixture.start({ autoRetry: true });
  assert.equal((await rpc.prompt(initial)).status, 'completed');
  assert.equal((await rpc.prompt(latest)).status, 'completed');
  assert.equal(fixture.requests.length, 4);
  assert.deepEqual(fixture.requests[3], fixture.requests[2], 'transport retry resubmits the same provider payload');
  assert.ok(timestamps[1] - timestamps[0] >= 900, 'real Retry-After wait, not immediate resubmission');
  assert.equal(rpc.frames.filter((frame) => frame.type === 'auto_retry_start').length, 0, 'transport retry is not misreported as native turn replay');
  const state = await snapshot(rpc, 'transport-recovered');
  assert.equal(state.errors.length, 0, 'transport-only error never commits a fake assistant failure');
  await restartAndCloseOwner(fixture, rpc, state);
  assert.equal(fixture.requests.length, 6);
});

test('connection reset before headers retries real localhost fetch and settles one native user turn', { timeout: 120_000 }, async (t) => {
  const fixture = await createNativeFixture(t, {
    label: 'provider-connection-reset', bridge, settings: settings(),
    onRequest(request, io) {
      const seeded = seedAndTail('openai-completions', request, io, 5);
      if (seeded.handled) return seeded.value;
      assertContext(request);
      if (io.index === 3) return io.disconnect();
      assert.equal(io.index, 4);
      return sendWire('openai-completions', request, io, recovery);
    },
  });
  const rpc = await fixture.start({ autoRetry: true });
  assert.equal((await rpc.prompt(initial)).status, 'completed');
  assert.equal((await rpc.prompt(latest)).status, 'completed');
  assert.equal(fixture.requests.length, 4);
  assert.deepEqual(fixture.requests[2], fixture.requests[3]);
  const state = await snapshot(rpc, 'connection-recovered');
  assert.equal(state.errors.length, 0);
  await restartAndCloseOwner(fixture, rpc, state);
  assert.equal(fixture.requests.length, 6);
});

test('body-read socket loss after consumed thinking is visible and uses native replay-safe recovery', { timeout: 120_000 }, async (t) => {
  let rpc;
  const fixture = await createNativeFixture(t, {
    label: 'provider-body-read-disconnect', bridge, settings: settings(), model: { reasoning: true },
    async onRequest(request, io) {
      const seeded = seedAndTail('openai-completions', request, io, 5);
      if (seeded.handled) return seeded.value;
      assertContext(request);
      if (io.index === 3) {
        io.response.writeHead(200, { 'content-type': 'text/event-stream' });
        io.response.write(`data: ${JSON.stringify({ id: 'body-fault', object: 'chat.completion.chunk', created: 1, model: request.model, choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: failedThinking }, finish_reason: null }] })}\n\n`);
        await rpc.event((frame) => frame.type === 'message_update' && frame.assistantMessageEvent?.type === 'thinking_delta' && frame.assistantMessageEvent.delta === failedThinking, 'native consumes body bytes before reset');
        io.disconnect();
        return;
      }
      assert.equal(io.index, 4);
      return sendWire('openai-completions', request, io, recovery);
    },
  });
  rpc = await fixture.start({ autoRetry: true });
  assert.equal((await rpc.prompt(initial)).status, 'completed');
  assert.equal((await rpc.prompt(latest)).status, 'completed');
  assert.equal((await rpc.event((frame) => frame.type === 'auto_retry_end', 'body-read retry outcome')).success, true);
  assert.equal(fixture.requests.length, 4);
  const state = await snapshot(rpc, 'body-recovered');
  assert.equal(state.errors.length, 1);
  assert.equal(state.errors[0].transient, true);
  assert.equal(state.errors[0].message.retryRecovery?.status, 'recovered');
  assert.ok(JSON.stringify(state.errors[0].message.content).includes(failedThinking), 'real streamed failure bytes stay in native durable raw message');
  assert.ok(!JSON.stringify(state.messages).includes(failedThinking));
  assert.ok(rpc.frames.some((frame) => frame.type === 'message_end' && frame.message?.stopReason === 'error'));
  await restartAndCloseOwner(fixture, rpc, state);
  assert.equal(fixture.requests.length, 6);
});

test('public SDK first-event timeout aborts a genuine stalled native Responses request and recovers', { timeout: 120_000 }, async (t) => {
  let disconnected = false;
  const fixture = await createNativeFixture(t, {
    label: 'provider-native-timeout', bridge, api: 'openai-responses',
    settings: settings({ providers: { streamFirstEventTimeoutSeconds: 0.25, streamIdleTimeoutSeconds: 0.25 } }),
    onRequest(request, io) {
      const seeded = seedAndTail('openai-responses', request, io, 5);
      if (seeded.handled) return seeded.value;
      assertContext(request);
      if (io.index === 3) {
        assert.equal(io.path, '/v1/responses');
        io.response.once('close', () => { disconnected = true; });
        // Intentionally send neither headers nor body. Only the SDK's public
        // watchdog, not a fixture throw/timer, may terminate this real request.
        return;
      }
      assert.equal(io.index, 4);
      return sendWire('openai-responses', request, io, recovery);
    },
  });
  const rpc = await fixture.start({ autoRetry: true });
  assert.equal((await rpc.prompt(initial)).status, 'completed');
  assert.equal((await rpc.prompt(latest)).status, 'completed');
  assert.equal(fixture.requests.length, 4);
  assert.equal((await rpc.event((frame) => frame.type === 'auto_retry_end', 'watchdog retry outcome')).success, true);
  assert.equal(disconnected, true, 'SDK watchdog actually closes the stalled local request');
  const state = await snapshot(rpc, 'timeout-recovered');
  assert.equal(state.errors.length, 1);
  assert.equal(state.errors[0].timeout, true, 'actual SDK timeout classification');
  assert.equal(state.errors[0].message.retryRecovery?.status, 'recovered');
  assert.ok(rpc.frames.some((frame) => frame.type === 'message_end' && frame.message?.stopReason === 'error'));
  await restartAndCloseOwner(fixture, rpc, state);
  assert.equal(fixture.requests.length, 6);
});

for (const api of ['openai-responses', 'anthropic-messages']) {
  test(`${api} pre-output classifier refusal is visible and never retries the refused route`, { timeout: 120_000 }, async (t) => {
    const fixture = await createNativeFixture(t, {
      label: `provider-${api}-empty-refusal`, bridge, api, settings: settings(),
      onRequest(request, io) {
        const seeded = seedAndTail(api, request, io, 4);
        if (seeded.handled) return seeded.value;
        assert.equal(io.index, 3);
        assertContext(request);
        return sendWire(api, request, io, undefined, { refusal: true });
      },
    });
    const rpc = await fixture.start({ autoRetry: true });
    assert.equal((await rpc.prompt(initial)).status, 'completed');
    assert.equal((await rpc.prompt(latest)).status, 'error');
    assert.equal(fixture.requests.length, 3, 'classifier refusal must not retry the same refused route even before visible output');
    assert.equal(rpc.frames.filter((frame) => frame.type === 'auto_retry_start').length, 0);
    const state = await snapshot(rpc, 'empty-refusal');
    if (api === 'openai-responses') {
      assert.equal(state.errors.length, 1);
      assert.equal(visibleText(state.errors[0].message), '');
      assert.equal(state.errors[0].contentBlocked, true);
    } else {
      assert.equal(state.errors.length, 0, 'Native keeps structured classifier refusals display-only');
      assert.ok(rpc.frames.some((frame) => frame.type === 'message_end' && frame.message?.stopDetails?.type === 'refusal'));
    }
    assert.ok(rpc.frames.some((frame) => frame.type === 'message_end' && frame.message?.stopReason === 'error'));
    await restartAndCloseOwner(fixture, rpc, state);
    assert.equal(fixture.requests.length, 5);
  });
}
