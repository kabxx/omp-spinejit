import type { completeSimple } from "@oh-my-pi/pi-ai";
import type { ExtensionFactory, SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { type FinishSamplingResult } from "@spinejit/spine-sdk/host";
import { type NodeSpineRuntime } from "@spinejit/spine-sdk/node";
import type { OmpChildInvocationFactory } from "./invocation.js";
export type { OmpChildInvocation, OmpChildInvocationContext, OmpChildInvocationFactory } from "./invocation.js";
export interface OmpExtensionRuntimeFactory {
    create(thread: string): NodeSpineRuntime;
}
export interface CreateOmpExtensionOptions {
    runtimeFactory?: OmpExtensionRuntimeFactory;
    childInvocation?: OmpChildInvocationFactory;
    compactionCompletion?: typeof completeSimple;
    onSessionReady?: (info: {
        sessionId: string;
        thread: string;
        epoch: number;
        scopeCursor: readonly number[];
        runtime: NodeSpineRuntime;
        entries: readonly SessionEntry[];
    }) => Promise<void> | void;
    onSamplingCommit?: (info: {
        sessionId: string;
        commit: FinishSamplingResult;
        entries: readonly SessionEntry[];
    }) => Promise<void> | void;
}
/** Creates the OMP extension factory backed by the packaged Node/WASM SDK. */
export declare function createOmpExtension(options?: CreateOmpExtensionOptions): ExtensionFactory;
declare const _default: ExtensionFactory;
export default _default;
//# sourceMappingURL=extension.d.ts.map