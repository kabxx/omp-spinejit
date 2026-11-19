import type { SpineRuntimeClient } from "@spinejit/spine-sdk";
import { type HostContextEnvelope, type HostOwnershipClaim, type PublishedContext, type SpineHostAdapter } from "@spinejit/spine-sdk/host";
export * from "./messages.js";
export * from "./lifecycle.js";
export * from "./protocol.js";
export * from "./recovery.js";
import { OMP_ARCHIVE_ENTRY_TYPE, OMP_COMPACT_ENTRY_TYPE, type OmpSpineArchiveEntry, type OmpSpineCompactEntry } from "./protocol.js";
export interface OmpSpinePort<TMessage> {
    claimOwnership(claim: HostOwnershipClaim): Promise<void>;
    appendCustomEntry(type: typeof OMP_ARCHIVE_ENTRY_TYPE, entry: OmpSpineArchiveEntry): Promise<void>;
    appendCustomEntry(type: typeof OMP_COMPACT_ENTRY_TYPE, entry: OmpSpineCompactEntry): Promise<void>;
    materializeContext(context: PublishedContext): Promise<readonly TMessage[]>;
    replaceContext(context: HostContextEnvelope<TMessage>): Promise<void>;
}
export interface OmpSpineAdapterOptions<TMessage> {
    enabled: boolean;
    runtime: SpineRuntimeClient;
    host: OmpSpinePort<TMessage>;
}
export declare function createOmpSpineAdapter<TMessage>(options: OmpSpineAdapterOptions<TMessage>): Promise<SpineHostAdapter | null>;
//# sourceMappingURL=index.d.ts.map