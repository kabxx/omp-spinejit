import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { type OmpAgentMessage } from "./messages.js";
import type { OmpBranchEntry } from "./recovery.js";
export interface OmpSessionProjection {
    entries: {
        sourceEntry: SessionEntry;
        messages: OmpAgentMessage[];
    }[];
    messages: OmpAgentMessage[];
    /** Native state-derived injections have no durable conversation Source entry. */
    generatedMessages: OmpAgentMessage[];
}
/** Expand raw persisted entries without applying whole-branch context filtering. */
export declare function sessionEntryToOmpMessages(entry: SessionEntry): OmpAgentMessage[];
/** Keep provenance while the native OMP builder applies compaction, reset, and retry filtering. */
export declare function projectOmpSession(branch: readonly OmpBranchEntry[]): OmpSessionProjection;
/** Keep state-derived native messages even when their surrounding Sources are summarized. */
export declare function spliceOmpGeneratedContext(messages: OmpAgentMessage[], projection: OmpSessionProjection): OmpAgentMessage[];
//# sourceMappingURL=host-projection.d.ts.map