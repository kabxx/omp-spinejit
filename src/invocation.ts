import { existsSync } from "node:fs";
import { basename } from "node:path";
import type { SpawnTask } from "@spinejit/spine-sdk";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

export interface ProcessImage {
  execPath: string;
  execArgv: readonly string[];
  argv: readonly string[];
}

export interface OmpInvocation {
  command: string;
  args: string[];
}

export interface OmpChildInvocationContext {
  readonly batchId: string;
  readonly ordinal: number;
  readonly producer: readonly number[];
  readonly attempt: number;
  readonly mode: "initial" | "continue" | "retry";
  readonly sessionId: string;
  readonly sessionPath: string;
  readonly assignment: string;
  readonly task: SpawnTask;
}

export interface OmpChildInvocation {
  readonly command: string;
  readonly args?: readonly string[];
  /** The integration may replace the default with one other extension module. */
  readonly extensionPaths?: readonly [string];
}

export type OmpChildInvocationFactory = (context: OmpChildInvocationContext) => OmpChildInvocation | Promise<OmpChildInvocation>;

export function ompChildRuntimeFlags(pi: Pick<ExtensionAPI, "getThinkingLevel">, ctx: Pick<ExtensionContext, "model">): string[] {
  const flags: string[] = [];
  if (ctx.model !== undefined) flags.push("--provider", ctx.model.provider, "--model", ctx.model.id);
  const thinking = pi.getThinkingLevel();
  if (thinking !== undefined) flags.push("--thinking", thinking);
  if (process.argv.some((arg) => arg === "--approve" || arg === "--auto-approve" || arg === "--yolo")) flags.push("--auto-approve");
  return flags;
}

/**
 * Reconstruct the running omp/Bun image so a Spawn child uses the same binary.
 * Drop inspector flags so a debug parent does not bind the same port.
 */
export function resolveOmpInvocation(
  image: ProcessImage,
  exists: (path: string) => boolean = existsSync,
): OmpInvocation {
  const executable = basename(image.execPath).toLowerCase();
  if (executable === "omp" || executable === "omp.exe") {
    return { command: image.execPath, args: [] };
  }
  const script = image.argv[1];
  if (script !== undefined && !script.startsWith("/$bunfs/root/") && exists(script)) {
    return {
      command: image.execPath,
      args: [...childExecArgv(image.execArgv), script],
    };
  }
  return /^(node|bun)(\.exe)?$/.test(executable)
    ? { command: "omp", args: [] }
    : { command: image.execPath, args: [] };
}




function childExecArgv(execArgv: readonly string[]): string[] {
  const args: string[] = [];
  for (let i = 0; i < execArgv.length; i += 1) {
    const arg = execArgv[i]!;
    if (!isInspectorFlag(arg)) {
      args.push(arg);
      continue;
    }
    if (inspectorTakesSeparateValue(arg)) {
      const next = execArgv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        i += 1;
      }
    }
  }
  return args;
}

function isInspectorFlag(arg: string): boolean {
  return /^(?:--inspect(?:-brk|-port)?|--debug(?:-brk)?)(?:=.*)?$/.test(arg);
}

function inspectorTakesSeparateValue(arg: string): boolean {
  return arg === "--inspect-port";
}
