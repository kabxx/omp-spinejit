import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir, release } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Runs the existing real-host/local-provider suite, never a replacement SDK.
// No build, install, public provider request, or user configuration discovery.
// node scripts/compat-smoke.mjs --host 18.8.6=/absolute/omp \
//   --host-cli 18.8.7=/temporary/package/dist/cli.js --bun /absolute/bun
// Windows rows require Windows Node and a Windows OMP executable or Windows Bun.
const packageDir = fileURLToPath(new URL("..", import.meta.url));
const hosts = [];
let evidenceDir;
let bun;
for (let index = 2; index < process.argv.length; index++) {
  const flag = process.argv[index];
  assert.ok(["--host", "--host-cli", "--bun", "--evidence-dir"].includes(flag), `Unknown option: ${flag}`);
  const value = process.argv[++index];
  assert.ok(value && !value.startsWith("--"), `${flag} requires a value`);
  if (flag === "--bun") bun = resolve(value);
  else if (flag === "--evidence-dir") evidenceDir = resolve(value);
  else {
    const separator = value.indexOf("=");
    const version = value.slice(0, separator);
    const binary = value.slice(separator + 1);
    assert.ok(separator > 0 && /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version), `${flag} requires VERSION=ABSOLUTE_PATH`);
    assert.ok(isAbsolute(binary), `${flag} requires an absolute path: ${binary}`);
    hosts.push({ expectedVersion: version, path: binary, kind: flag === "--host" ? "executable" : "package-cli" });
  }
}
assert.ok(hosts.length, "Specify at least one --host VERSION=ABSOLUTE_PATH or --host-cli VERSION=ABSOLUTE_PATH");
const [major, minor] = process.versions.node.split(".").map(Number);
assert.ok(major > 22 || (major === 22 && minor >= 19), "Run with Node >=22.19.0");
if (evidenceDir) await mkdir(evidenceDir, { recursive: true });
const root = await mkdtemp(join(evidenceDir ?? tmpdir(), "omp-compat-"));
const report = {
  platform: process.platform,
  arch: process.arch,
  osRelease: release(),
  node: process.versions.node,
  evidenceRoot: root,
  suite: "test/native-host/*.test.mjs",
  rows: [],
};
const testDir = join(packageDir, "test", "native-host");
const tests = (await readdir(testDir)).filter((name) => name.endsWith(".test.mjs")).sort().map((name) => join(testDir, name));
assert.ok(tests.length, "No native-host tests found");
await access(join(packageDir, "dist", "omp", "extension.js"));
report.tests = tests;
console.log(`Actual ${report.platform}/${report.arch} compatibility matrix; evidence: ${root}`);

// Deliberately whitelist, including Windows process-launch prerequisites only.
// HOME/profile/caches all refer to this row; no inherited model tokens or proxies.
function isolatedEnv(rowRoot) {
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: join(rowRoot, "home"),
    USERPROFILE: join(rowRoot, "home"),
    XDG_CONFIG_HOME: join(rowRoot, "home", ".config"),
    PI_CODING_AGENT_DIR: join(rowRoot, "profile"),
    OMP_CODING_AGENT_DIR: join(rowRoot, "profile"),
    TMPDIR: join(rowRoot, "tmp"),
    TMP: join(rowRoot, "tmp"),
    TEMP: join(rowRoot, "tmp"),
    BUN_INSTALL_CACHE_DIR: join(rowRoot, "bun-cache"),
    TERM: "dumb",
    NO_COLOR: "1",
  };
  if (process.platform === "win32") {
    for (const name of ["SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"]) {
      if (process.env[name]) env[name] = process.env[name];
    }
    env.APPDATA = join(rowRoot, "home", "AppData", "Roaming");
    env.LOCALAPPDATA = join(rowRoot, "home", "AppData", "Local");
  }
  return env;
}

