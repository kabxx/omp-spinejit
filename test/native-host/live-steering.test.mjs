import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";
import { createNativeFixture, readJournal, spineCall } from "./fixture.mjs";
import { MOCK_MODEL_ID, MOCK_PROVIDER } from "../mock-model.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

// Real Codex wire events, parsed by the bundled native provider. No fabricated
// AgentMessages, event delivery, storage entries or adapter handler replacement.
function response(socket, index) {
  const id = `resp_live_${index}`;
  let sequence = 0;
  const output = [];
  const emit = (event) => socket.send(JSON.stringify({ ...event, sequence_number: sequence++ }));
  emit({ type: "response.created", response: { id, object: "response", status: "in_progress", model: MOCK_MODEL_ID, output: [] } });
  const reasoning = { id: `rs_${index}`, type: "reasoning", summary: [{ type: "summary_text", text: `LIVE-REASONING-${index}` }] };
  emit({ type: "response.output_item.added", output_index: 0, item: { ...reasoning, summary: [] } });
  emit({ type: "response.reasoning_summary_part.added", output_index: 0, item_id: reasoning.id, summary_index: 0, part: { type: "summary_text", text: "" } });
  emit({ type: "response.reasoning_summary_text.delta", output_index: 0, item_id: reasoning.id, summary_index: 0, delta: reasoning.summary[0].text });
  emit({ type: "response.output_item.done", output_index: 0, item: reasoning });
  output.push(reasoning);
  return {
    emit, id,
    finish(action) {
      for (const [offset, part] of (Array.isArray(action) ? action : [action]).entries()) {
        const ordinal = output.length;
        const item = typeof part === "string"
          ? { id: `msg_${index}_${offset}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: part, annotations: [] }] }
          : { id: `fc_${index}_${offset}`, type: "function_call", call_id: `call_${index}_${offset}`, name: part.name, arguments: JSON.stringify(part.arguments), status: "completed" };
        emit({ type: "response.output_item.added", output_index: ordinal, item: { ...item, ...(typeof part === "string" ? { content: [] } : { arguments: "" }) } });
        emit(typeof part === "string"
          ? { type: "response.output_text.delta", output_index: ordinal, item_id: item.id, content_index: 0, delta: part }
          : { type: "response.function_call_arguments.delta", output_index: ordinal, item_id: item.id, delta: item.arguments });
        emit({ type: "response.output_item.done", output_index: ordinal, item });
        output.push(item);
      }
      emit({ type: "response.completed", response: {
        id, object: "response", status: "completed", end_turn: typeof action === "string", output,
        usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
      } });
    },
  };
}

for (const accepted of [true, false]) {
  test(`native Codex WebSocket live steering preserves Close, Source and restart (${accepted ? "accepted" : "rejected"})`, { timeout: 120_000 }, async (t) => {
    const marker = "LIVE-STEERING-NEW-USER";
    const entered = deferred();
    const release = deferred();
    const frames = [];
    let index = 0;
    let pendingReply;
    let rpc;
    const entry = process.env.OMP_STEERING_ENTRY;
    const fixture = await createNativeFixture(t, {
      label: "live-steering", api: "openai-codex-responses",
      bridge: entry ? pathToFileURL(entry) : undefined,
      model: { preferWebsockets: true, compat: { supportsSteering: true } },
      onRequest() { assert.fail("Unexpected HTTP fallback; proof must use actual WebSocket live steering"); },
    });
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    t.after(async () => {
      for (const socket of server.clients) socket.terminate();
      await new Promise((resolve) => server.close(resolve));
      if (process.env.OMP_NATIVE_EVIDENCE_DIR) {
        await writeFile(join(fixture.root, "websocket-frames.json"), JSON.stringify(frames, null, 2));
      }
    });
    const modelsPath = join(fixture.profile, "models.yml");
    const models = JSON.parse(await readFile(modelsPath, "utf8"));
    models.providers[MOCK_PROVIDER].baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    await writeFile(modelsPath, JSON.stringify(models));
    server.on("connection", (socket) => socket.on("message", (bytes) => {
      try {
        const frame = JSON.parse(bytes.toString());
        frames.push(frame);
        if (frame.type === "response.steer") {
          assert.equal(frame.previous_response_id, "resp_live_3");
          assert.equal(JSON.stringify(frame.input).split(marker).length - 1, 1);
          assert.ok(frame.input.every((message) => message.role === "user"), "whole Spine history cannot leak into live input");
          pendingReply.emit(accepted
            ? { type: "response.steer.accepted", steer: { id: "live-steer-1", previous_response_id: pendingReply.id } }
            : { type: "response.steer.failed", steer: { previous_response_id: pendingReply.id, input: frame.input },
              error: { type: "invalid_request_error", code: "response_already_completed", message: "response is already completing" } });
          release.resolve();
          return;
        }
        assert.equal(frame.type, "response.create");
        fixture.requests.push(frame);
        const current = ++index;
        const reply = response(socket, current);
        if (current === 1) return reply.finish(spineCall("spine_open", { goal: "LIVE-PARENT" }));
        if (current === 2) return reply.finish(spineCall("spine_open", { goal: "LIVE-CHILD" }));
        if (current === 3) {
          pendingReply = reply;
          entered.resolve();
          // Model latency leaves a real in-flight reply while user input is taken.
          // An unfixed adapter also reaches replay when it prevents response.steer;
          // failure is the actual source fault, not a missing-server-frame timeout.
          let timer;
          const completing = new Promise((resolve) => { timer = setTimeout(resolve, 750); });
          Promise.race([release.promise, completing]).then(() => {
            clearTimeout(timer);
            reply.finish([
              spineCall("spine_close", { memory: "LIVE-CHILD-DONE" }),
              { name: "write", arguments: { i: "Completing real interrupted Close batch", path: "live-batch.txt", content: "batch complete\n" } },
            ]);
          }).catch((error) => rpc?.fail(error));
          return;
        }
        if (current === 4) {
          const occurrences = JSON.stringify(frame.input).split(marker).length - 1;
          assert.ok(accepted ? occurrences <= 1 : occurrences === 1,
            "accepted input may be server-owned; rejected input must return exactly once in the next request");
          return reply.finish({ name: "write", arguments: { i: "Consuming actual live user input", path: "live-user.txt", content: `${marker}\n` } });
        }
        if (current === 5) return reply.finish("LIVE-USER-CONSUMED");
        if (current === 6) return reply.finish(spineCall("spine_close", { memory: "LIVE-PARENT-DONE" }));
        if (current === 7) return reply.finish("LIVE-RESTART-DONE");
        assert.fail(`Unexpected WebSocket provider request ${current}`);
      } catch (error) {
        fixture.error ??= error;
        rpc?.fail(error);
      }
    }));
    try {
      rpc = await fixture.start();
      const prompt = rpc.prompt("Open a parent and child, then close child.");
      prompt.catch(() => {});
      await Promise.race([
        entered.promise,
        prompt.then((result) => assert.fail(`Did not reach streaming Close: ${JSON.stringify(result)}`)),
      ]);
      await rpc.event((frame) => frame.type === "message_update"
        && frame.assistantMessageEvent?.type === "thinking_delta"
        && frame.assistantMessageEvent.delta === "LIVE-REASONING-3", "actual streaming reply before steering");
      await rpc.command("steer", { message: marker });
      assert.equal((await prompt).status, "completed");
      assert.equal(frames.filter((frame) => frame.type === "response.steer").length, 1, "actual provider receives one live steer");
      assert.equal(await readFile(join(fixture.workspace, "live-batch.txt"), "utf8"), "batch complete\n");
      assert.equal(await readFile(join(fixture.workspace, "live-user.txt"), "utf8"), `${marker}\n`);
      const state = await rpc.command("get_state");
      const rows = await readJournal(state.sessionFile);
      assert.deepEqual(rows.filter((row) => row.customType === "spine.fault.v1"), []);
      const source = rows.filter((row) => row.customType === "spine.source.v1").flatMap((row) => row.data.characters);
      assert.deepEqual(source.slice(0, 5).map((cell) => [cell.boundary, cell.role]),
        [[0, "user"], [1, "assistant"], [2, "assistant"], [3, "assistant"], [4, "user"]]);
      assert.equal(source[4].content, marker);
      await rpc.close();
      rpc = await fixture.restart(state.sessionFile);
      assert.equal((await rpc.prompt("Close parent after a physical restart.")).status, "completed");
      const recovered = await rpc.command("get_state");
      const after = await readJournal(recovered.sessionFile);
      assert.deepEqual(after.filter((row) => row.customType === "spine.fault.v1"), []);
      assert.equal(after.filter((row) => row.customType === "spine.archive.v1" && row.data.record.type === "sampling_commit")
        .flatMap((row) => row.data.record.record.executions).filter((execution) => execution.operation.type === "close").length, 2);
      await rpc.close();
    } finally {
      release.resolve();
      if (rpc && rpc.child.exitCode === null && rpc.child.signalCode === null) await rpc.terminate();
    }
  });
}

function startQueuedWire(api, io) {
  const raw = io.response;
  const index = io.index;
  raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  raw.flushHeaders();
  const emit = (event) => raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  if (api === "openai-responses" || api === "openai-codex-responses") {
    const reply = response({ send: (bytes) => raw.write(`data: ${bytes}\n\n`) }, index);
    return (action) => { reply.finish(action); raw.end(); };
  }
  if (api === "openai-completions") {
    const base = { id: `mock-queued-${index}`, object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000), model: MOCK_MODEL_ID };
    const chunk = (delta, finish_reason = null, usage) => raw.write(`data: ${JSON.stringify({
      ...base, choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}),
    })}\n\n`);
    chunk({ role: "assistant", reasoning_content: `LIVE-REASONING-${index}` });
    return (action) => {
      const calls = typeof action === "string" ? [] : Array.isArray(action) ? action : [action];
      chunk(calls.length ? { tool_calls: calls.map((call, ordinal) => ({
        index: ordinal, id: `mock-call-${index}-${ordinal}`, type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      })) } : { content: action });
      chunk({}, calls.length ? "tool_calls" : "stop",
        { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 });
      raw.end("data: [DONE]\n\n");
    };
  }
  assert.equal(api, "anthropic-messages");
  emit({ type: "message_start", message: { id: `mock-message-${index}`, type: "message",
    role: "assistant", model: MOCK_MODEL_ID, content: [], stop_reason: null,
    stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } });
  emit({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } });
  emit({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: `LIVE-REASONING-${index}` } });
  emit({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "mock-local-signature" } });
  emit({ type: "content_block_stop", index: 0 });
  return (action) => {
    const calls = typeof action === "string" ? [] : Array.isArray(action) ? action : [action];
    for (const [offset, part] of (calls.length ? calls : [action]).entries()) {
      const ordinal = offset + 1;
      const text = typeof part === "string";
      emit({ type: "content_block_start", index: ordinal, content_block: text
        ? { type: "text", text: "" }
        : { type: "tool_use", id: `mock-tool-${index}-${offset}`, name: part.name, input: {} } });
      emit({ type: "content_block_delta", index: ordinal, delta: text
        ? { type: "text_delta", text: part }
        : { type: "input_json_delta", partial_json: JSON.stringify(part.arguments) } });
      emit({ type: "content_block_stop", index: ordinal });
    }
    emit({ type: "message_delta", delta: { stop_reason: calls.length ? "tool_use" : "end_turn",
      stop_sequence: null }, usage: { output_tokens: 20 } });
    emit({ type: "message_stop" });
    raw.end();
  };
}

for (const api of ["openai-completions", "openai-responses", "anthropic-messages", "openai-codex-responses"]) {
  test(`native ${api} SSE streaming queues user input after Close without Source mismatch, including restart`, { timeout: 120_000 }, async (t) => {
    const marker = "QUEUED-STREAMING-NEW-USER";
    const entered = deferred();
    const release = deferred();
    const entry = process.env.OMP_STEERING_ENTRY;
    const fixture = await createNativeFixture(t, {
      label: `queued-streaming-${api}`, api,
      bridge: entry ? pathToFileURL(entry) : undefined,
      model: { reasoning: true, preferWebsockets: false,
        compat: { statefulResponses: false, supportsSteering: true } },
      async onRequest(request, io) {
        assert.equal(request.model, MOCK_MODEL_ID);
        assert.equal(request.stream, true);
        const finish = startQueuedWire(api, io);
        switch (io.index) {
          case 1: return finish(spineCall("spine_open", { goal: "QUEUED-PARENT" }));
          case 2: return finish(spineCall("spine_open", { goal: "QUEUED-CHILD" }));
          case 3:
            entered.resolve();
            await release.promise;
            return finish([
              spineCall("spine_close", { memory: "QUEUED-CHILD-DONE" }),
              { name: "write", arguments: { i: "Completing real streamed Close batch",
                path: "queued-batch.txt", content: "batch complete\n" } },
            ]);
          case 4: {
            const input = JSON.stringify(request.messages ?? request.input);
            assert.equal(input.split(marker).length - 1, 1, "the queued user must reach the next request once");
            assert.ok(input.includes("QUEUED-CHILD-DONE"), "the completed Close memory must reach the next request");
            return finish({ name: "write", arguments: { i: "Consuming actual queued input",
              path: "queued-user.txt", content: `${marker}\n` } });
          }
          case 5: return finish("QUEUED-USER-CONSUMED");
          case 6: return finish(spineCall("spine_close", { memory: "QUEUED-PARENT-DONE" }));
          case 7: return finish("QUEUED-RESTART-DONE");
          default: assert.fail(`Unexpected ${api} SSE request ${io.index}`);
        }
      },
    });
    let rpc;
    try {
      rpc = await fixture.start();
      const prompt = rpc.prompt("Open a parent and child, then close child.");
      prompt.catch(() => {});
      await Promise.race([
        entered.promise,
        prompt.then((result) => assert.fail(`Did not reach streaming Close: ${JSON.stringify(result)}`)),
      ]);
      await rpc.event((frame) => frame.type === "message_update"
        && frame.assistantMessageEvent?.type === "thinking_delta"
        && frame.assistantMessageEvent.delta === "LIVE-REASONING-3", "real SSE streaming before user input");
      await rpc.command("steer", { message: marker });
      release.resolve();
      assert.equal((await prompt).status, "completed");
      assert.equal(await readFile(join(fixture.workspace, "queued-batch.txt"), "utf8"), "batch complete\n");
      assert.equal(await readFile(join(fixture.workspace, "queued-user.txt"), "utf8"), `${marker}\n`);
      const state = await rpc.command("get_state");
      const rows = await readJournal(state.sessionFile);
      assert.deepEqual(rows.filter((row) => row.customType === "spine.fault.v1"), []);
      const source = rows.filter((row) => row.customType === "spine.source.v1").flatMap((row) => row.data.characters);
      assert.deepEqual(source.slice(0, 5).map((cell) => [cell.boundary, cell.role]),
        [[0, "user"], [1, "assistant"], [2, "assistant"], [3, "assistant"], [4, "user"]]);
      assert.equal(source[4].content, marker);
      const userMessages = rows.filter((row) => row.type === "message" && row.message.role === "user");
      assert.equal(userMessages.filter((row) => row.message.content.some((part) => part.text === marker)).length, 1);
      await rpc.close();
      rpc = await fixture.restart(state.sessionFile);
      assert.equal((await rpc.prompt("Close parent after a physical restart.")).status, "completed");
      const recovered = await rpc.command("get_state");
      const after = await readJournal(recovered.sessionFile);
      assert.deepEqual(after.filter((row) => row.customType === "spine.fault.v1"), []);
      const closed = after.filter((row) => row.customType === "spine.archive.v1" && row.data.record.type === "sampling_commit")
        .flatMap((row) => row.data.record.record.executions).filter((execution) => execution.operation.type === "close");
      assert.equal(closed.length, 2);
      await rpc.close();
    } finally {
      release.resolve();
      if (rpc && rpc.child.exitCode === null && rpc.child.signalCode === null) await rpc.terminate();
    }
  });
}
