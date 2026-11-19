import type {
  ContextItem,
  ContextPlanCell,
  EpochOrdinalId,
  SourceCharacter,
  SpawnArrival,
} from "@spinejit/spine-sdk";
import {
  spineArrivalText,
  spineBirthText,
  spineMemoryText,
  spineNodeText,
  type PublishedContext,
} from "@spinejit/spine-sdk/host";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";

interface OmpTextContent {
  type: "text";
  text: string;
}

interface OmpImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

interface OmpToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

interface OmpThinkingContent {
  type: "thinking";
  thinking: string;
}

interface OmpRedactedThinkingContent {
  type: "redactedThinking";
  data: string;
}

export const SPINE_ARRIVAL_CUSTOM_TYPE = "spine-arrival";
export const SPINE_ARRIVAL_WAKE_CUSTOM_TYPE = "spine-arrival-wake";
export const OMP_SPINE_NODE_MESSAGE_TYPE = "spine.node";
export const OMP_SPINE_MEMORY_MESSAGE_TYPE = "spine.memory";
export const OMP_SPINE_BIRTH_MESSAGE_TYPE = "spine.birth";
export const OMP_PROJECTION_SCHEMA = "spine.omp.projection/v1";

export interface OmpSpineProjectionDetails {
  schema: typeof OMP_PROJECTION_SCHEMA;
  kind: "node" | "memory" | "birth";
  nodeId: string;
  status?: string;
  renderer: "xml";
}

export type OmpAgentMessage =
  | {
      role: "system";
      content: string | OmpTextContent[];
      timestamp: number;
      [key: string]: unknown;
    }
  | {
      role: "user";
      content: string | Array<OmpTextContent | OmpImageContent>;
      timestamp: number;
      attribution?: "user" | "agent";
    }
  | {
      role: "assistant";
      content: Array<OmpTextContent | OmpThinkingContent | OmpRedactedThinkingContent | OmpToolCall>;
      [key: string]: unknown;
    }
  | {
      role: "toolResult";
      toolCallId: string;
      toolName: string;
      content: Array<OmpTextContent | OmpImageContent>;
      isError: boolean;
      timestamp: number;
      [key: string]: unknown;
    }
  | {
      role: "custom";
      customType: string;
      content: string | Array<OmpTextContent | OmpImageContent>;
      display: boolean;
      timestamp: number;
      details?: unknown;
    }
  | {
      role: "bashExecution";
      command: string;
      output: string;
      exitCode: number | undefined;
      cancelled: boolean;
      truncated: boolean;
      timestamp: number;
      excludeFromContext?: boolean;
      fullOutputPath?: string;
    }
  | { role: "branchSummary"; summary: string; fromId: string; timestamp: number }
  | { role: "compactionSummary"; summary: string; tokensBefore: number; timestamp: number }
  | { role: "developer"; content: string | Array<OmpTextContent | OmpImageContent>; timestamp: number; [key: string]: unknown }
  | { role: "pythonExecution"; timestamp: number; [key: string]: unknown }
  | { role: "fileMention"; timestamp: number; [key: string]: unknown }
  | { role: "hookMessage"; timestamp: number; [key: string]: unknown };

interface TextPart {
  type: "text";
  text: string;
}

export interface OmpSourceObservation {
  character: SourceCharacter;
  message: OmpAgentMessage;
}

export class OmpContextMaterializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OmpContextMaterializationError";
  }
}

/** OMP owns prompt sections and tool declarations. They are not conversation sources. */
export function isOmpHostSystemMessage(message: { role: string }): boolean {
  return message.role === "system";
}

/** Branch state is rendered by the native builder, not copied from stale live history. */
export function isOmpBranchStateMessage(message: OmpAgentMessage): boolean {
  return message.role === "custom" && message.customType === "experimental_context_notes";
}

/** The append-only `custom` entry carries the SDK payload, never rendered text. */
export function extractOmpArrival(entry: SessionEntry): SpawnArrival | undefined {
  if (entry.type !== "custom" || entry.customType !== SPINE_ARRIVAL_CUSTOM_TYPE) return undefined;
  return requireArrival(entry.data);
}

export function ompArrivalMessage(
  arrival: SpawnArrival,
  timestamp: number,
): Extract<OmpAgentMessage, { role: "custom" }> {
  return {
    role: "custom",
    customType: SPINE_ARRIVAL_CUSTOM_TYPE,
    content: spineArrivalText(arrival),
    display: false,
    timestamp,
    details: arrival,
  };
}

