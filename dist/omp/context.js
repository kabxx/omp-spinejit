import { assistantToolCallId, isOmpHostSystemMessage, ompNativeMessageKey, SPINE_ARRIVAL_CUSTOM_TYPE, SPINE_ARRIVAL_WAKE_CUSTOM_TYPE, } from "./messages.js";
/** Keep the live tool loop and native runtime context, even before a queued user. */
export function liveHostSuffix(host) {
    let lastUser = -1;
    for (let index = 0; index < host.length; index += 1) {
        if (host[index]?.role === "user")
            lastUser = index;
    }
    return host.filter((message, index) => !isOmpHostSystemMessage(message)
        && (index > lastUser || (message.role === "custom" && message.customType === "eval-state-context")));
}
/** Prefer the edited branch view; append only unpersisted event messages. */
export function mergeHostTranscripts(branchMessages, eventMessages, persistedMessages) {
    const branch = branchMessages.filter((message) => !isOmpHostSystemMessage(message));
    if (eventMessages === undefined || eventMessages.length === 0)
        return branch;
    for (const message of unseenHostMessages(branch, eventMessages, persistedMessages))
        branch.push(message);
    return branch;
}
function unseenHostMessages(knownMessages, eventMessages, persistedMessages) {
    const remaining = new Map();
    for (const message of persistedMessages) {
        const key = transcriptOccurrenceKey(message);
        remaining.set(key, (remaining.get(key) ?? 0) + 1);
    }
    if (knownMessages.length > 0) {
        const renderedCounts = new Map();
        for (const message of knownMessages) {
            if (isOmpHostSystemMessage(message))
                continue;
            const key = transcriptOccurrenceKey(message);
            const count = (renderedCounts.get(key) ?? 0) + 1;
            renderedCounts.set(key, count);
            if (count > (remaining.get(key) ?? 0))
                remaining.set(key, count);
        }
    }
    const extra = [];
    for (const message of eventMessages) {
        if (isOmpHostSystemMessage(message))
            continue;
        const key = transcriptOccurrenceKey(message);
        const count = remaining.get(key) ?? 0;
        if (count > 0)
            remaining.set(key, count - 1);
        else
            extra.push(message);
    }
    return extra;
}
/** Keep the plan's ordering and labels. Restore only transient native suffix
 * messages and results whose corresponding assistant survived projection. */
export function spliceLiveHostTranscript(projected, host, persisted = []) {
    if (host === undefined || host.length === 0)
        return [...projected];
    const transient = unseenHostMessages(projected, host, persisted);
    const additions = [];
    // Count occurrences over the whole transcript before considering the suffix.
    // An older equal-looking row must not suppress a new live occurrence.
    const suffix = liveHostSuffix(host);
    const tail = new Map();
    for (const message of suffix)
        tail.set(message, (tail.get(message) ?? 0) + 1);
    for (const message of transient) {
        const count = tail.get(message) ?? 0;
        if (count === 0 || message.role === "toolResult")
            continue;
        tail.set(message, count - 1);
        if (message.role === "custom" && (message.customType === SPINE_ARRIVAL_CUSTOM_TYPE
            || message.customType === SPINE_ARRIVAL_WAKE_CUSTOM_TYPE))
            continue;
        additions.push(message);
    }
    const callers = new Map();
    const replies = new Map();
    for (const message of host) {
        if (message.role === "assistant") {
            const key = messageKey(message);
            for (const part of message.content) {
                if (part.type === "toolCall")
                    callers.set(part.id, { key, canonicalId: assistantToolCallId(message, part.id) });
            }
        }
        else if (message.role === "toolResult") {
            const caller = callers.get(message.toolCallId);
            if (caller === undefined)
                continue;
            const group = replies.get(caller.key) ?? [];
            group.push({ message, canonicalId: caller.canonicalId });
            replies.set(caller.key, group);
            callers.delete(message.toolCallId);
        }
    }
    const merged = [...projected, ...additions];
    const seen = new Set(merged.filter((message) => message.role === "toolResult").map(messageKey));
    const messages = [];
    for (const message of merged) {
        messages.push(message);
        if (message.role !== "assistant")
            continue;
        const calls = new Set(message.content.flatMap((part) => part.type === "toolCall" ? [part.id] : []));
        for (const { message: reply, canonicalId } of replies.get(messageKey(message)) ?? []) {
            const id = calls.has(reply.toolCallId) ? reply.toolCallId : canonicalId;
            if (!calls.has(id))
                continue;
            const paired = id === reply.toolCallId ? reply : { ...reply, toolCallId: id };
            const key = messageKey(paired);
            if (seen.has(key))
                continue;
            messages.push(paired);
            seen.add(key);
        }
    }
    return messages;
}
function messageKey(message) {
    if (message.role === "toolResult")
        return `tr:${message.toolCallId}:${message.timestamp}`;
    if (message.role === "assistant")
        return ompNativeMessageKey(message);
    if (message.role === "user")
        return `u:${message.timestamp}:${JSON.stringify(message.content)}`;
    return `${message.role}:${"timestamp" in message ? message.timestamp : ""}:${message.role === "custom" ? message.customType : ""}`;
}
function transcriptOccurrenceKey(message) {
    // Native custom persistence can stamp a new wall clock. Reconcile its payload
    // by occurrence count; keep the durable timestamp for canonical Source.
    if (message.role === "custom")
        return JSON.stringify([
            "custom", message.customType, message.content, message.display, message.details ?? null,
            ("attribution" in message ? message.attribution : undefined) ?? "agent",
        ]);
    return messageKey(message);
}
//# sourceMappingURL=context.js.map