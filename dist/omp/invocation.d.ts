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
export declare function ompChildRuntimeFlags(pi: Pick<ExtensionAPI, "getThinkingLevel">, ctx: Pick<ExtensionContext, "model">): string[];
/**
 * Reconstruct the running omp/Bun image so a Spawn child uses the same binary.
 * Drop inspector flags so a debug parent does not bind the same port.
 */
export declare function resolveOmpInvocation(image: ProcessImage, exists?: (path: string) => boolean): OmpInvocation;
//# sourceMappingURL=invocation.d.ts.map