export function ompArrivalOf(message: OmpAgentMessage): SpawnArrival | undefined {
  if (message.role !== "custom" || message.customType !== SPINE_ARRIVAL_CUSTOM_TYPE) return undefined;
  return requireArrival(message.details);
}

function requireArrival(value: unknown): SpawnArrival {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const { producer, outcome, memory, diagnostic, execution_ref } = value as Partial<SpawnArrival>;
    if (Array.isArray(producer) && producer.length > 0
      && producer.every((part) => Number.isSafeInteger(part) && part >= 0)
      && (outcome === "completed" ? typeof memory === "string"
        : (outcome === "errored" || outcome === "aborted") && typeof diagnostic === "string")
      && (memory == null || typeof memory === "string")
      && (diagnostic == null || typeof diagnostic === "string")
      && (execution_ref == null || typeof execution_ref === "string")) {
      return value as SpawnArrival;
    }
  }
  throw new OmpContextMaterializationError("Malformed durable OMP Spawn arrival");
}

/** One admission policy for the live adapter and durable replay. */
export function isOmpSourceMessage(message: OmpAgentMessage): boolean {
  return !isOmpHostSystemMessage(message)
    && message.role !== "toolResult"
    && !(message.role === "custom" && (message.customType === "eval-state-context"
      || message.customType === SPINE_ARRIVAL_WAKE_CUSTOM_TYPE))
    && !isOmpBranchStateMessage(message)
    && !isOmpSpineProjection(message);
}

export function sourceObservation(
  message: OmpAgentMessage,
  boundary: number,
): OmpSourceObservation {
  if (message.role === "toolResult") {
    return { character: { type: "opaque", boundary }, message };
  }
  const arrival = ompArrivalOf(message);
  if (arrival !== undefined) return { character: { type: "arrival", boundary, arrival }, message };
  const role = sourceRole(message);
  return {
    character: {
      type: "message",
      boundary,
      role,
      content: sourceCharacterContent(message),
    },
    message,
  };
}

function sourceCharacterContent(message: OmpAgentMessage): string {
  const content = "content" in message ? message.content : undefined;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const part of content) {
    if (part.type === "text") {
      parts.push(part.text);
    } else if (part.type === "image") {
      parts.push("<image>");
    }
  }
  return parts.join("");
}

/** Native surgery changes content, not these persisted message identity fields. */
export function ompNativeMessageKey(message: OmpAgentMessage): string {
  const arrival = ompArrivalOf(message);
  if (arrival !== undefined) return JSON.stringify([
    SPINE_ARRIVAL_CUSTOM_TYPE, arrival.producer, arrival.outcome,
    arrival.memory ?? null, arrival.diagnostic ?? null, arrival.execution_ref ?? null,
  ]);
  const calls: string[] = [];
  if (message.role === "assistant") {
    for (const part of message.content) {
      if (part.type === "toolCall") calls.push(assistantToolCallId(message, part.id));
    }
  }
  return JSON.stringify([
    message.role,
    "timestamp" in message ? message.timestamp : null,
    message.role === "user" ? message.attribution ?? null : null,
    message.role === "custom" ? message.customType : null,
    message.role === "assistant" ? message.provider ?? null : null,
    message.role === "assistant" ? message.model ?? null : null,
    message.role === "assistant" ? message.responseId ?? null : null,
    message.role === "assistant" ? calls : null,
  ]);
}

/** The Responses item suffix is replay metadata, not the call's durable identity. */
export function assistantToolCallId(message: Extract<OmpAgentMessage, { role: "assistant" }>, id: string): string {
  const suffix = id.indexOf("|");
  if (suffix < 0 || (typeof message.api === "string" && message.api.startsWith("google-"))) return id;
  return id.slice(0, suffix);
}

interface BoundOmpSource {
  message: OmpAgentMessage;
  entryId: string | null;
  nativeKey: string;
}

export class OmpSourceBindings {
  readonly #messages = new Map<string, BoundOmpSource>();

  bind(sourceId: EpochOrdinalId, message: OmpAgentMessage, entryId: string | null = null): void {
    const key = sourceIdKey(sourceId);
    if (this.#messages.has(key)) {
      throw new OmpContextMaterializationError(`duplicate OMP source binding ${key}`);
    }
    this.#messages.set(key, { message: structuredClone(message), entryId, nativeKey: ompNativeMessageKey(message) });
  }

