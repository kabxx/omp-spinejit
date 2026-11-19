import { buildSessionContext } from "@oh-my-pi/pi-coding-agent";
import { createBranchSummaryMessage, createCompactionSummaryMessage, createCustomMessage } from "@oh-my-pi/pi-agent-core/compaction/messages";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { extractOmpArrival, ompArrivalMessage, ompNativeMessageKey, type OmpAgentMessage } from "./messages.js";
import type { OmpBranchEntry } from "./recovery.js";

const SOURCE_ENTRY = Symbol("spine.omp.source-entry");
type TaggedMessage = OmpAgentMessage & { [SOURCE_ENTRY]?: string };

export interface OmpSessionProjection {
  entries: { sourceEntry: SessionEntry; messages: OmpAgentMessage[] }[];
  messages: OmpAgentMessage[];
  /** Native state-derived injections have no durable conversation Source entry. */
  generatedMessages: OmpAgentMessage[];
}

/** Expand raw persisted entries without applying whole-branch context filtering. */
export function sessionEntryToOmpMessages(entry: SessionEntry): OmpAgentMessage[] {
  const arrival = extractOmpArrival(entry);
  if (arrival !== undefined) return [ompArrivalMessage(arrival, new Date(entry.timestamp).getTime())];
  if (entry.type === "message") {
    const message = entry.message;
    if ((message.role === "user" || message.role === "assistant" || message.role === "toolResult" || message.role === "custom") && message.content == null) {
      return [{ ...message, content: [] } as OmpAgentMessage];
    }
    return [message as OmpAgentMessage];
  }
  if (entry.type === "custom_message") {
    return [createCustomMessage(entry.customType, entry.content ?? [], entry.display, entry.details, entry.timestamp, entry.attribution) as OmpAgentMessage];
  }
  if (entry.type === "branch_summary" && entry.summary) {
    return [createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp) as OmpAgentMessage];
  }
  if (entry.type === "compaction") {
    return [createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp) as OmpAgentMessage];
  }
  return [];
}

/** Keep provenance while the native OMP builder applies compaction, reset, and retry filtering. */
export function projectOmpSession(branch: readonly OmpBranchEntry[]): OmpSessionProjection {
  const entries = branch as readonly SessionEntry[];
  const annotated = entries.map((entry) => {
    const arrival = extractOmpArrival(entry);
    if (arrival !== undefined) {
      // The native builder ignores custom data. Present its typed message to
      // that builder so reset boundaries and compacted tails apply as usual.
      const message = { ...ompArrivalMessage(arrival, new Date(entry.timestamp).getTime()), [SOURCE_ENTRY]: entry.id };
      return { ...entry, type: "message" as const, message };
    }
    if (entry.type !== "message") return entry;
    const message = { ...entry.message, [SOURCE_ENTRY]: entry.id };
    return { ...entry, message };
  });
  const projected = entries.map((sourceEntry) => ({ sourceEntry, messages: [] as OmpAgentMessage[] }));
  const byId = new Map(projected.map((entry) => [entry.sourceEntry.id, entry]));
  const candidates = new Map<string, string[]>();
  for (const entry of entries) {
    if (entry.type === "message" || extractOmpArrival(entry) !== undefined) continue;
    for (const message of sessionEntryToOmpMessages(entry)) {
      const key = messageKey(message);
      const ids = candidates.get(key) ?? [];
      ids.push(entry.id);
      candidates.set(key, ids);
    }
  }
  const context = buildSessionContext(annotated as SessionEntry[]);
  const messages: OmpAgentMessage[] = [];
  const generatedMessages: OmpAgentMessage[] = [];
  for (const value of context.messages) {
    const message = value as TaggedMessage;
    const entryId = message[SOURCE_ENTRY] ?? candidates.get(messageKey(message))?.shift();
    if (message[SOURCE_ENTRY] !== undefined) delete message[SOURCE_ENTRY];
    if (entryId !== undefined) byId.get(entryId)?.messages.push(message);
    else generatedMessages.push(message);
    messages.push(message);
  }
  return { entries: projected, messages, generatedMessages };
}

/** Keep state-derived native messages even when their surrounding Sources are summarized. */
export function spliceOmpGeneratedContext(
  messages: OmpAgentMessage[],
  projection: OmpSessionProjection,
): OmpAgentMessage[] {
  if (projection.generatedMessages.length === 0) return messages;
  const generated = new Set(projection.generatedMessages);
  const positions = new Map<string, number>();
  for (let index = 0; index < messages.length; index += 1) {
    positions.set(ompNativeMessageKey(messages[index]!), index);
  }
  const injections = new Map<number, OmpAgentMessage[]>();
  let previous = -1;
  for (const message of projection.messages) {
    const position = positions.get(ompNativeMessageKey(message));
    if (generated.has(message)) {
      if (position !== undefined) continue;
      const insertion = previous + 1;
      const group = injections.get(insertion) ?? [];
      group.push(message);
      injections.set(insertion, group);
    } else if (position !== undefined) previous = position;
  }
  if (injections.size === 0) return messages;
  const result: OmpAgentMessage[] = [];
  for (let index = 0; index <= messages.length; index += 1) {
    const group = injections.get(index);
    if (group !== undefined) result.push(...group);
    if (index < messages.length) result.push(messages[index]!);
  }
  return result;
}

function messageKey(message: OmpAgentMessage): string {
  if (message.role === "branchSummary") return JSON.stringify([message.role, message.timestamp, message.fromId]);
  if (message.role === "custom") return JSON.stringify([ompNativeMessageKey(message), message.content, message.details]);
  if (message.role === "compactionSummary") return JSON.stringify([message.role, message.timestamp, message.tokensBefore, message.summary]);
  return ompNativeMessageKey(message);
}
