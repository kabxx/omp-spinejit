import { existsSync } from "node:fs";
import { basename } from "node:path";
export function ompChildRuntimeFlags(pi, ctx) {
    const flags = [];
    if (ctx.model !== undefined)
        flags.push("--provider", ctx.model.provider, "--model", ctx.model.id);
    const thinking = pi.getThinkingLevel();
    if (thinking !== undefined)
        flags.push("--thinking", thinking);
    if (process.argv.some((arg) => arg === "--approve" || arg === "--auto-approve" || arg === "--yolo"))
        flags.push("--auto-approve");
    return flags;
}
/**
 * Reconstruct the running omp/Bun image so a Spawn child uses the same binary.
 * Drop inspector flags so a debug parent does not bind the same port.
 */
export function resolveOmpInvocation(image, exists = existsSync) {
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
function childExecArgv(execArgv) {
    const args = [];
    for (let i = 0; i < execArgv.length; i += 1) {
        const arg = execArgv[i];
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
function isInspectorFlag(arg) {
    return /^(?:--inspect(?:-brk|-port)?|--debug(?:-brk)?)(?:=.*)?$/.test(arg);
}
function inspectorTakesSeparateValue(arg) {
    return arg === "--inspect-port";
}
//# sourceMappingURL=invocation.js.map