import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveOmpInvocation } from "../dist/omp/invocation.js";

test("compiled omp image uses execPath with empty args", () => {
  assert.deepEqual(
    resolveOmpInvocation({
      execPath: "/home/wxh/.local/bin/omp",
      execArgv: [],
      argv: ["/home/wxh/.local/bin/omp"],
    }),
    { command: "/home/wxh/.local/bin/omp", args: [] },
  );
});

test("node without a script falls back to omp on PATH", () => {
  assert.deepEqual(
    resolveOmpInvocation({
      execPath: "/usr/bin/node",
      execArgv: [],
      argv: ["/usr/bin/node"],
    }),
    { command: "omp", args: [] },
  );
});

test("inspector flags are dropped from child execArgv", () => {
  assert.deepEqual(
    resolveOmpInvocation({
      execPath: "/usr/bin/node",
      execArgv: ["--inspect-port", "9229", "--enable-source-maps"],
      argv: ["/usr/bin/node", "/abs/cli.js"],
    }, (path) => path === "/abs/cli.js"),
    { command: "/usr/bin/node", args: ["--enable-source-maps", "/abs/cli.js"] },
  );
});

test("reconstructed node child does not inherit parent CLI operands named omp", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "omp-invocation-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = join(dir, "cli.js");
  await writeFile(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)));");
  const invocation = resolveOmpInvocation({
    execPath: process.execPath,
    execArgv: [],
    argv: [process.execPath, script, "--model", "parent-model", "omp"],
  });
  const child = spawnSync(invocation.command, [...invocation.args, "--mode", "json", "-p", "child assignment"], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), ["--mode", "json", "-p", "child assignment"]);
});

test("reconstructed node child does not mistake a later cli.js operand for its entrypoint", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "omp-invocation-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const entry = join(dir, "entry.cjs");
  const operand = join(dir, "cli.js");
  await writeFile(entry, "process.stdout.write(JSON.stringify(process.argv.slice(2)));");
  await writeFile(operand, "throw new Error('parent operand must not execute');");
  const invocation = resolveOmpInvocation({
    execPath: process.execPath,
    execArgv: [],
    argv: [process.execPath, entry, operand],
  });
  const child = spawnSync(invocation.command, [...invocation.args, "child assignment"], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), ["child assignment"]);
});
