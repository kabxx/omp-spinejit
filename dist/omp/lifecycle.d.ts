import type { CompactBarrier, SourceSnapshot, SpawnTask, SpineOperation } from "@spinejit/spine-sdk";
import { type SpineToolName, type FinishSamplingResult, type SpineHostAdapter } from "@spinejit/spine-sdk/host";
import { OmpSourceBindings, type OmpAgentMessage } from "./messages.js";
export declare const OMP_SPINE_TOOL_NAMES: readonly ["spine_open", "spine_close", "spine_next", "spine_spawn"];
export type OmpSpineToolName = SpineToolName;
export interface OmpTurnEnd {
    message: OmpAgentMessage;
    aborted: boolean;
}
interface OmpPersistedSource {
    boundary: number;
    message: OmpAgentMessage;
    entryId?: string | null;
}
export declare class OmpSamplingLifecycleError extends Error {
    constructor(message: string, options?: ErrorOptions);
}
/** Recoverable denial: a sampling admits only one Spine operation. */
export declare class OmpSpineToolLimitError extends Error {
    constructor(tool: OmpSpineToolName);
}
/** One OMP assistant/tool turn maps to one Spine sampling. Provider retries reuse it. */
export declare class OmpSamplingLifecycle {
    #private;
    constructor(adapter: SpineHostAdapter, bindings: OmpSourceBindings, source: SourceSnapshot, options?: {
        contextReady?: boolean;
    });
    get fault(): unknown;
    get samplingActive(): boolean;
    get responseCalls(): number;
    get enteredArrivals(): ReadonlySet<string>;
    observeMessage(message: OmpAgentMessage): Promise<void>;
    previewContext(): Promise<void>;
    /** Admit durable host additions that omp appends without extension message events. */
    observePersistedSources(sources: readonly OmpPersistedSource[]): Promise<void>;
    sourceSnapshot(): Promise<SourceSnapshot>;
    compact(barrier: CompactBarrier, replacementMessages: readonly OmpAgentMessage[], entryIds?: readonly (string | null)[]): Promise<void>;
    beginSampling(_providerPayload: unknown): Promise<void>;
    /** omp fires multiple provider requests per user turn; start sampling at most once. */
    ensureSampling(providerPayload?: unknown): Promise<void>;
    registerToolCall(toolCallId: string, toolName: string, input: Record<string, unknown>): Promise<boolean>;
    finishToolCall(toolCallId: string, succeeded: boolean): Promise<boolean>;
    finishTurn(turn: OmpTurnEnd): Promise<FinishSamplingResult | null>;
}
export declare function buildCompactBarrier(source: SourceSnapshot, replacementCount: number): CompactBarrier;
export declare function operationFromOmpToolCall(toolName: OmpSpineToolName, input: Record<string, unknown>): SpineOperation;
export declare function decodeSpawnTasks(input: Record<string, unknown>): SpawnTask[];
export {};
//# sourceMappingURL=lifecycle.d.ts.map