import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MOCK_API_KEY, MOCK_MODEL, MOCK_MODEL_ID, MOCK_PROVIDER } from "../mock-model.mjs";

const timeoutMs = Number(process.env.OMP_NATIVE_TIMEOUT_MS ?? 90_000);
const builtEntry = fileURLToPath(new URL("../../dist/omp/extension.js", import.meta.url));
const hostPrefix = JSON.parse(process.env.OMP_BIN_ARGS ?? "[]");
assert.ok(Array.isArray(hostPrefix) && hostPrefix.every((arg) => typeof arg === "string"), "OMP_BIN_ARGS must be a JSON string array");

export function spineCall(name, args) {
  return { name: "write", arguments: { i: `Exercising ${name}`, path: `xd://${name}`, content: JSON.stringify(args) } };
}

export function visibleText(messages) {
  if (!Array.isArray(messages)) messages = [messages];
  return messages.map((message) => typeof message?.content === "string" ? message.content :
    (message?.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n")).join("\n");
}

export async function readJournal(path) {
  return (await readFile(path, "utf8")).split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
}

function sendResponse(res, request, action, index, options = {}) {
  const calls = Array.isArray(action) ? action : typeof action === "string" ? [] : [action];
  const id = `native-path-${index}`;
  const delta = calls.length ? {
    role: "assistant", content: null,
    tool_calls: calls.map((call, ordinal) => ({ index: ordinal, id: `${id}-${ordinal}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } })),
  } : { role: "assistant", content: action };
  if (options.reasoningText !== undefined) delta.reasoning_content = options.reasoningText;
  const finish = options.finishReason ?? (calls.length ? "tool_calls" : "stop");
  const input = options.inputTokens ?? 100;
  const output = options.outputTokens ?? 20;
  const usage = { prompt_tokens: input, completion_tokens: output, total_tokens: input + output };
  const base = { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: request.model };
  if (request.stream) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    if (options.streamError !== undefined) {
      res.end(`data: ${JSON.stringify({ error: options.streamError })}\n\n`);
      return;
    }
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage })}\n\n`);
    res.end("data: [DONE]\n\n");
  } else {
    res.writeHead(200, { "content-type": "application/json" });
    const { tool_calls, ...message } = delta;
    res.end(JSON.stringify({ ...base, object: "chat.completion", choices: [{ index: 0, message: { ...message, ...(tool_calls ? { tool_calls: tool_calls.map(({ index: unused, ...call }) => call) } : {}) }, finish_reason: finish }], usage }));
  }
}

class Rpc {
  constructor(fixture, args, env) {
    this.fixture = fixture;
    this.frames = [];
    this.pending = new Set();
    this.serial = 0;
    this.stdout = "";
    this.stderr = "";
    this.buffer = "";
    this.closing = false;
    this.child = spawn(fixture.invocation.binary, [...hostPrefix, ...args], { cwd: fixture.workspace, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stderr.setEncoding("utf8").on("data", (chunk) => { this.stderr += chunk; });
    this.child.stdout.setEncoding("utf8").on("data", (chunk) => {
      this.stdout += chunk;
      this.buffer += chunk;
      let end;
      while ((end = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, end).trim();
        this.buffer = this.buffer.slice(end + 1);
        if (!line) continue;
        try {
          const frame = JSON.parse(line);
          this.frames.push(frame);
          if (frame.type === "extension_ui_request" && ["select", "input", "confirm", "ask"].includes(frame.method)) {
            this.child.stdin.write(JSON.stringify({ type: "extension_ui_response", id: frame.id, cancelled: true }) + "\n");
            throw new Error(`Unexpected native recovery dialog: ${JSON.stringify(frame)}`);
          }
          for (const waiter of this.pending) {
            if (!waiter.predicate(frame)) continue;
            this.pending.delete(waiter);
            clearTimeout(waiter.timer);
            waiter.resolve(frame);
          }
        } catch (error) { this.fail(error); }
      }
    });
    this.exited = new Promise((resolveExit, reject) => {
      this.child.once("error", (error) => { this.fail(error); reject(error); });
      this.child.once("close", (code, signal) => {
        if (!this.closing || this.pending.size) this.fail(new Error(`Native RPC closed ${code}/${signal}\n${this.stderr}`));
        resolveExit({ code, signal });
      });
    });
    this.exited.catch(() => {});
    this.child.stdin.on("error", (error) => this.fail(error));
  }

  fail(error) {
    this.error ??= error;
    for (const waiter of this.pending) { clearTimeout(waiter.timer); waiter.reject(this.error); }
    this.pending.clear();
  }

  event(predicate, label = "native event") {
    if (this.error) return Promise.reject(this.error);
    const existing = this.frames.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolveFrame, reject) => {
      const waiter = { predicate, resolve: resolveFrame, reject };
      waiter.timer = setTimeout(() => {
        this.pending.delete(waiter);
        reject(new Error(`Waiting for ${label} timed out\n${this.stderr}\n${JSON.stringify(this.frames.slice(-8))}`));
      }, timeoutMs);
      this.pending.add(waiter);
    });
  }

  send(frame) { this.child.stdin.write(JSON.stringify(frame) + "\n"); }

  async command(type, fields = {}) {
    const id = `native-${++this.serial}`;
    const response = this.event((frame) => frame.type === "response" && frame.id === id, type);
    this.send({ id, type, ...fields });
    const frame = await response;
    assert.equal(frame.success, true, JSON.stringify(frame));
    return frame.data;
  }

  async prompt(message, fields = {}) {
    const id = `native-${++this.serial}`;
    const response = this.event((frame) => frame.type === "response" && frame.id === id, "prompt acceptance");
    const completed = this.event((frame) => frame.type === "prompt_result" && frame.id === id, "prompt result");
    completed.catch(() => {});
    this.send({ ...fields, id, type: "prompt", message });
    assert.equal((await response).success, true);
    const result = await completed;
    if (this.fixture.error) throw this.fixture.error;
    return result;
  }

  async terminate(signal = "SIGKILL") {
    this.closing = true;
    this.fail(new Error(`Native RPC intentionally terminated with ${signal}`));
    try { process.kill(-this.child.pid, signal); } catch { this.child.kill(signal); }
    const result = await this.exited;
    assert.equal(result.signal, signal, this.stderr);
    return result;
  }

  async close() {
    this.closing = true;
    this.child.stdin.end();
    const { code, signal } = await this.exited;
    assert.equal(code, 0, this.stderr);
    assert.equal(signal, null);
    assert.equal(this.buffer.trim(), "", "Truncated native RPC frame");
  }
}

export async function createNativeFixture(t, { label, bridge, settings = {}, model = {}, api = "openai-completions", rootParent, rules, onRequest }) {
  const binary = process.env.OMP_BIN;
  assert.ok(binary && isAbsolute(binary),
    "Native mock tests require an absolute OMP_BIN for a dedicated test build; the user's PATH-installed OMP is never selected");
  const evidenceDir = process.env.OMP_NATIVE_EVIDENCE_DIR;
  if (evidenceDir) await mkdir(evidenceDir, { recursive: true });
  const root = await mkdtemp(join(rootParent ?? evidenceDir ?? tmpdir(), `omp-native-${label}-`));
  const profile = join(root, "profile");
  const workspace = join(root, "workspace");
  const home = join(root, "home");
  await Promise.all([profile, workspace, home].map((dir) => mkdir(dir, { recursive: true })));
  const fixture = { root, profile, workspace, requests: [], rpcs: [], envOverrides: {}, model: MOCK_MODEL };
  const route = {
    "openai-completions": "/v1/chat/completions",
    "openai-responses": "/v1/responses",
    "openai-codex-responses": "/v1/codex/responses",
    "anthropic-messages": "/v1/messages",
  }[api];
  assert.ok(route, `Unsupported local fixture API: ${api}`);
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.method, "POST");
      const path = new URL(req.url, "http://fixture").pathname;
      assert.equal(path, route);
      let body = "";
      for await (const part of req) body += part;
      const request = JSON.parse(body);
      fixture.requests.push(request);
      const index = fixture.requests.length;
      await onRequest(request, {
        index, requests: fixture.requests, path, response: res, incoming: req,
        disconnect: () => res.destroy(),
        send: (action, options) => sendResponse(res, request, action, index, options),
        fail: (status, error, headers = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(error)); },
      });
    } catch (error) {
      fixture.error ??= error;
      for (const rpc of fixture.rpcs) rpc.fail(error);
      fixture.onError?.(error);
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Native test assertion failed", type: "fixture_assertion" } }));
    }
  });
  t.after(async () => {
    for (const rpc of fixture.rpcs) {
      if (rpc.child.exitCode === null && rpc.child.signalCode === null) {
        try { process.kill(-rpc.child.pid, "SIGTERM"); } catch { rpc.child.kill("SIGTERM"); }
      }
      await rpc.exited.catch(() => {});
    }
    server.closeAllConnections();
    await new Promise((resolveClose) => server.close(resolveClose));
    if (evidenceDir) {
      await writeFile(join(root, "requests.json"), JSON.stringify(fixture.requests, null, 2) + "\n");
      for (const [index, rpc] of fixture.rpcs.entries()) {
        await writeFile(join(root, `rpc-${index}.jsonl`), rpc.stdout);
        await writeFile(join(root, `rpc-${index}.stderr.log`), rpc.stderr);
      }
      console.log(`Native evidence: ${root}`);
    } else {
      await rm(root, { recursive: true, force: true });
    }
  });
  await new Promise((resolveListen, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolveListen); });
  fixture.endpoint = `http://127.0.0.1:${server.address().port}/v1`;
  await writeFile(join(profile, "models.yml"), JSON.stringify({ providers: { [MOCK_PROVIDER]: {
    baseUrl: fixture.endpoint, apiKey: MOCK_API_KEY, api,
    models: [{ reasoning: false, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 4096, ...model, id: MOCK_MODEL_ID, name: MOCK_MODEL_ID }],
  } } }));
  await writeFile(join(profile, "config.yml"), JSON.stringify({
    ...settings,
    compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 1, methodOrder: ["soft"], ...settings.compaction },
    retry: { enabled: false, ...settings.retry },
  }));
  if (rules !== undefined) {
    const directory = join(profile, "rules");
    await mkdir(directory, { recursive: true });
    await Promise.all(Object.entries(rules).map(async ([name, content]) => {
      const path = join(directory, name);
      await writeFile(path, content);
    }));
  }
  fixture.environment = {
    PATH: process.env.PATH, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"),
    PI_CODING_AGENT_DIR: profile, OMP_CODING_AGENT_DIR: profile, TERM: "dumb", NO_COLOR: "1",
  };
  fixture.invocation = {
    binary,
    prefix: hostPrefix,
    args: ["--thinking", "off", "--auto-approve", "--no-title", "--no-skills", ...(rules === undefined ? ["--no-rules"] : []), "--no-extensions", ...(bridge === false ? [] : ["--extension", bridge ? fileURLToPath(bridge) : builtEntry]), "--model", fixture.model, "--session-dir", join(root, "sessions")],
  };
  fixture.start = async ({ resume, autoRetry = false, autoCompaction = false, env = {}, args = [] } = {}) => {
    Object.assign(fixture.envOverrides, env);
    const rpc = new Rpc(fixture, ["--mode", "rpc", ...fixture.invocation.args, ...(resume ? ["--resume", resume] : []), ...args], {
      ...fixture.environment, ...env,
    });
    fixture.rpcs.push(rpc);
    if (autoCompaction !== null) await rpc.command("set_auto_compaction", { enabled: autoCompaction });
    await rpc.command("set_auto_retry", { enabled: autoRetry });
    await rpc.command("set_cache_warming", { mode: "off" });
    return rpc;
  };
  fixture.restart = (sessionPath, options = {}) => fixture.start({ ...options, resume: sessionPath });
  return fixture;
}
