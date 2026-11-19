import { createHostAdapter, } from "@spinejit/spine-sdk/host";
export * from "./messages.js";
export * from "./lifecycle.js";
export * from "./protocol.js";
export * from "./recovery.js";
import { OMP_ADAPTER_ID, OMP_ARCHIVE_ENTRY_TYPE, OMP_COMPACT_ENTRY_TYPE, } from "./protocol.js";
export async function createOmpSpineAdapter(options) {
    if (!options.enabled) {
        return null;
    }
    return createHostAdapter({
        runtime: options.runtime,
        host: {
            claimOwnership: (claim) => options.host.claimOwnership(claim),
            persistArchive: (entry) => options.host.appendCustomEntry(OMP_ARCHIVE_ENTRY_TYPE, {
                schema: OMP_ADAPTER_ID,
                durabilityId: entry.durabilityId,
                record: entry.record,
            }),
            persistCompact: (barrier, metadata) => {
                const persisted = compactPersistence(metadata);
                return options.host.appendCustomEntry(OMP_COMPACT_ENTRY_TYPE, {
                    schema: OMP_ADAPTER_ID,
                    barrier,
                    replacementMessages: persisted.messages,
                    ...(persisted.entryIds === undefined ? {} : { replacementEntryIds: persisted.entryIds }),
                });
            },
            context: {
                materialize: (context) => options.host.materializeContext(context),
                publishAtomic: (context) => options.host.replaceContext(context),
            },
        },
    });
}
function compactPersistence(metadata) {
    if (metadata !== undefined && "messages" in metadata) {
        if (metadata.messages.length === 0) {
            throw new Error("OMP compact persistence requires replacement metadata");
        }
        if (metadata.entryIds.length !== metadata.messages.length) {
            throw new Error("OMP compact replacement entry ids do not match replacement messages");
        }
        return { messages: metadata.messages, entryIds: metadata.entryIds };
    }
    if (metadata === undefined || metadata.length === 0) {
        throw new Error("OMP compact persistence requires replacement metadata");
    }
    return { messages: metadata };
}
//# sourceMappingURL=index.js.map