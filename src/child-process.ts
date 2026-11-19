import { spawn } from "node:child_process";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import type { SpawnTask } from "@spinejit/spine-sdk";
import type { SpawnChildContext, SpawnChildTerminal } from "@spinejit/spine-sdk/host";
import { readChildState } from "./child-memory.js";
import {
  buildChildAssignment,
  buildChildContinuation,
  childSessionPath,
  inspectChildSession,
  writeChildPrefixSession,
  type ChildSessionScope,
} from "./child-session.js";
import { resolveOmpInvocation, type OmpChildInvocationFactory } from "./invocation.js";

export const OMP_CHILD_CONFIG_ENV = "SPINE_OMP_CHILD_CONFIG_TOML";
export const OMP_CHILD_BIRTH_ENV = "SPINE_OMP_CHILD_BIRTH";
const PARENT_PID_ENV = "SPINE_OMP_CHILD_PARENT_PID";
const TERM_GRACE_MS = 6_000;

export interface OmpChildProcessOptions extends ChildSessionScope {
  cwd: string;
  origin: string;
  peers: readonly SpawnTask[];
  /** Only supply a prefix known to recreate the committed birth's context. */
  prefixEntries?: readonly SessionEntry[];
  extensionPath: string;
  runtimeFlags?: readonly string[];
  configToml: string;
  childInvocation?: OmpChildInvocationFactory;
  assertGeneration?: () => void;
  existingSessionId?: string;
  ordinal?: number;
}

/** The child stops when its exact launching process is gone, not on normal model completion. */
export function watchOmpChildParent(): (() => void) | undefined {
  const pid = Number(process.env[PARENT_PID_ENV]);
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return undefined;
  const check = () => {
    let parentAlive = false;
    try {
      process.kill(pid, 0);
      parentAlive = true;
    } catch (cause) {
      parentAlive = (cause as NodeJS.ErrnoException).code === "EPERM";
    }
    if (parentAlive && (process.platform === "win32" || process.ppid === pid)) return;
    clearInterval(interval);
    process.kill(process.pid, "SIGTERM");
    setTimeout(() => process.kill(process.pid, "SIGKILL"), TERM_GRACE_MS).unref();
  };
  const interval = setInterval(check, 250);
  interval.unref();
  check();
  return () => clearInterval(interval);
}

