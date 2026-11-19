import type { EpochOrdinalId, SourceCharacter, SpawnArrival } from "@spinejit/spine-sdk";
import { type PublishedContext } from "@spinejit/spine-sdk/host";
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
export declare const SPINE_ARRIVAL_CUSTOM_TYPE = "spine-arrival";
export declare const SPINE_ARRIVAL_WAKE_CUSTOM_TYPE = "spine-arrival-wake";
export declare const OMP_SPINE_NODE_MESSAGE_TYPE = "spine.node";
export declare const OMP_SPINE_MEMORY_MESSAGE_TYPE = "spine.memory";
export declare const OMP_SPINE_BIRTH_MESSAGE_TYPE = "spine.birth";
export declare const OMP_PROJECTION_SCHEMA = "spine.omp.projection/v1";
export interface OmpSpineProjectionDetails {
    schema: typeof OMP_PROJECTION_SCHEMA;
    kind: "node" | "memory" | "birth";
    nodeId: string;
    status?: string;
    renderer: "xml";
}
export type OmpAgentMessage = {
    role: "system";
    content: string | OmpTextContent[];
    timestamp: number;
    [key: string]: unknown;
} | {
    role: "user";
    content: string | Array<OmpTextContent | OmpImageContent>;
    timestamp: number;
    attribution?: "user" | "agent";
} | {
    role: "assistant";
    content: Array<OmpTextContent | OmpThinkingContent | OmpRedactedThinkingContent | OmpToolCall>;
    [key: string]: unknown;
} | {
    role: "toolResult";
    toolCallId: string;
    toolName: string;
    content: Array<OmpTextContent | OmpImageContent>;
    isError: boolean;
    timestamp: number;
    [key: string]: unknown;
} | {
    role: "custom";
    customType: string;
    content: string | Array<OmpTextContent | OmpImageContent>;
    display: boolean;
    timestamp: number;
    details?: unknown;
} | {
    role: "bashExecution";
    command: string;
    output: string;
    exitCode: number | undefined;
    cancelled: boolean;
    truncated: boolean;
    timestamp: number;
    excludeFromContext?: boolean;
    fullOutputPath?: string;
} | {
    role: "branchSummary";
    summary: string;
    fromId: string;
    timestamp: number;
} | {
    role: "compactionSummary";
    summary: string;
    tokensBefore: number;
    timestamp: number;
} | {
    role: "developer";
    content: string | Array<OmpTextContent | OmpImageContent>;
    timestamp: number;
    [key: string]: unknown;
} | {
    role: "pythonExecution";
    timestamp: number;
    [key: string]: unknown;
} | {
    role: "fileMention";
    timestamp: number;
    [key: string]: unknown;
} | {
    role: "hookMessage";
    timestamp: number;
    [key: string]: unknown;
};
export interface OmpSourceObservation {
    character: SourceCharacter;
    message: OmpAgentMessage;
}
export declare class OmpContextMaterializationError extends Error {
    constructor(message: string);
}
/** OMP owns prompt sections and tool declarations. They are not conversation sources. */
export declare function isOmpHostSystemMessage(message: {
    role: string;
}): boolean;
/** Branch state is rendered by the native builder, not copied from stale live history. */
export declare function isOmpBranchStateMessage(message: OmpAgentMessage): boolean;
/** The append-only `custom` entry carries the SDK payload, never rendered text. */
export declare function extractOmpArrival(entry: SessionEntry): SpawnArrival | undefined;
export declare function ompArrivalMessage(arrival: SpawnArrival, timestamp: number): Extract<OmpAgentMessage, {
    role: "custom";
}>;
export declare function ompArrivalOf(message: OmpAgentMessage): SpawnArrival | undefined;
/** One admission policy for the live adapter and durable replay. */
export declare function isOmpSourceMessage(message: OmpAgentMessage): boolean;
export declare function sourceObservation(message: OmpAgentMessage, boundary: number): OmpSourceObservation;
/** Native surgery changes content, not these persisted message identity fields. */
export declare function ompNativeMessageKey(message: OmpAgentMessage): string;
/** The Responses item suffix is replay metadata, not the call's durable identity. */
export declare function assistantToolCallId(message: Extract<OmpAgentMessage, {
    role: "assistant";
}>, id: string): string;
export declare class OmpSourceBindings {
    #private;
    bind(sourceId: EpochOrdinalId, message: OmpAgentMessage, entryId?: string | null): void;
    resolve(sourceId: EpochOrdinalId): OmpAgentMessage;
    entryId(sourceId: EpochOrdinalId): string | null;
    identity(sourceId: EpochOrdinalId): string;
    assignEntryId(sourceId: EpochOrdinalId, entryId: string | null): void;
    /** Fill entry ids that were not known when the source was observed. Length must match. */
    assignEntryIds(entryIds: readonly (string | null)[]): void;
    clear(): void;
}
export interface OmpContextMaterializationOptions {
    nodePrompt?: string;
    /** Model-visible messages for a session entry. An empty list omits that entry. */
    projectedMessages?: ReadonlyMap<string, readonly OmpAgentMessage[]>;
}
export declare function materializeOmpContext(context: PublishedContext, bindings: OmpSourceBindings, options?: OmpContextMaterializationOptions): OmpAgentMessage[];
export declare function isOmpSpineProjection(message: OmpAgentMessage, customType?: string): message is Extract<OmpAgentMessage, {
    role: "custom";
}>;
export {};
//# sourceMappingURL=messages.d.ts.map