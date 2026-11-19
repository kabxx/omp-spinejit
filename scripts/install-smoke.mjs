import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { MOCK_API_KEY, MOCK_MODEL, MOCK_MODEL_ID, MOCK_PROVIDER } from "../test/mock-model.mjs";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const omp = process.env.OMP_BIN;
const ompPrefix = JSON.parse(process.env.OMP_BIN_ARGS ?? "[]");
const timeout = Number(process.env.OMP_SMOKE_TIMEOUT_MS ?? 120_000);
assert.ok(omp && isAbsolute(omp), "Set OMP_BIN to an absolute path to official OMP 19.0.0 (or its Bun launcher)");
assert.ok(Array.isArray(ompPrefix) && ompPrefix.every((arg) => typeof arg === "string"), "OMP_BIN_ARGS must be a JSON string array");
assert.ok(Number.isFinite(timeout) && timeout > 0, "OMP_SMOKE_TIMEOUT_MS must be positive");

const goal = "OMP-INSTALL-RECOVERED-OWNER";
const memory = "OMP-INSTALL-COMMITTED-MEMORY";
const prompts = ["Open a branch to organize this task and leave it open for the next prompt.",
  "Finish the task in the branch carried over from my previous prompt."];
const answers = ["Initial work is ready to resume.", "The resumed task is complete."];
const children = new Set();
const runs = [];
const requests = [];
let root;
let cwd;
let env;
let server;
let serverError;
let turn;

