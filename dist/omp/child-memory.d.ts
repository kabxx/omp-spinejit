import { type SpawnChildTerminal } from "@spinejit/spine-sdk/host";
export interface OmpChildState {
    open: number;
    terminal: SpawnChildTerminal | null;
    /** Last conversation entry, used to reject stale success after a Continue. */
    lastEntryId: string | null;
    /** Errors remain available even if open children or damaged persistence prevent a terminal. */
    diagnostic: string | null;
}
/** Read only the child's active, native journal branch; the event stream never supplies memory. */
export declare function readChildState(path: string, expectedId?: string): Promise<OmpChildState>;
//# sourceMappingURL=child-memory.d.ts.map