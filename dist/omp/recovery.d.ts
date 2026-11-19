import type { ReplayItem, SourceSnapshot, SpineRuntimeClient } from "@spinejit/spine-sdk";
import { type SpineHostAdapter } from "@spinejit/spine-sdk/host";
import { OmpSourceBindings, type OmpAgentMessage } from "./messages.js";
import { type OmpSpineCompactEntry } from "./protocol.js";
import { OmpSourceHistory } from "./source-history.js";
export interface OmpBranchEntry {
    type: string;
    id?: string;
    parentId?: string | null;
    timestamp?: string;
    customType?: string;
    data?: unknown;
    fromExtension?: boolean;
    firstKeptEntryId?: string;
    tokensBefore?: number;
    summary?: string;
    details?: unknown;
}
export interface OmpReplaySource {
    boundary: number;
    message: OmpAgentMessage;
    entryId: string | null;
}
export interface OmpReplayPlan {
    runtimeThread: string;
    currentSessionId: string;
    currentThread: string;
    inputs: ReplayItem[];
    sources: OmpReplaySource[];
    sourceHistory: OmpSourceHistory;
    pendingNativeCompaction: OmpSpineCompactEntry | null;
}
export interface BuildOmpReplayPlanOptions {
    currentSessionId: string;
    branch: readonly OmpBranchEntry[];
    messagesForEntry(entry: OmpBranchEntry): readonly OmpAgentMessage[];
    /** Unpersisted or post-prefix source occurrences, not an overlapping context transcript. */
    extraMessages?: readonly OmpAgentMessage[];
    /** Initialization only: replay a terminal barrier, then durably complete its recorded native acknowledgement. */
    completePendingNativeCompaction?: boolean;
}
export interface RecoverOmpSessionOptions {
    plan: OmpReplayPlan;
    runtimeFactory(thread: string): SpineRuntimeClient;
    adapterFactory(runtime: SpineRuntimeClient, bindings: OmpSourceBindings): Promise<SpineHostAdapter>;
}
export interface RecoveredOmpSession {
    adapter: SpineHostAdapter;
    bindings: OmpSourceBindings;
    source: SourceSnapshot;
}
export declare class OmpSessionRecoveryError extends Error {
    constructor(message: string);
}
export declare class OmpLegacyJournalError extends OmpSessionRecoveryError {
}
/** Scan the active native branch before rewind, fallback, or copying any prefix. */
export declare function assertOmpV3ReplayBranch(branch: readonly OmpBranchEntry[]): void;
export declare function ompRewindLeaf(branch: readonly OmpBranchEntry[]): {
    leafId: string | null;
} | null;
export declare function ompResetBoundaryIndex(branch: readonly OmpBranchEntry[]): number;
export declare function buildOmpReplayPlan(options: BuildOmpReplayPlanOptions): OmpReplayPlan;
export declare function recoverOmpSession(options: RecoverOmpSessionOptions): Promise<RecoveredOmpSession>;
export declare function installSourceBindings(bindings: OmpSourceBindings, source: SourceSnapshot, observations: readonly OmpReplaySource[]): void;
/** A stock OMP acknowledgement carries the Spine barrier in the same journal entry. */
export declare function readOmpNativeCompactReceipt(entry: OmpBranchEntry): OmpSpineCompactEntry | null;
//# sourceMappingURL=recovery.d.ts.map