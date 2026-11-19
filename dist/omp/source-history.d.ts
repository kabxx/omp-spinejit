import type { EpochOrdinalId, SourceCharacter, SourceSnapshot, SpawnArrival } from "@spinejit/spine-sdk";
import { type OmpSpineSourceEntry } from "./protocol.js";
export declare class OmpSourceHistoryError extends Error {
    constructor(message: string);
}
/** Decode untrusted custom-entry data without retaining unrelated native metadata. */
export declare function decodeOmpSourceEntry(raw: unknown, expectedThread?: string): OmpSpineSourceEntry;
/** Build this from checkpoints on the active native branch, never from archived prompts. */
export declare class OmpSourceHistory {
    #private;
    readonly thread: string;
    constructor(thread: string);
    add(value: unknown): void;
    get(epoch: number, boundary: number): SourceCharacter | undefined;
    nativeKey(epoch: number, boundary: number): string | null | undefined;
    /** Native occurrences already assigned to an archive's canonical source prefix. */
    hasNativeKey(epoch: number, nativeKey: string, startBoundary: number, endBoundary: number): boolean;
    resolve(epoch: number, boundary: number, fallback: SourceCharacter, nativeKey: string | null): SourceCharacter;
    resolve(epoch: number, boundary: number): SourceCharacter | undefined;
    /** Checkpoints cannot supply missing native messages, future epochs, or compact boundary gaps. */
    assertReplayComplete(): void;
    /** Current-epoch saved cells must remain present; earlier compact epochs are intentionally absent. */
    assertSnapshotPositions(epoch: number, boundaries: ReadonlySet<number>): void;
}
/**
 * Pure delta stored in the replay lineage, not the explicitly supplied active snapshot namespace.
 * Inherited cells may retain their producer namespace. Append durably before adding the returned delta.
 */
export declare function buildOmpSourceCheckpoint(source: SourceSnapshot, history: OmpSourceHistory, getNativeKey: (sourceId: EpochOrdinalId) => string | null, expectedSnapshotThread?: string, getArrival?: (sourceId: EpochOrdinalId) => SpawnArrival | undefined): OmpSpineSourceEntry | null;
//# sourceMappingURL=source-history.d.ts.map