/** Run one attempt in a fresh native session, or Continue in the exact existing journal. */
export async function runOmpChild(task: SpawnTask, child: SpawnChildContext, options: OmpChildProcessOptions): Promise<SpawnChildTerminal> {
  const birth = { origin: options.origin, producer: child.producer };
  const path = childSessionPath(options, birth, child.attempt);
  const retryable = options.prefixEntries !== undefined;
  const assignment = buildChildAssignment(task, options.peers);
  const ref = `${options.origin}:${child.producer.join(".")}:attempt-${child.attempt}`;
  let id: string | undefined;
  let previousEntryId: string | null = null;
  let prompt: string;
  try {
    options.assertGeneration?.();
    child.signal.throwIfAborted();
    if (child.mode === "continue") {
      const session = await inspectChildSession({
        destPath: path,
        birth: child.producer,
        assignment,
        ...(options.existingSessionId === undefined ? {} : { expectedId: options.existingSessionId }),
      });
      id = session.id;
      previousEntryId = (await readChildState(path, id)).lastEntryId;
      prompt = buildChildContinuation(child.guidance, session.assignmentPresent ? undefined : assignment);
    } else {
      if (options.prefixEntries === undefined) throw new Error("the committed birth prefix is unavailable");
      id = await writeChildPrefixSession({
        cwd: options.cwd,
        destPath: path,
        entries: options.prefixEntries,
        birth: child.producer,
        parentSession: options.parentSessionFile ?? options.parentSessionId,
      });
      prompt = child.guidance === undefined ? assignment : `${assignment}\n\nRetry guidance:\n${child.guidance}`;
    }
    const invocation = options.childInvocation === undefined
      ? resolveOmpInvocation(process)
      : await options.childInvocation({
        batchId: options.origin,
        ordinal: options.ordinal ?? child.producer.at(-1)!,
        producer: child.producer,
        attempt: child.attempt,
        mode: child.mode,
        sessionId: id,
        sessionPath: path,
        assignment,
        task,
      });
    const extensions = "extensionPaths" in invocation ? invocation.extensionPaths ?? [options.extensionPath] : [options.extensionPath];
    if (!invocation.command.trim()) throw new Error("OMP Spawn child invocation requires a command");
    if (extensions.length !== 1 || !extensions[0]?.trim()) throw new Error("OMP Spawn child invocation requires exactly one extension module");
    options.assertGeneration?.();
    child.signal.throwIfAborted();
    const result = await spawnChildProcess(invocation.command, [
      ...(invocation.args ?? []), "--mode", "json", "-p", "--no-extensions", "--resume", path,
      "--extension", extensions[0], "--spine-child=true", ...(options.runtimeFlags ?? []), "--", prompt,
    ], options.cwd, child.signal, {
      ...process.env,
      [OMP_CHILD_CONFIG_ENV]: options.configToml,
      [OMP_CHILD_BIRTH_ENV]: JSON.stringify(birth.producer),
      [PARENT_PID_ENV]: String(process.pid),
    });
    options.assertGeneration?.();
    let journalError: string | null = null;
    let journalDiagnostic: string | null = null;
    try {
      const state = await readChildState(path, id);
      if (state.lastEntryId !== previousEntryId) {
        if (!child.signal.aborted && result.code === 0 && state.terminal?.outcome === "completed") {
          return { ...state.terminal, executionRef: `${ref}:${id}` };
        }
        journalDiagnostic = state.diagnostic;
      }
      if (state.open > 0) journalError = `OMP Spawn child ended with ${state.open} of its own children pending`;
    } catch (cause) {
      journalError = cause instanceof Error ? cause.message : String(cause);
    }
    const diagnostic = journalDiagnostic ?? result.providerError ?? (result.stderr.trim() || journalError
      || (child.signal.aborted ? "OMP Spawn child was cancelled" : result.code === 0
        ? "OMP Spawn child ended without a committed final reply"
        : `OMP Spawn child exited (${result.signal ?? result.code})`));
    return await failedAttempt(diagnostic, id);
  } catch (cause) {
    return await failedAttempt(cause instanceof Error ? cause.message : String(cause), id);
  }

  async function failedAttempt(diagnostic: string, sessionId?: string): Promise<SpawnChildTerminal> {
    let reason: string | undefined;
    if (!child.signal.aborted) {
      try {
        if (sessionId === undefined) throw new Error("no validated child session was saved");
        await inspectChildSession({ destPath: path, birth: child.producer, expectedId: sessionId, assignment });
      } catch (cause) {
        reason = cause instanceof Error ? cause.message : String(cause);
      }
    }
    return {
      outcome: child.signal.aborted ? "aborted" : "errored",
      diagnostic,
      executionRef: sessionId === undefined ? ref : `${ref}:${sessionId}`,
      recovery: { continueable: !child.signal.aborted && reason === undefined, retryable, ...(reason === undefined ? {} : { reason }) },
    };
  }
}

interface ChildProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  providerError: string | null;
  stderr: string;
}

function spawnChildProcess(command: string, args: string[], cwd: string, signal: AbortSignal, env: NodeJS.ProcessEnv): Promise<ChildProcessExit> {
  const { promise, resolve, reject } = Promise.withResolvers<ChildProcessExit>();
  const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stderr = "";
  let providerError: string | null = null;
  let partial = "";
  let skipLine = false;
  let escalation: NodeJS.Timeout | undefined;
  const abort = () => {
    child.kill("SIGTERM");
    escalation = setTimeout(() => child.kill("SIGKILL"), TERM_GRACE_MS);
    escalation.unref();
  };
  const cleanup = () => {
    signal.removeEventListener("abort", abort);
    clearTimeout(escalation);
  };
  const scan = (line: string) => {
    if (!line.includes('"message_end"')) return;
    try {
      const event = JSON.parse(line) as { type?: string; message?: { stopReason?: string; errorMessage?: string } } | null;
      if (event?.type === "message_end" && event.message?.stopReason === "error" && typeof event.message.errorMessage === "string") {
        providerError = event.message.errorMessage.trim() || providerError;
      }
    } catch {
      // Stdout is diagnostic only; the durable journal establishes success.
    }
  };
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    const lines = chunk.split("\n");
    const trailing = lines.pop()!;
    for (const line of lines) {
      if (!skipLine) scan(partial + line);
      partial = "";
      skipLine = false;
    }
    if (!skipLine) {
      partial += trailing;
      if (partial.length > 4 * 1024 * 1024) {
        partial = "";
        skipLine = true;
      }
    }
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-16_384); });
  child.once("error", (cause) => { cleanup(); reject(cause); });
  child.once("close", (code, exitSignal) => {
    cleanup();
    if (!skipLine && partial) scan(partial);
    resolve({ code, signal: exitSignal, providerError, stderr });
  });
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  return promise;
}
