import { archiveRecordId } from "@spinejit/spine-sdk/host";
import { isOmpSourceMessage, ompArrivalOf, ompNativeMessageKey, OmpSourceBindings, sourceObservation, SPINE_ARRIVAL_CUSTOM_TYPE } from "./messages.js";
import { OMP_ADAPTER_ID, OMP_LEGACY_ADAPTER_ID, OMP_ARCHIVE_ENTRY_TYPE, OMP_COMPACT_ENTRY_TYPE, OMP_SOURCE_ENTRY_TYPE, } from "./protocol.js";
import { decodeOmpSourceEntry, OmpSourceHistory } from "./source-history.js";
import { sessionEntryToOmpMessages } from "./host-projection.js";
export class OmpSessionRecoveryError extends Error {
    constructor(message) {
        super(message);
        this.name = "OmpSessionRecoveryError";
    }
}
export class OmpLegacyJournalError extends OmpSessionRecoveryError {
}
/** Scan the active native branch before rewind, fallback, or copying any prefix. */
export function assertOmpV3ReplayBranch(branch) {
    for (const entry of branch) {
        const custom = entry.type === "custom";
        const payload = custom && (entry.customType === OMP_ARCHIVE_ENTRY_TYPE ||
            entry.customType === OMP_SOURCE_ENTRY_TYPE || entry.customType === OMP_COMPACT_ENTRY_TYPE)
            ? entry.data : undefined;
        const receipt = isRecord(entry.details) ? entry.details[OMP_COMPACT_ENTRY_TYPE] : undefined;
        if ((custom && entry.customType === "spine.spawn-terminal.v1") || isLegacyEnvelope(payload) || isLegacyEnvelope(receipt)) {
            throw new OmpLegacyJournalError("This session uses Spine SDK v2. Open it with the v2 OMP adapter or start a new session.");
        }
    }
}
function isLegacyEnvelope(value) {
    return isRecord(value) && (value.schema === OMP_LEGACY_ADAPTER_ID || value.schema === "spine-plugin/omp/v2" ||
        value.schema === "spine-sdk/v2");
}
// Only native user rewind/branch cuts may discard an invisible, uncommitted
// sampling prefix. Keep the journal intact and move the active leaf instead.
export function ompRewindLeaf(branch) {
    assertOmpV3ReplayBranch(branch);
    let end = branch.length;
    let discardedStart = null;
    while (end > 0) {
        const entry = branch[end - 1];
        if (entry.type !== "custom")
            break;
        if (entry.customType === OMP_SOURCE_ENTRY_TYPE && discardedStart !== null) {
            const checkpoint = decodeOmpSourceEntry(entry.data);
            if (checkpoint.epoch !== discardedStart.record.epoch
                || checkpoint.characters.at(-1).boundary !== discardedStart.record.pre_boundary.ordinal
                || !checkpointHasMissingSource(checkpoint, branch, end - 1))
                break;
            end -= 1;
            continue;
        }
        if (entry.customType !== OMP_ARCHIVE_ENTRY_TYPE)
            break;
        const archive = decodeArchiveEntry(entry.data);
        if (archive.record.type !== "sampling_started")
            break;
        discardedStart = archive.record;
        end -= 1;
    }
    if (end === branch.length)
        return null;
    if (end === 0)
        return { leafId: null };
    const leafId = branch[end - 1].id;
    if (typeof leafId !== "string" || leafId.length === 0) {
        throw new OmpSessionRecoveryError("OMP rewind predecessor has no native entry ID");
    }
    return { leafId };
}
function checkpointHasMissingSource(checkpoint, branch, end) {
    for (const nativeKey of checkpoint.nativeKeys) {
        if (nativeKey === null)
            continue;
        let present = false;
        for (let index = ompResetBoundaryIndex(branch) + 1; index < end && !present; index += 1) {
            for (const message of sessionEntryToOmpMessages(branch[index])) {
                if (isOmpSourceMessage(message) && ompNativeMessageKey(message) === nativeKey) {
                    present = true;
                    break;
                }
            }
        }
        if (!present)
            return true;
    }
    return false;
}
export function ompResetBoundaryIndex(branch) {
    for (let index = branch.length - 1; index >= 0; index -= 1) {
        if (branch[index].type === "reset_boundary")
            return index;
    }
    return -1;
}
export function buildOmpReplayPlan(options) {
    assertOmpV3ReplayBranch(options.branch);
    const resetIndex = ompResetBoundaryIndex(options.branch);
    const resetId = resetIndex < 0 ? null : options.branch[resetIndex].id;
    if (resetIndex >= 0 && (typeof resetId !== "string" || resetId.length === 0)) {
        throw new OmpSessionRecoveryError("OMP reset boundary has no native entry ID");
    }
    const currentThread = resetId === null
        ? options.currentSessionId
        : `${options.currentSessionId}-reset-${resetId}`;
    let sourceHistory = null;
    for (let index = resetIndex + 1; index < options.branch.length; index += 1) {
        const entry = options.branch[index];
        if (entry.type !== "custom" || entry.customType !== OMP_SOURCE_ENTRY_TYPE)
            continue;
        if (sourceHistory === null) {
            if (!isRecord(entry.data) || typeof entry.data.thread !== "string") {
                throw new OmpSessionRecoveryError("OMP source checkpoint has no thread");
            }
            sourceHistory = new OmpSourceHistory(entry.data.thread);
        }
        sourceHistory.add(entry.data);
    }
    // A persisted host notice may race checkpoint/commit persistence without having
    // been admitted by that sampling. Only canonical identity can authorize moving
    // its admission past an archive; user/assistant order remains native order.
    const followingArchives = new Map();
    const decodedArchives = new Map();
    const archiveFollowers = new Map();
    let followingArchive = null;
    for (let index = options.branch.length - 1; index > resetIndex; index -= 1) {
        const entry = options.branch[index];
        if ((entry.type === "custom" && entry.customType === OMP_COMPACT_ENTRY_TYPE)
            || (entry.type === "compaction" && isRecord(entry.details) && OMP_COMPACT_ENTRY_TYPE in entry.details))
            followingArchive = null;
        if (followingArchive !== null)
            followingArchives.set(index, followingArchive);
        if (entry.type === "custom" && entry.customType === OMP_ARCHIVE_ENTRY_TYPE) {
            const decoded = decodeArchiveEntry(entry.data).record;
            if (followingArchive !== null)
                archiveFollowers.set(decoded, followingArchive);
            followingArchive = decoded;
            decodedArchives.set(index, followingArchive);
        }
    }
    const inputs = [];
    let sources = [];
    let firstArchiveThread = null;
    let boundary = 0;
    let epoch = 0;
    const applyCompact = (compact, summaryEntryId) => {
        if (pendingArchives.length !== 0) {
            throw new OmpSessionRecoveryError("OMP compact archive precedes a missing sampling source");
        }
        firstArchiveThread ??= compact.barrier.thread;
        if (compact.replacementMessages.length === 0 ||
            compact.replacementMessages.length !== compact.barrier.replacement_boundaries.length) {
            throw new OmpSessionRecoveryError("OMP Spine compact replacement message count does not match barrier boundaries");
        }
        inputs.push({ type: "compact", barrier: compact.barrier });
        sources = compact.replacementMessages.map((message, index) => ({
            boundary: compact.barrier.replacement_boundaries[index],
            message: message,
            entryId: index === 0 && summaryEntryId !== null ? summaryEntryId : storedEntryId(compact.replacementEntryIds, index),
        }));
        epoch = compact.barrier.next_epoch;
        if (sourceHistory !== null)
            for (const [index, replacementBoundary] of compact.barrier.replacement_boundaries.entries()) {
                const saved = sourceHistory.get(epoch, replacementBoundary);
                const expected = saved?.type === "synthetic" ? {
                    type: "synthetic", boundary: replacementBoundary,
                    item: { Native: { source: { CompactReplacement: { compact_boundary: compact.barrier.boundary, index } } } },
                } : { type: "opaque", boundary: replacementBoundary };
                sourceHistory.resolve(epoch, replacementBoundary, expected, null);
            }
        boundary = compact.barrier.replacement_boundaries.at(-1) + 1;
    };
    let compactAwaitingNativeEntry = false;
    let pendingNativeCompaction = null;
    // OMP may persist an admitted source after its archive. Release archives in
    // durable archive order as soon as their exact source tail becomes available.
    const pendingArchives = [];
    let nextPendingArchive = 0;
    const deferredSources = new Map();
    let flushingArchives = false;
    const admitSource = (message, entryId, nativeKey) => {
        const observation = sourceObservation(message, boundary);
        inputs.push({ type: "source", character: sourceHistory?.resolve(epoch, boundary, observation.character, nativeKey ?? ompNativeMessageKey(message)) ?? observation.character });
        sources.push({ boundary, message: observation.message, entryId });
        boundary += 1;
        flushArchives();
    };
    const flushArchives = () => {
        if (flushingArchives)
            return;
        flushingArchives = true;
        while (nextPendingArchive < pendingArchives.length) {
            const archive = pendingArchives[nextPendingArchive];
            const requiredBoundary = archive.type === "sampling_started"
                ? archive.record.pre_boundary.ordinal
                : archive.record.post_boundary.ordinal;
            if (requiredBoundary >= boundary) {
                flushingArchives = false;
                return;
            }
            if (requiredBoundary !== boundary - 1) {
                throw new OmpSessionRecoveryError(`OMP ${archive.type} archive boundary is not the source tail`);
            }
            inputs.push({ type: "archive", record: archive });
            nextPendingArchive += 1;
            const deferred = deferredSources.get(archive);
            deferredSources.delete(archive);
            for (const source of deferred ?? [])
                queueSource(source.message, source.entryId, archiveFollowers.get(archive));
        }
        pendingArchives.length = 0;
        nextPendingArchive = 0;
        flushingArchives = false;
    };
    const queueSource = (message, entryId, archive) => {
        if (message.role === "user" || message.role === "assistant" || archive === undefined
            || archive.record.epoch !== epoch || sourceHistory === null) {
            admitSource(message, entryId);
            return;
        }
        const requiredBoundary = archive.type === "sampling_started"
            ? archive.record.pre_boundary.ordinal
            : archive.record.post_boundary.ordinal;
        if (requiredBoundary < boundary - 1 || sourceHistory.nativeKey(epoch, requiredBoundary) === undefined) {
            admitSource(message, entryId);
            return;
        }
        const nativeKey = ompNativeMessageKey(message);
        if (requiredBoundary === boundary - 1 || (sourceHistory.nativeKey(epoch, boundary) !== undefined
            && sourceHistory.nativeKey(epoch, boundary) !== nativeKey
            && !sourceHistory.hasNativeKey(epoch, nativeKey, boundary, requiredBoundary))) {
            const deferred = deferredSources.get(archive) ?? [];
            deferred.push({ message, entryId });
            deferredSources.set(archive, deferred);
            return;
        }
        admitSource(message, entryId, nativeKey);
    };
    for (let index = resetIndex + 1; index < options.branch.length; index += 1) {
        const entry = options.branch[index];
        if (entry.type === "compaction") {
            if (isRecord(entry.details) && OMP_COMPACT_ENTRY_TYPE in entry.details) {
                if (compactAwaitingNativeEntry)
                    throw new OmpSessionRecoveryError("OMP contains overlapping Spine compact receipts");
                applyCompact(readOmpNativeCompactReceipt(entry), entry.id ?? null);
                continue;
            }
            if (!compactAwaitingNativeEntry) {
                continue;
            }
            if (entry.fromExtension !== true) {
                continue;
            }
            compactAwaitingNativeEntry = false;
            pendingNativeCompaction = null;
            const summary = sources[0];
            if (summary !== undefined &&
                summary.entryId === null &&
                typeof entry.id === "string" &&
                entry.id.length > 0) {
                summary.entryId = entry.id;
            }
            continue;
        }
        if (compactAwaitingNativeEntry) {
            throw new OmpSessionRecoveryError("OMP Spine compact entry was not immediately acknowledged by native compaction");
        }
        if (entry.type === "custom" && entry.customType === OMP_ARCHIVE_ENTRY_TYPE) {
            const archive = decodedArchives.get(index);
            firstArchiveThread ??= archive.record.attempt_id.thread;
            pendingArchives.push(archive);
            flushArchives();
            continue;
        }
        if (entry.type === "custom" && entry.customType === OMP_COMPACT_ENTRY_TYPE) {
            const compact = decodeCompactEntry(entry.data);
            applyCompact(compact, null);
            compactAwaitingNativeEntry = true;
            pendingNativeCompaction = compact;
            continue;
        }
        // Upstream Pi recovery.ts and DSH events.ts replay typed arrival payloads;
        // model-visible arrival text is never parsed for semantics.
        const arrival = entry.type === "custom" && entry.customType === SPINE_ARRIVAL_CUSTOM_TYPE;
        if (arrival && !entry.id)
            throw new OmpSessionRecoveryError("OMP arrival has no native entry ID");
        const messages = arrival ? sessionEntryToOmpMessages(entry) : options.messagesForEntry(entry);
        for (const message of messages) {
            if (!isOmpSourceMessage(message))
                continue;
            const entryId = typeof entry.id === "string" && entry.id.length > 0 ? entry.id : null;
            queueSource(message, entryId, followingArchives.get(index));
        }
    }
    for (const message of options.extraMessages ?? []) {
        if (ompArrivalOf(message) !== undefined) {
            throw new OmpSessionRecoveryError("OMP cannot replay an arrival without its same-branch native entry");
        }
        if (isOmpSourceMessage(message))
            queueSource(message, null, pendingArchives[nextPendingArchive]);
    }
    if (pendingArchives.length !== 0) {
        const archive = pendingArchives[nextPendingArchive];
        throw new OmpSessionRecoveryError(archive.type === "sampling_started"
            ? "OMP sampling-started archive is missing its pre-sampling source"
            : "OMP sampling-commit archive is missing its post-sampling source");
    }
    if (compactAwaitingNativeEntry) {
        const ack = pendingNativeCompaction?.nativeAcknowledgement;
        const firstKept = ack === undefined ? -1 : options.branch.findIndex((entry) => entry.id === ack.firstKeptEntryId);
        if (!options.completePendingNativeCompaction || ack === undefined
            || options.branch.at(-1)?.data !== pendingNativeCompaction
            || firstKept < 0 || firstKept >= options.branch.length - 1
            || (options.extraMessages?.length ?? 0) !== 0) {
            throw new OmpSessionRecoveryError("OMP Spine compact entry is missing its native compaction acknowledgement");
        }
    }
    sourceHistory?.assertReplayComplete();
    if (firstArchiveThread !== null && sourceHistory !== null && firstArchiveThread !== sourceHistory.thread) {
        throw new OmpSessionRecoveryError("OMP canonical Source lineage does not match its first sampling archive");
    }
    const runtimeThread = firstArchiveThread ?? sourceHistory?.thread ?? currentThread;
    return {
        runtimeThread,
        currentThread,
        sourceHistory: sourceHistory ?? new OmpSourceHistory(runtimeThread),
        currentSessionId: options.currentSessionId,
        inputs,
        sources,
        pendingNativeCompaction,
    };
}
export async function recoverOmpSession(options) {
    const bindings = new OmpSourceBindings();
    const runtime = options.runtimeFactory(options.plan.runtimeThread);
    const adapter = await options.adapterFactory(runtime, bindings);
    let source = null;
    await adapter.replayWithSources(options.plan.inputs, async (snapshot) => {
        installSourceBindings(bindings, snapshot, options.plan.sources);
        source = snapshot;
    });
    if (options.plan.runtimeThread !== options.plan.currentThread) {
        source = await adapter.continueNamespace(options.plan.currentThread);
        installSourceBindings(bindings, source, options.plan.sources);
        await adapter.previewAndPublish();
    }
    if (source === null) {
        throw new OmpSessionRecoveryError("Spine replay returned no source snapshot");
    }
    return { adapter, bindings, source };
}
export function installSourceBindings(bindings, source, observations) {
    if (source.cells.length !== observations.length) {
        throw new OmpSessionRecoveryError(`Spine source snapshot has ${source.cells.length} cells for ${observations.length} OMP messages`);
    }
    const byBoundary = new Map();
    for (const observation of observations) {
        if (byBoundary.has(observation.boundary)) {
            throw new OmpSessionRecoveryError(`OMP replay has duplicate source boundary ${observation.boundary}`);
        }
        byBoundary.set(observation.boundary, observation);
    }
    bindings.clear();
    for (const cell of source.cells) {
        const observation = byBoundary.get(cell.boundary);
        if (observation === undefined) {
            throw new OmpSessionRecoveryError(`Spine source cell ${cell.source_id.ordinal} has unknown boundary ${cell.boundary}`);
        }
        bindings.bind(cell.source_id, observation.message, observation.entryId);
    }
}
function decodeArchiveEntry(value) {
    if (!isRecord(value) || value.schema !== OMP_ADAPTER_ID) {
        throw new OmpSessionRecoveryError("OMP Spine archive has an invalid adapter schema");
    }
    if (typeof value.durabilityId !== "string" || value.durabilityId.length === 0) {
        throw new OmpSessionRecoveryError("OMP Spine archive has no durability ID");
    }
    if (!isRecord(value.record) || !isRecord(value.record.record)) {
        throw new OmpSessionRecoveryError("OMP Spine archive has no typed record");
    }
    if (value.record.type !== "sampling_started" &&
        value.record.type !== "sampling_commit") {
        throw new OmpSessionRecoveryError("OMP Spine archive has an unknown record type");
    }
    const inner = value.record.record;
    if (!isRecord(inner.attempt_id) ||
        typeof inner.attempt_id.thread !== "string" ||
        typeof inner.attempt_id.value !== "string" ||
        inner.attempt_id.value.length === 0) {
        throw new OmpSessionRecoveryError("OMP Spine archive identity is inconsistent");
    }
    if (value.record.type === "sampling_started") {
        if (inner.schema !== "spine.sampling.started" ||
            !Number.isSafeInteger(inner.epoch) ||
            inner.epoch < 0 ||
            !isRecord(inner.pre_boundary) ||
            typeof inner.pre_boundary.thread !== "string" ||
            !Number.isSafeInteger(inner.pre_boundary.epoch) ||
            inner.pre_boundary.epoch < 0 ||
            !Number.isSafeInteger(inner.pre_boundary.ordinal) ||
            inner.pre_boundary.ordinal < 0 ||
            (inner.previous_commit_id !== null &&
                (!isRecord(inner.previous_commit_id) ||
                    typeof inner.previous_commit_id.thread !== "string" ||
                    typeof inner.previous_commit_id.value !== "string" ||
                    inner.previous_commit_id.value.length === 0)) ||
            (inner.prompt_digest !== undefined && typeof inner.prompt_digest !== "string") ||
            (inner.source_digest !== undefined && typeof inner.source_digest !== "string") ||
            (inner.record_digest !== undefined && typeof inner.record_digest !== "string")) {
            throw new OmpSessionRecoveryError("OMP sampling-started archive is malformed");
        }
    }
    if (value.record.type === "sampling_commit") {
        if (inner.schema !== "spine.sampling.commit" ||
            !isRecord(inner.post_boundary) ||
            !Number.isSafeInteger(inner.post_boundary.ordinal) ||
            inner.post_boundary.ordinal < 0 ||
            !Array.isArray(inner.executions) ||
            inner.executions.some((execution) => !isRecord(execution) || !isRecord(execution.operation) ||
                "terminal_results" in execution.operation) ||
            !isRecord(inner.commit_id) ||
            typeof inner.commit_id.value !== "string" ||
            inner.commit_id.value.length === 0) {
            throw new OmpSessionRecoveryError("OMP Spine archive identity is inconsistent");
        }
    }
    const record = value.record;
    if (!archiveIdentityMatches(value.durabilityId, record)) {
        throw new OmpSessionRecoveryError("OMP Spine archive identity is inconsistent");
    }
    return value;
}
function archiveIdentityMatches(durabilityId, record) {
    return durabilityId === archiveRecordId(record);
}
/** A stock OMP acknowledgement carries the Spine barrier in the same journal entry. */
export function readOmpNativeCompactReceipt(entry) {
    assertOmpV3ReplayBranch([entry]);
    if (!isRecord(entry.details) || !(OMP_COMPACT_ENTRY_TYPE in entry.details))
        return null;
    const compact = decodeCompactEntry(entry.details[OMP_COMPACT_ENTRY_TYPE]);
    const summary = compact.replacementMessages[0];
    if (entry.type !== "compaction" || entry.fromExtension !== true || typeof entry.id !== "string"
        || !compact.nativeAcknowledgement || entry.firstKeptEntryId !== compact.nativeAcknowledgement.firstKeptEntryId
        || (compact.preparedLeafId !== undefined && compact.preparedLeafId !== entry.parentId)
        || entry.tokensBefore !== compact.nativeAcknowledgement.tokensBefore
        || !isRecord(summary) || entry.summary !== summary.summary) {
        throw new OmpSessionRecoveryError("OMP native compaction receipt does not match its Spine barrier");
    }
    return compact;
}
function decodeCompactEntry(value) {
    if (!isRecord(value) ||
        value.schema !== OMP_ADAPTER_ID ||
        !isRecord(value.barrier) ||
        value.barrier.schema !== "spine.compact.barrier.v1" ||
        !Array.isArray(value.barrier.replacement_boundaries) ||
        !value.barrier.replacement_boundaries.every((boundary) => Number.isSafeInteger(boundary) && boundary >= 0) ||
        !Array.isArray(value.replacementMessages)) {
        throw new OmpSessionRecoveryError("OMP Spine compact entry is malformed");
    }
    if (value.preparedLeafId !== undefined && (typeof value.preparedLeafId !== "string" || !value.preparedLeafId)) {
        throw new OmpSessionRecoveryError("OMP Spine compact preparation leaf is malformed");
    }
    if (value.replacementEntryIds !== undefined) {
        if (!Array.isArray(value.replacementEntryIds) ||
            value.replacementEntryIds.length !== value.replacementMessages.length) {
            throw new OmpSessionRecoveryError("OMP Spine compact replacement entry ids do not match replacement messages");
        }
        for (const entryId of value.replacementEntryIds) {
            if (entryId !== null && (typeof entryId !== "string" || entryId.length === 0)) {
                throw new OmpSessionRecoveryError("OMP Spine compact replacement entry id is malformed");
            }
        }
    }
    if (value.nativeAcknowledgement !== undefined) {
        const ack = value.nativeAcknowledgement;
        const summary = value.replacementMessages[0];
        if (!isRecord(ack) || typeof ack.firstKeptEntryId !== "string" || ack.firstKeptEntryId.length === 0
            || typeof ack.tokensBefore !== "number" || !Number.isFinite(ack.tokensBefore) || ack.tokensBefore < 0
            || !isRecord(summary) || summary.role !== "compactionSummary" || typeof summary.summary !== "string"
            || summary.tokensBefore !== ack.tokensBefore) {
            throw new OmpSessionRecoveryError("OMP Spine native compaction acknowledgement is malformed");
        }
    }
    return value;
}
function storedEntryId(entryIds, index) {
    const entryId = entryIds?.[index];
    return typeof entryId === "string" && entryId.length > 0 ? entryId : null;
}
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
//# sourceMappingURL=recovery.js.map