async function run(binary, args, env, cwd, echo = false, timeoutMs) {
  let stdout = "";
  let stderr = "";
  return await new Promise((resolveRun) => {
    const child = spawn(binary, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
    let launchError;
    let timedOut = false;
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; if (echo) process.stdout.write(chunk); });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; if (echo) process.stderr.write(chunk); });
    child.once("error", (error) => { launchError = error.message; });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolveRun({ code, signal, stdout, stderr, ...(launchError ? { error: launchError } : {}), ...(timedOut ? { timedOut: true } : {}) });
    });
  });
}

for (const [index, host] of hosts.entries()) {
  const rowRoot = join(root, `${index + 1}-${host.expectedVersion}`);
  await Promise.all(["home", "profile", "tmp", "evidence", "bun-cache"].map((name) => mkdir(join(rowRoot, name), { recursive: true })));
  const row = { ...host, platform: process.platform, arch: process.arch, status: "unavailable", evidenceRoot: rowRoot };
  report.rows.push(row);
  try {
    await access(host.path);
    const env = isolatedEnv(rowRoot);
    // Runtime IO must use the OS temporary filesystem, not an evidence mount
    // whose open-directory rename semantics may differ (for example WSL /mnt/c).
    const runtimeTemp = await mkdtemp(join(tmpdir(), "omp-compat-runtime-"));
    row.runtimeTemp = runtimeTemp;
    env.TMPDIR = runtimeTemp;
    env.TMP = runtimeTemp;
    env.TEMP = runtimeTemp;
    let binary = host.path;
    let prefix = [];
    if (host.kind === "package-cli") {
      assert.ok(bun, "--host-cli requires --bun ABSOLUTE_PATH");
      await access(bun);
      row.bun = await run(bun, ["--version"], env, rowRoot, false, 30_000);
      assert.equal(row.bun.code, 0, "Bun version prerequisite failed");
      binary = bun;
      prefix = [host.path];
    }
    row.versionProbe = await run(binary, [...prefix, "--version"], env, rowRoot, false, 30_000);
    assert.equal(row.versionProbe.code, 0, `OMP version prerequisite failed: ${row.versionProbe.error ?? row.versionProbe.stderr}`);
    const actualVersion = row.versionProbe.stdout.trim().match(/(?:^|\b)(\d+\.\d+\.\d+(?:-[\w.-]+)?)(?:$|\s)/)?.[1];
    assert.equal(actualVersion, host.expectedVersion, "OMP executable version does not match the requested matrix row");
    row.actualVersion = actualVersion;
    row.status = "running";
    console.log(`\nRunning actual ${process.platform}/${process.arch} OMP ${actualVersion}: ${host.path}`);
    const result = await run(process.execPath, ["--test", "--test-concurrency=1", ...tests], {
      ...env, OMP_BIN: binary, OMP_BIN_ARGS: JSON.stringify(prefix), OMP_NATIVE_EVIDENCE_DIR: join(rowRoot, "evidence"),
      ...(process.env.OMP_NATIVE_TIMEOUT_MS ? { OMP_NATIVE_TIMEOUT_MS: process.env.OMP_NATIVE_TIMEOUT_MS } : {}),
    }, packageDir, true);
    await Promise.all([
      writeFile(join(rowRoot, "native.stdout.log"), result.stdout),
      writeFile(join(rowRoot, "native.stderr.log"), result.stderr),
    ]);
    row.exit = { code: result.code, signal: result.signal, ...(result.error ? { error: result.error } : {}) };
    row.status = result.code === 0 && result.signal === null ? "passed" : "failed";
  } catch (error) {
    row.reason = error.message;
    if (row.status === "running") row.status = "failed";
    console.error(`OMP ${host.expectedVersion}: ${row.status}: ${row.reason}`);
  }
  await writeFile(join(root, "matrix.json"), JSON.stringify(report, null, 2) + "\n");
}
console.log(`\nMatrix evidence: ${join(root, "matrix.json")}`);
process.exitCode = report.rows.every((row) => row.status === "passed") ? 0 : 1;