async function json(path) { return JSON.parse(await readFile(path, "utf8")); }
async function save(name, value) { await writeFile(join(root, name), JSON.stringify(value, null, 2) + "\n"); }
function assertInside(parent, path) {
  const suffix = relative(parent, path);
  assert.ok(suffix && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix), `${path} is not inside ${parent}`);
}
function kill(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
}
function start(command, args, workingDir, stdin) {
  const child = spawn(command, args, { cwd: workingDir, env, detached: true, stdio: [stdin, "pipe", "pipe"] });
  children.add(child);
  const log = { command, args, stdout: "", stderr: "" };
  runs.push(log);
  child.stdout.setEncoding("utf8").on("data", (text) => { log.stdout += text; });
  child.stderr.setEncoding("utf8").on("data", (text) => { log.stderr += text; });
  const exited = new Promise((done, reject) => {
    const timer = setTimeout(() => {
      kill(child);
      reject(new Error(`${command} ${args.join(" ")} timed out\n${log.stderr}`));
    }, timeout);
    child.once("error", (error) => { clearTimeout(timer); children.delete(child); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      children.delete(child);
      Object.assign(log, { code, signal });
      if (code === 0 && signal === null) done(log);
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}/${signal}\n${log.stdout}\n${log.stderr}`));
    });
  });
  return { child, exited, log };
}

async function runOmp(...args) { return start(omp, [...ompPrefix, ...args], cwd, "ignore").exited; }

function visibleText(messages) {
  return messages.map(({ content }) => typeof content === "string" ? content :
    (content ?? []).filter(({ type }) => type === "text").map(({ text }) => text).join("\n")).join("\n");
}
function spineCall(name, args) {
  return { name: "write", arguments: { i: `Executing ${name}`, path: `xd://${name}`, content: JSON.stringify(args) } };
}
async function serveModel(req, res) {
  assert.equal(req.method, "POST");
  assert.equal(req.url, "/v1/chat/completions");
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  requests.push(request);
  assert.equal(request.model, MOCK_MODEL_ID);
  assert.equal(request.stream, true);
  const users = visibleText(request.messages.filter(({ role }) => role === "user"));
  const step = turn.step++;
  let action;
  if (step === 0) {
    assert.ok(users.includes(prompts[turn.index]), "Native user prompt did not reach the model");
    assert.match(visibleText(request.messages.filter(({ role }) => role === "system")), /<spine_instruction>/);
    assert.ok(request.tools.some(({ function: tool }) => tool?.name === "write"), "Native write tool is unavailable");
    if (turn.index === 0) action = spineCall("spine_open", { goal });
    else {
      assert.match(visibleText(request.messages), new RegExp(`<spine_node id="1\\.1"[^>]*summary="${goal}"[^>]*status="(?:opened|live)"`),
        "Restart did not recover the open branch in the model-visible projection");
      action = spineCall("spine_close", { memory });
    }
  } else {
    assert.equal(step, 1, "Unexpected extra model request");
    action = answers[turn.index];
  }
  const id = `install-smoke-${requests.length}`;
  const isTool = typeof action !== "string";
  const delta = isTool ? { role: "assistant", tool_calls: [{ index: 0, id: `${id}-call`, type: "function",
    function: { name: action.name, arguments: JSON.stringify(action.arguments) } }] } : { role: "assistant", content: action };
  const base = { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: MOCK_MODEL_ID };
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: isTool ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`);
  res.end("data: [DONE]\n\n");
}

async function prompt(index, sessions, resume) {
  turn = { index, step: 0 };
  const args = ["--mode", "rpc", "--model", MOCK_MODEL, "--thinking", "off", "--auto-approve", "--no-title",
    "--no-skills", "--no-rules", "--session-dir", sessions, ...(resume ? ["--resume", resume] : [])];
  // No --extension: only the installed package manifest can load Spine.
  const { child, exited, log } = start(omp, [...ompPrefix, ...args], cwd, "pipe");
  const waiters = new Map();
  let closing = false;
  let buffer = "";
  let failure;
  function fail(error) {
    failure ??= error;
    for (const { reject } of waiters.values()) reject(failure);
    waiters.clear();
  }
  child.stdin.on("error", fail);
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      try {
        const frame = JSON.parse(line);
        if (frame.type === "extension_ui_request" && ["select", "input", "confirm", "ask"].includes(frame.method)) {
          throw new Error(`Unexpected interactive dialog: ${line}`);
        }
        const key = `${frame.type}:${frame.id}`;
        waiters.get(key)?.done(frame);
        waiters.delete(key);
      } catch (error) { fail(error); }
    }
  });
  exited.then(() => { if (!closing || waiters.size) fail(new Error(`OMP exited before replying\n${log.stderr}`)); }, fail);
  function wait(type, id) {
    if (failure) return Promise.reject(failure);
    return new Promise((done, reject) => waiters.set(`${type}:${id}`, { done, reject }));
  }
  let serial = 0;
  async function command(type, fields = {}, terminal) {
    const id = `install-${++serial}`;
    const response = wait("response", id);
    const result = terminal ? wait(terminal, id) : undefined;
    child.stdin.write(JSON.stringify({ type, id, ...fields }) + "\n");
    const [accepted, settled] = await Promise.all([response, result]);
    if (serverError) throw serverError;
    assert.equal(accepted.success, true, JSON.stringify(accepted));
    return settled ?? accepted.data;
  }
  await command("set_auto_compaction", { enabled: false });
  await command("set_auto_retry", { enabled: false });
  await command("set_cache_warming", { mode: "off" });
  const result = await command("prompt", { message: prompts[index] }, "prompt_result");
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.equal(result.agentInvoked, true);
  assert.equal(turn.step, 2);
  const state = await command("get_state");
  closing = true;
  child.stdin.end();
  await exited;
  if (failure) throw failure;
  if (serverError) throw serverError;
  assert.equal(buffer.trim(), "", "Truncated RPC frame");
  assert.ok(state.sessionId, "Native session ID not returned");
  assertInside(sessions, state.sessionFile);
  return state;
}

async function journal(path, count) {
  const rows = (await readFile(path, "utf8")).split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
  assert.equal(rows.some(({ customType }) => customType === "spine.fault.v1"), false, "Spine journal contains a fault");
  const commits = rows.filter(({ customType, data }) => customType === "spine.archive.v1" && data.record.type === "sampling_commit")
    .map(({ data }) => {
      assert.equal(data.schema, "spine-plugin/omp/v3");
      const record = data.record.record;
      assert.equal(record.schema, "spine.sampling.commit");
      assert.ok(record.commit_id.value);
      assert.equal(data.durabilityId, record.commit_id.value);
      return record;
    });
  assert.equal(new Set(commits.map(({ commit_id }) => JSON.stringify(commit_id))).size, commits.length, "Duplicate sampling commit");
  const nativeMessages = rows.filter(({ type }) => type === "message").map(({ message }) => message);
  assert.deepEqual(nativeMessages.filter(({ role }) => role === "user").map((message) => visibleText([message])), prompts.slice(0, count));
  assert.deepEqual(nativeMessages.filter(({ role, stopReason }) => role === "assistant" && stopReason === "stop")
    .map((message) => visibleText([message])), answers.slice(0, count));
  const executions = commits.flatMap(({ executions }) => executions);
  const controls = ["open", "close"].slice(0, count);
  assert.deepEqual(executions.map(({ operation }) => operation.type), controls);
  for (const [index, execution] of executions.entries()) {
    const tool = `spine_${controls[index]}`;
    const receipt = nativeMessages.find((message) => message.role === "toolResult" && message.toolCallId === execution.origin.execution_ref);
    assert.equal(execution.origin.type, "direct");
    assert.equal(receipt?.details?.xdev?.tool, tool, "Durable operation does not match a native tool receipt");
    assert.equal(receipt.details.xdev.mode, "execute");
    assert.notEqual(receipt.isError, true);
  }
  if (count === 2) assert.equal(executions[1].operation.memory, memory);
  return commits.map(({ commit_id }) => commit_id);
}

async function main() {
  const base = resolve(process.env.OMP_SMOKE_DIR ?? tmpdir());
  await mkdir(base, { recursive: true });
  root = await realpath(await mkdtemp(join(base, "omp-install-")));
  cwd = join(root, "work");
  const home = join(root, "home");
  const profile = join(root, "profile");
  const packs = join(root, "packs");
  const sessions = join(root, "sessions");
  const temp = join(root, "tmp");
  for (const path of [cwd, home, profile, packs, sessions, temp]) await mkdir(path);
  env = {
    PATH: process.env.PATH,
    HOME: home, USERPROFILE: home, APPDATA: join(home, "appdata"), LOCALAPPDATA: join(home, "localappdata"),
    XDG_CONFIG_HOME: join(home, "config"), XDG_CACHE_HOME: join(home, "cache"),
    XDG_DATA_HOME: join(home, "data"), XDG_STATE_HOME: join(home, "state"),
    PI_CODING_AGENT_DIR: profile, OMP_CODING_AGENT_DIR: profile,
    TMPDIR: temp, TMP: temp, TEMP: temp,
    NPM_CONFIG_USERCONFIG: join(root, ".npmrc"), NPM_CONFIG_GLOBALCONFIG: join(root, "global.npmrc"),
    NPM_CONFIG_CACHE: join(root, "npm-cache"), BUN_INSTALL_CACHE_DIR: join(root, "bun-cache"), NO_COLOR: "1", TERM: "dumb",
  };
  await writeFile(env.NPM_CONFIG_GLOBALCONFIG, "");
  await writeFile(env.NPM_CONFIG_USERCONFIG, "registry=https://registry.npmjs.org/\n");

  const hostVersion = (await runOmp("--version")).stdout.trim();
  assert.match(hostVersion, /^(?:omp[ /])?19\.0\.0$/i, "This smoke targets official OMP 19.0.0");
  const expected = await json(join(packageRoot, "package.json"));
  let spec = process.env.OMP_SMOKE_INSTALL_SPEC;
  let packed;
  if (!spec) {
    const { stdout } = await start("npm", ["pack", "--json", "--pack-destination", packs], packageRoot, "ignore").exited;
    const [pack, ...extra] = JSON.parse(stdout);
    assert.equal(extra.length, 0);
    assert.equal(pack.name, expected.name);
    const files = pack.files.map(({ path }) => path);
    const releaseInputs = ["LICENSE", "README.md", "README.zh-CN.md", "doc/HOST.md", "package.json", "spine.toml"];
    assert.ok(files.includes("dist/omp/extension.js"), "Missing packed adapter entry");
    assert.deepEqual(files.filter((path) => !path.startsWith("dist/")).sort(), releaseInputs,
      "Only release inputs and dist ship; no upstream checkout or test harness");
    const tarball = join(packs, pack.filename);
    packed = { tarball, integrity: pack.integrity };
    spec = `${pack.name}@file:${tarball.split(sep).join("/")}`;
  }
  await runOmp("install", spec);
  const listed = JSON.parse((await runOmp("plugin", "list", "--json")).stdout);
  assert.equal(listed.npm.length, 1, "Only the adapter should be registered in the isolated profile");
  const [plugin] = listed.npm;
  assert.equal(plugin.name, expected.name);
  assert.equal(plugin.version, expected.version);
  assert.equal(plugin.enabled, true);
  assertInside(root, await realpath(plugin.path));
  const manifest = await json(join(plugin.path, "package.json"));
  assert.deepEqual(manifest.dependencies, { "@spinejit/spine-sdk": "0.1.4" });
  assert.deepEqual(manifest.peerDependencies ?? {}, {});
  assert.deepEqual(manifest.omp.extensions, ["./dist/omp/extension.js"]);
  const installedEntry = await realpath(join(plugin.path, manifest.omp.extensions[0]));
  assertInside(root, installedEntry);
  const installedBytes = await readFile(installedEntry);
  assert.deepEqual(installedBytes, await readFile(join(packageRoot, manifest.omp.extensions[0])));

  server = createServer((req, res) => {
    serveModel(req, res).catch((error) => {
      serverError ??= error;
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: error.message } }));
    });
  });
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  await writeFile(join(profile, "models.yml"), JSON.stringify({ providers: { [MOCK_PROVIDER]: {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: MOCK_API_KEY, api: "openai-completions",
    models: [{ id: MOCK_MODEL_ID, name: MOCK_MODEL_ID, reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 4096 }],
  } } }));
  await writeFile(join(profile, "config.yml"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } }));

  const first = await prompt(0, sessions);
  const before = await journal(first.sessionFile, 1);
  const second = await prompt(1, sessions, first.sessionFile);
  assert.equal(second.sessionId, first.sessionId, "Restart did not restore the same native session");
  assert.equal(second.sessionFile, first.sessionFile);
  const after = await journal(second.sessionFile, 2);
  assert.deepEqual(after.slice(0, before.length), before, "Restart changed the original durable commits");
  assert.equal(requests.length, 4);
  await save("evidence.json", {
    hostVersion, ...packed, spec, installedEntry,
    installedEntrySha256: createHash("sha256").update(installedBytes).digest("hex"),
    sessionFile: first.sessionFile, commitsBeforeRestart: before, commitsAfterRestart: after, restarts: 1,
  });
  console.log(`PASS ${plugin.name}@${plugin.version}: OMP ${hostVersion} installed ${spec}, discovered Spine, committed Open, and resumed to commit Close.`);
}

try {
  await main();
} catch (error) {
  process.exitCode = 1;
  console.error(`FAIL installed OMP smoke: ${error.stack ?? error}`);
  if (root) await save("failure.json", { error: error.stack ?? String(error), modelError: serverError?.stack });
} finally {
  for (const child of children) kill(child);
  if (server?.listening) {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
  if (root) {
    await save("cli-runs.json", runs);
    await save("model-requests.json", requests);
    console.log(`Evidence retained at ${root}`);
  }
}
