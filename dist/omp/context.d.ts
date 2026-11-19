import { type OmpAgentMessage } from "./messages.js";
/** Keep the live tool loop and native runtime context, even before a queued user. */
export declare function liveHostSuffix(host: readonly OmpAgentMessage[]): OmpAgentMessage[];
/** Prefer the edited branch view; append only unpersisted event messages. */
export declare function mergeHostTranscripts(branchMessages: readonly OmpAgentMessage[], eventMessages: readonly OmpAgentMessage[] | undefined, persistedMessages: readonly OmpAgentMessage[]): OmpAgentMessage[];
/** Keep the plan's ordering and labels. Restore only transient native suffix
 * messages and results whose corresponding assistant survived projection. */
export declare function spliceLiveHostTranscript(projected: readonly OmpAgentMessage[], host: readonly OmpAgentMessage[] | undefined, persisted?: readonly OmpAgentMessage[]): OmpAgentMessage[];
//# sourceMappingURL=context.d.ts.map