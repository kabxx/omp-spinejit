import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { archiveRecordId } from "@spinejit/spine-sdk/host";
import { readChildState } from "../dist/omp/child-memory.js";
import { runOmpChild } from "../dist/omp/child-process.js";
import { buildChildAssignment, childSessionPath, inspectChildSession, latestChildSession, writeChildPrefixSession } from "../dist/omp/child-session.js";
import { SPINE_ARRIVAL_CUSTOM_TYPE } from "../dist/omp/messages.js";
import { OMP_ADAPTER_ID, OMP_ARCHIVE_ENTRY_TYPE } from "../dist/omp/protocol.js";

const birth = { origin: "spawn/sample", producer: [1, 2] };
const task = { summary: "Inspect committed conversation", prompt: "Inspect only the evidence." };
const reply = (text, stopReason = "stop", extra = {}) => ({
  role: "assistant", stopReason, timestamp: 2, content: [{ type: "text", text }], ...extra,
});
const user = (content) => ({ role: "user", content, timestamp: 1 });
const message = (id, parentId, value) => ({ type: "message", id, parentId, timestamp: new Date().toISOString(), message: value });
const boundary = (ordinal) => ({ thread: "child-thread", epoch: 0, ordinal });

function commit(id, parentId, post, executions = [], terminal) {
  const record = { type: "sampling_commit", record: {
    schema: "spine.sampling.commit", epoch: 0,
    attempt_id: { thread: "child-thread", value: `attempt-${id}` },
    commit_id: { thread: "child-thread", value: `commit-${id}` },
    pre_boundary: boundary(Math.max(0, post - 1)), post_boundary: boundary(post),
    previous_pre_boundary: null, previous_commit_id: null, executions,
    ...(terminal === undefined ? {} : { terminal }),
  } };
  return { type: "custom", id, parentId, customType: OMP_ARCHIVE_ENTRY_TYPE,
    data: { schema: OMP_ADAPTER_ID, durabilityId: archiveRecordId(record), record } };
}

