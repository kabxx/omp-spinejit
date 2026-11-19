import { childState } from "@spinejit/spine-sdk/host";
import { readChildSession } from "./child-session.js";
import { sessionEntryToOmpMessages } from "./host-projection.js";
import { isOmpSourceMessage, ompArrivalOf } from "./messages.js";
import { OMP_ARCHIVE_ENTRY_TYPE } from "./protocol.js";
import { buildOmpReplayPlan } from "./recovery.js";
/** Read only the child's active, native journal branch; the event stream never supplies memory. */
export async function readChildState(path, expectedId) {
    const { id, branch, ownEntries, complete } = await readChildSession(path, expectedId);
    const log = [];
    const joined = new Set();
    let pending = 0;
    let lastEntryId = null;
    let lastSamplingIndex = -1;
    let candidate = null;
    let diagnostic = null;
    let fault = null;
    for (let index = 0; index < ownEntries.length; index += 1) {
        const entry = ownEntries[index];
        if (entry.type === "custom" && entry.customType === "spine.fault.v1") {
            const data = entry.data;
            fault = data?.errors?.[0]?.message?.trim() || "OMP Spine child encountered a durability fault";
        }
        if (entry.type === "custom" && entry.customType === OMP_ARCHIVE_ENTRY_TYPE) {
            lastSamplingIndex = index;
            const archive = entry.data?.record;
            if (archive?.type === "sampling_commit") {
                for (const execution of archive.record.executions) {
                    if (execution.operation.type === "spawn") {
                        const births = execution.operation.tasks.length;
                        pending += births;
                        log.push({ type: "spawn", births });
                    }
                }
            }
        }
        for (const message of sessionEntryToOmpMessages(entry)) {
            if (message.role !== "toolResult" && (!isOmpSourceMessage(message)
                || message.role === "compactionSummary" || message.role === "branchSummary"))
                continue;
            lastEntryId = entry.id;
            candidate = null;
            diagnostic = null;
            if (message.role === "user")
                fault = null;
            const arrival = ompArrivalOf(message);
            // Inherited arrivals are in the prefix. Child-local producers are in
            // this fork's namespace and need not have the child's own id as a prefix.
            if (arrival !== undefined && pending > 0) {
                const key = arrival.producer.join(".");
                if (!joined.has(key)) {
                    joined.add(key);
                    pending -= 1;
                    log.push({ type: "arrival" });
                    continue;
                }
            }
            if (message.role === "assistant" && message.stopReason === "error") {
                const error = typeof message.errorMessage === "string" ? message.errorMessage.trim() : "";
                diagnostic = error || "OMP model request ended with stopReason error";
                log.push({ type: "error", message: diagnostic });
                continue;
            }
            if (message.role === "assistant") {
                const text = finalReplyText(message);
                if (text !== null)
                    candidate = { text, entryId: entry.id };
            }
            log.push({ type: "other" });
        }
    }
    if (candidate !== null && complete && fault === null) {
        try {
            // Compaction after the last sampling does not replace its conversational
            // end. Validate against the exact pre-compaction replay instead.
            const start = branch.length - ownEntries.length;
            const replyIndex = branch.findIndex((entry) => entry.id === candidate?.entryId);
            const afterSampling = Math.max(replyIndex, start + lastSamplingIndex) + 1;
            const compact = branch.findIndex((entry, index) => index >= afterSampling && entry.type === "compaction");
            const plan = buildOmpReplayPlan({
                currentSessionId: id,
                branch: compact < 0 ? branch : branch.slice(0, compact),
                messagesForEntry: (entry) => sessionEntryToOmpMessages(entry),
            });
            const tail = plan.sources.at(-1);
            const last = plan.inputs.at(-1);
            // Native messages can hit disk before Spine commits. Match the reply to
            // the exact replay-validated source tail, not physical JSONL ordering.
            if (tail?.entryId === candidate.entryId && last?.type === "archive" && last.record.type === "sampling_commit"
                && last.record.record.terminal === undefined && last.record.record.post_boundary.ordinal === tail.boundary) {
                log.push({ type: "reply", text: candidate.text });
            }
        }
        catch (cause) {
            diagnostic = cause instanceof Error ? cause.message : String(cause);
        }
    }
    if (fault !== null) {
        diagnostic = fault;
        log.push({ type: "error", message: fault });
    }
    else if (!complete) {
        log.push({ type: "other" });
    }
    const state = childState(log);
    return { ...state, lastEntryId, diagnostic };
}
function finalReplyText(message) {
    if (message.stopReason !== "stop" || !Array.isArray(message.content) || message.content.some((part) => part.type === "toolCall"))
        return null;
    const text = message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
    return text.trim() ? text : null;
}
//# sourceMappingURL=child-memory.js.map