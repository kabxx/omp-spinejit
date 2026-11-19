import type { CompactBarrier, SamplingArchiveRecord, SourceCharacter } from "@spinejit/spine-sdk";
export declare const OMP_ADAPTER_ID: "spine-plugin/omp/v3";
export declare const OMP_LEGACY_ADAPTER_ID: "spine-plugin/omp/v1";
export declare const OMP_ARCHIVE_ENTRY_TYPE: "spine.archive.v1";
export declare const OMP_COMPACT_ENTRY_TYPE: "spine.compact.v1";
export declare const OMP_SOURCE_ENTRY_TYPE: "spine.source.v1";
export declare const OMP_CHILD_RETURN_ENTRY_TYPE: "spine.child-return.v1";
export interface OmpSpineArchiveEntry {
    schema: typeof OMP_ADAPTER_ID;
    durabilityId: string;
    record: SamplingArchiveRecord;
}
/** Minimal immutable source plus producer identity; native entries still own existence and model-visible messages. */
export interface OmpSpineSourceEntry {
    schema: typeof OMP_ADAPTER_ID;
    thread: string;
    epoch: number;
    characters: readonly SourceCharacter[];
    /** Parallel to characters: stable native identity for messages and arrivals; null for other cells. */
    nativeKeys: readonly (string | null)[];
}
export interface OmpSpineCompactEntry {
    schema: typeof OMP_ADAPTER_ID;
    barrier: CompactBarrier;
    replacementMessages: readonly unknown[];
    /** Parallel to replacementMessages. Null until the host entry id is known. */
    replacementEntryIds?: readonly (string | null)[];
    /** Leaf used to calculate this native receipt; absent on legacy records. */
    preparedLeafId?: string;
    /** Native acknowledgement needed to complete a terminal durable barrier after a crash. */
    nativeAcknowledgement?: {
        firstKeptEntryId: string;
        tokensBefore: number;
    };
}
/** Published only after the accepting sampling and its observers commit. */
export interface OmpChildReturnEntry {
    schema: typeof OMP_ADAPTER_ID;
    toolCallId: string;
    transactionId: string;
    memory: string;
}
//# sourceMappingURL=protocol.d.ts.map