  resolve(sourceId: EpochOrdinalId): OmpAgentMessage {
    return structuredClone(this.#require(sourceId).message);
  }

  entryId(sourceId: EpochOrdinalId): string | null {
    return this.#require(sourceId).entryId;
  }

  identity(sourceId: EpochOrdinalId): string {
    return this.#require(sourceId).nativeKey;
  }

  assignEntryId(sourceId: EpochOrdinalId, entryId: string | null): void {
    if (!entryId) return;
    const record = this.#require(sourceId);
    if (record.entryId !== null && record.entryId !== entryId) {
      throw new OmpContextMaterializationError(`OMP source entry changed from ${record.entryId} to ${entryId}`);
    }
    record.entryId = entryId;
  }

  /** Fill entry ids that were not known when the source was observed. Length must match. */
  assignEntryIds(entryIds: readonly (string | null)[]): void {
    const records = [...this.#messages.values()];
    if (records.length !== entryIds.length) return;
    for (let index = 0; index < records.length; index += 1) {
      const entryId = entryIds[index];
      const record = records[index]!;
      if (record.entryId === null && typeof entryId === "string" && entryId.length > 0) {
        record.entryId = entryId;
      }
    }
  }

  clear(): void {
    this.#messages.clear();
  }

  #require(sourceId: EpochOrdinalId): BoundOmpSource {
    const record = this.#messages.get(sourceIdKey(sourceId));
    if (record === undefined) {
      throw new OmpContextMaterializationError(
        `missing OMP message for source ${sourceIdKey(sourceId)}`,
      );
    }
    return record;
  }
}

export interface OmpContextMaterializationOptions {
  nodePrompt?: string;
  /** Model-visible messages for a session entry. An empty list omits that entry. */
  projectedMessages?: ReadonlyMap<string, readonly OmpAgentMessage[]>;
}

export function materializeOmpContext(
  context: PublishedContext,
  bindings: OmpSourceBindings,
  options: OmpContextMaterializationOptions = {},
): OmpAgentMessage[] {
  const plan = context.contextPlan;
  if (plan === null) {
    return [];
  }

  const messages: OmpAgentMessage[] = [];
  const projectedIndex = new Map<string, number>();
  const renamedCalls = new Map<string, string>();
  for (const cell of plan.cells) {
    if (cell.type === "source") {
      const entryId = bindings.entryId(cell.source_id);
      const projected = entryId === null ? undefined : options.projectedMessages?.get(entryId);
      let message: OmpAgentMessage;
      if (projected !== undefined) {
        const index = projectedIndex.get(entryId!) ?? 0;
        projectedIndex.set(entryId!, index + 1);
        const replacement = projected[index];
        if (replacement === undefined) continue;
        message = structuredClone(replacement);
      } else {
        message = bindings.resolve(cell.source_id);
      }
      for (const label of cell.labels) {
        if (label === "WithoutReasoning") {
          message = withoutReasoning(message, renamedCalls);
        } else {
          if (message.role !== "user") {
            const original = bindings.resolve(cell.source_id);
            if (original.role === "user") message = original;
          }
          if (message.role === "user") message = prependUserAnchor(message, label.UserAnchor);
        }
      }
      if (message.role === "toolResult") {
        const callId = renamedCalls.get(message.toolCallId);
        if (callId !== undefined) message = { ...message, toolCallId: callId };
      }

      messages.push(message);
      continue;
    }
    messages.push(materializeProjection(cell, options.nodePrompt ?? ""));
  }
  return messages;
}

function materializeProjection(
  cell: Extract<ContextPlanCell, { type: "projection" }>,
  nodePrompt: string,
): OmpAgentMessage {
  const item = cell.item;
  if ("SyntheticNode" in item) {
    const { node_id: nodeId, summary, status } = item.SyntheticNode;
    const id = nodeId.join(".");
    return spineProjectionMessage(
      OMP_SPINE_NODE_MESSAGE_TYPE,
      spineNodeText(nodeId, summary, status, nodePrompt),
      {
        schema: OMP_PROJECTION_SCHEMA,
        kind: "node",
        nodeId: id,
        status: status.toLowerCase(),
        renderer: "xml",
      },
    );
  }
  if ("MemorySlot" in item) {
    const slot = item.MemorySlot;
    if ("Summary" in slot) {
      const nodeId = slot.Summary.owner_node.join(".");
      return spineProjectionMessage(
        OMP_SPINE_MEMORY_MESSAGE_TYPE,
        spineMemoryText(slot.Summary.owner_node, slot.Summary.body),
        {
          schema: OMP_PROJECTION_SCHEMA,
          kind: "memory",
          nodeId,
          renderer: "xml",
        },
      );
    }
    if ("Birth" in slot) {
      const { owner_node: owner, task } = slot.Birth;
      return spineProjectionMessage(
        OMP_SPINE_BIRTH_MESSAGE_TYPE,
        spineBirthText(owner, task),
        { schema: OMP_PROJECTION_SCHEMA, kind: "birth", nodeId: owner.join("."), renderer: "xml" },
      );
    }
    if ("Arrival" in slot) return ompArrivalMessage(slot.Arrival.arrival, 0);
  }
  throw unsupportedProjection(item);
}


export function isOmpSpineProjection(
  message: OmpAgentMessage,
  customType?: string,
): message is Extract<OmpAgentMessage, { role: "custom" }> {
  if (message.role !== "custom") return false;
  if (customType !== undefined && message.customType !== customType) return false;
  const details = message.details;
  const schema = details !== null && typeof details === "object"
    ? (details as { schema?: unknown }).schema
    : undefined;
  return schema === OMP_PROJECTION_SCHEMA;
}

function unsupportedProjection(item: ContextItem): OmpContextMaterializationError {
  return new OmpContextMaterializationError(
    `OMP cannot materialize Spine projection item ${Object.keys(item)[0] ?? "unknown"}`,
  );
}

/** After a Fold only speech and calls can follow the rewritten prefix. Gemini
 * requires its signatures on the calls in its current turn even then. */
function withoutReasoning(message: OmpAgentMessage, renamedCalls: Map<string, string>): OmpAgentMessage {
  if (message.role !== "assistant") {
    throw new OmpContextMaterializationError(`Spine WithoutReasoning label targets a ${message.role} message`);
  }
  if (typeof message.api === "string" && message.api.startsWith("google-")) return message;
  const copy = { ...message };
  delete copy.providerPayload;
  copy.content = message.content.flatMap((part): typeof message.content => {
    if (part.type === "thinking" || part.type === "redactedThinking") return [];
    const bare = { ...part } as typeof part & { textSignature?: string; thoughtSignature?: string };
    delete bare.textSignature;
    delete bare.thoughtSignature;
    if (bare.type === "toolCall") {
      const callId = assistantToolCallId(message, bare.id);
      if (callId !== bare.id) {
        renamedCalls.set(bare.id, callId);
        bare.id = callId;
      }
    }
    return [bare];
  });
  return copy;
}

function prependUserAnchor(message: OmpAgentMessage, anchor: number): OmpAgentMessage {
  const copy = structuredClone(message);
  if (sourceRole(copy) !== "user") {
    throw new OmpContextMaterializationError(`Spine user anchor U${anchor} targets a non-user message`);
  }

  if (copy.role === "user" || copy.role === "custom") {
    if (typeof copy.content === "string") {
      copy.content = `[U${anchor}]\n${copy.content}`;
      return copy;
    }
    const firstText = copy.content.find((part): part is TextPart => part.type === "text");
    if (firstText !== undefined) {
      firstText.text = `[U${anchor}]\n${firstText.text}`;
    } else {
      copy.content.unshift({ type: "text", text: `[U${anchor}]\n` });
    }
    return copy;
  }

  if (copy.role === "bashExecution") {
    throw new OmpContextMaterializationError(
      `Spine user anchor U${anchor} cannot preserve OMP bashExecution identity`,
    );
  }
  if (copy.role === "branchSummary" || copy.role === "compactionSummary") {
    throw new OmpContextMaterializationError(
      `Spine user anchor U${anchor} cannot target OMP native summary messages`,
    );
  }
  throw new OmpContextMaterializationError(`unknown OMP user message for anchor U${anchor}`);
}

function sourceRole(message: OmpAgentMessage): "user" | "contextual_user" | "assistant" {
  switch (message.role) {
    case "system":
      throw new OmpContextMaterializationError("OMP host system message must not be recorded as a source");
    case "user":
      return "user";
    case "assistant":
      return "assistant";
    case "toolResult":
      throw new OmpContextMaterializationError("OMP tool result must be recorded as opaque source");
    default:
      return "contextual_user";
  }
}

function spineProjectionMessage(
  customType: string,
  content: string,
  details: OmpSpineProjectionDetails,
): OmpAgentMessage {
  return {
    role: "custom",
    customType,
    content,
    display: false,
    timestamp: 0,
    details,
  };
}

function sourceIdKey(id: EpochOrdinalId): string {
  return `${id.thread}\u0000${id.epoch}\u0000${id.ordinal}`;
}