async function fixture(t, entries = []) {
  const cwd = await mkdtemp(join(tmpdir(), "omp-child-state-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const scope = { parentSessionId: "parent", parentSessionFile: join(cwd, "parent.jsonl") };
  const path = childSessionPath(scope, birth);
  const id = await writeChildPrefixSession({ cwd, destPath: path, entries, birth: birth.producer });
  const append = async (...rows) => appendFile(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  return { cwd, scope, path, id, append };
}

test("only a committed plain reply from the child's own active branch is terminal", async (t) => {
  const prefix = [message("prefix-reply", null, reply("Inherited memory is not a child return")), commit("prefix-commit", "prefix-reply", 0)];
  const { path, id, append } = await fixture(t, prefix);
  assert.equal((await readChildState(path)).terminal, null);
  await append(message("assignment", "prefix-commit", user("assignment")), message("reply", "assignment", reply("Committed memory")));
  assert.equal((await readChildState(path)).terminal, null, "uncommitted native assistant tail is not success");
  await append(commit("child-commit", "reply", 2));
  assert.deepEqual((await readChildState(path, id)).terminal, { outcome: "completed", memory: "Committed memory" });
  await append({ ...message("off-branch", "assignment", reply("Wrong branch")), activeLeafId: "child-commit" });
  assert.deepEqual((await readChildState(path)).terminal, { outcome: "completed", memory: "Committed memory" });
  await appendFile(path, '{"type":"message"');
  assert.equal((await readChildState(path)).terminal, null, "a torn record invalidates recovered success");
});

test("cut-off, failed commit, tool-bearing and blank replies cannot become memory", async (t) => {
  for (const [answer, terminal] of [
    [reply("cut off", "length")],
    [reply("explicit cancel", "aborted")],
    [reply("plausible text"), "cancelled"],
    [reply("with tool", "stop", { content: [{ type: "text", text: "with tool" }, { type: "toolCall", id: "call", name: "read", arguments: {} }] })],
    [reply(" \n ")],
  ]) {
    const { path, append } = await fixture(t);
    await append(message("u", null, user("assignment")), message("a", "u", answer), commit("c", "a", 1, [], terminal));
    assert.equal((await readChildState(path)).terminal, null);
  }
});

test("a pending own Spawn blocks success, and each distinct committed arrival joins once", async (t) => {
  const { path, append } = await fixture(t);
  const executions = [{ operation: { type: "spawn", tasks: [task, task] } }];
  const arrival = (id, parentId, producer) => ({ type: "custom", id, parentId, timestamp: new Date().toISOString(),
    customType: SPINE_ARRIVAL_CUSTOM_TYPE, data: { producer, outcome: "completed", memory: "grandchild memory" } });
  await append(message("u", null, user("assignment")), message("spawn", "u", reply("", "toolUse")), commit("sp", "spawn", 1, executions),
    message("premature", "sp", reply("Not ready")), commit("pc", "premature", 2));
  assert.equal((await readChildState(path)).open, 2);
  assert.equal((await readChildState(path)).terminal, null);
  await append(arrival("first", "pc", [1, 2, 1]), arrival("duplicate", "first", [1, 2, 1]),
    message("explain", "duplicate", reply("Still waiting")), commit("one", "explain", 5));
  assert.equal((await readChildState(path)).open, 1);
  assert.equal((await readChildState(path)).terminal, null);
  await append(arrival("second", "one", [1, 2, 2]), message("final", "second", reply("All clear")), commit("done", "final", 7));
  assert.deepEqual((await readChildState(path)).terminal, { outcome: "completed", memory: "All clear" });
});

test("the real provider error is retained even with a descendant pending", async (t) => {
  const { path, append } = await fixture(t);
  await append(message("a", null, reply("partial", "error", { errorMessage: "Provider refused this request" })));
  assert.deepEqual((await readChildState(path)).terminal, { outcome: "errored", diagnostic: "Provider refused this request" });
  await append(commit("b", "a", 0, [{ operation: { type: "spawn", tasks: [task] } }]),
    message("c", "b", reply("", "error", { errorMessage: "Provider failed again" })));
  const state = await readChildState(path);
  assert.equal(state.terminal, null);
  assert.equal(state.diagnostic, "Provider failed again");
});

test("attempt paths isolate native branches and Continue validates title-slot journals", async (t) => {
  const { cwd, scope, path, id, append } = await fixture(t);
  assert.notEqual(childSessionPath(scope, { ...birth, origin: "spawn_sample" }), path);
  assert.notEqual(childSessionPath({ ...scope, parentSessionFile: join(cwd, "other.jsonl") }, birth), path);
  assert.equal(await latestChildSession(scope, { ...birth, origin: "not-yet-born" }), null);
  const assignment = buildChildAssignment(task, [task]);
  await append(message("assignment", null, user(assignment)));
  await writeFile(path, `${JSON.stringify({ type: "title", title: "renamed" })}   \n${await readFile(path, "utf8")}`);
  assert.deepEqual(await inspectChildSession({ destPath: path, expectedId: id, birth: birth.producer, assignment }), { id, assignmentPresent: true });
  await assert.rejects(inspectChildSession({ destPath: path, expectedId: "wrong", birth: birth.producer, assignment }), /identity changed/);
  const retryPath = childSessionPath(scope, birth, 2);
  await writeChildPrefixSession({ cwd, destPath: retryPath, entries: [], birth: birth.producer });
  assert.deepEqual(await latestChildSession(scope, birth), { path: retryPath, attempt: 2 });
  await assert.rejects(writeChildPrefixSession({ cwd, destPath: path, entries: [], birth: birth.producer }), { code: "EEXIST" });
  await assert.rejects(writeChildPrefixSession({ cwd, destPath: childSessionPath(scope, birth, 3), birth: birth.producer, entries: [
    { type: "custom", id: "legacy", parentId: null, customType: "spine.spawn-terminal.v1" },
  ] }), /SDK v2/);
});

test("launcher preserves explicit config and one plugin; Continue reuses identity and Retry creates a new session", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "omp-child-process-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const runner = join(cwd, "runner.mjs");
  await writeFile(runner, `
import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
assert.equal(args.filter((arg) => arg === "--extension").length, 1);
assert.equal(args[args.indexOf("--extension") + 1], "single-plugin.mjs");
assert(args.includes("--no-extensions"));
assert(!args.includes("--tools"));
assert.equal(process.env.SPINE_OMP_CHILD_CONFIG_TOML, "explicit config");
assert.deepEqual(JSON.parse(process.env.SPINE_OMP_CHILD_BIRTH), [1, 2]);
assert.equal(Number(process.env.SPINE_OMP_CHILD_PARENT_PID), process.ppid);
const path = args[args.indexOf("--resume") + 1];
const prompt = args.at(-1);
if (prompt.includes("Continue the same active branch")) assert(prompt.includes("User guidance:"));
if (path.includes(".attempt-1.")) assert(prompt.includes("Retry guidance:"));
const records = readFileSync(path, "utf8").trim().split("\\n").map(JSON.parse);
const latest = records.at(-1);
const entry = { type: "message", id: "a" + records.length, parentId: latest.type === "session" ? null : latest.id,
  message: { role: "assistant", stopReason: "error", errorMessage: "durable provider error", content: [], timestamp: Date.now() } };
appendFileSync(path, JSON.stringify(entry) + "\\n");
console.log(JSON.stringify({ type: "message_end", message: { stopReason: "error", errorMessage: "different stdout error" } }));
`);
  const seen = [];
  const options = {
    cwd, origin: birth.origin, peers: [task], prefixEntries: [], parentSessionId: "parent", parentSessionFile: join(cwd, "parent.jsonl"),
    extensionPath: "single-plugin.mjs", configToml: "explicit config",
    childInvocation(context) { seen.push(context); return { command: process.execPath, args: [runner] }; },
  };
  const context = { producer: birth.producer, signal: new AbortController().signal, attempt: 0 };
  const [initial, continued, retry] = [
    await runOmpChild(task, { ...context, mode: "initial" }, options),
    await runOmpChild(task, { ...context, mode: "continue", guidance: "continue once" }, options),
    await runOmpChild(task, { ...context, mode: "retry", attempt: 1, guidance: "new attempt" }, options),
  ];
  for (const result of [initial, continued, retry]) {
    assert.equal(result.outcome, "errored");
    assert.equal(result.diagnostic, "durable provider error");
    assert.equal(result.recovery.continueable, true);
  }
  assert.equal(seen[0].sessionPath, seen[1].sessionPath);
  assert.equal(seen[0].sessionId, seen[1].sessionId);
  assert.notEqual(seen[0].sessionPath, seen[2].sessionPath);
  assert.notEqual(seen[0].sessionId, seen[2].sessionId);
  const { prefixEntries: _unavailable, ...withoutPrefix } = options;
  const unavailable = await runOmpChild(task, { ...context, mode: "retry", attempt: 2 }, withoutPrefix);
  assert.equal(unavailable.recovery.retryable, false);
  assert.equal(seen.length, 3, "an unreconstructable birth is not launched");

  await writeFile(runner, `console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "stdout only" }] } }));`);
  const stdoutOnly = await runOmpChild(task, { ...context, mode: "retry", attempt: 2 }, options);
  assert.equal(stdoutOnly.outcome, "errored");
  assert.match(stdoutOnly.diagnostic, /without a committed final reply/);
  assert.equal(stdoutOnly.memory, undefined);
});

test("a spawned child shuts down when its direct parent dies", { skip: process.platform === "win32", timeout: 10_000 }, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "omp-child-orphan-"));
  const ready = join(cwd, "ready");
  const stopped = join(cwd, "stopped");
  const childScript = join(cwd, "child.mjs");
  const parentScript = join(cwd, "parent.mjs");
  const launcher = new URL("../dist/omp/child-process.js", import.meta.url).href;
  await writeFile(childScript, `
import { writeFileSync } from "node:fs";
import { watchOmpChildParent } from ${JSON.stringify(launcher)};
process.once("SIGTERM", () => { writeFileSync(${JSON.stringify(stopped)}, "stopped"); process.exit(0); });
watchOmpChildParent();
writeFileSync(${JSON.stringify(ready)}, String(process.pid));
setInterval(() => {}, 1000);
`);
  await writeFile(parentScript, `
import { spawn } from "node:child_process";
spawn(process.execPath, [${JSON.stringify(childScript)}], {
  stdio: "ignore", env: { ...process.env, SPINE_OMP_CHILD_PARENT_PID: String(process.pid) },
});
setInterval(() => {}, 1000);
`);
  const parent = spawn(process.execPath, [parentScript], { cwd, stdio: "ignore" });
  let orphanPid;
  t.after(async () => {
    parent.kill("SIGKILL");
    if (orphanPid !== undefined) {
      try { process.kill(orphanPid, "SIGKILL"); } catch (cause) { if (cause.code !== "ESRCH") throw cause; }
    }
    await rm(cwd, { recursive: true, force: true });
  });
  async function marker(path) {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      try { return await readFile(path, "utf8"); } catch (cause) { if (cause.code !== "ENOENT") throw cause; }
      await sleep(20);
    }
    assert.fail(`child never wrote ${path}`);
  }
  orphanPid = Number(await marker(ready));
  assert.ok(Number.isSafeInteger(orphanPid) && orphanPid > 0);
  assert.equal(parent.kill("SIGKILL"), true);
  assert.equal(await marker(stopped), "stopped");
  orphanPid = undefined;
});
