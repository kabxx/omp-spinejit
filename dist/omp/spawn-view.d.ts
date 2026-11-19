import type { SpawnTask } from "@spinejit/spine-sdk";
import type { SpawnChildTerminal } from "@spinejit/spine-sdk/host";
import type { NativeToolView } from "@oh-my-pi/pi-tui/tools/renderer";
import { type SpineTheme } from "./pretty-tree.js";
export type SpawnTaskStatus = "running" | "completed" | "errored" | "aborted";
export interface SpawnTaskView {
    summary: string;
    activityWord: string;
    status: SpawnTaskStatus;
    diagnostic: string | null;
    memoryBody: string | null;
}
export interface SpawnBatchDetails {
    schema: "spine.spawn.view.v1";
    tasks: SpawnTaskView[];
}
export declare function createSpawnBatchView(tasks: readonly SpawnTask[]): SpawnBatchDetails;
export declare function applySpawnTerminal(view: SpawnBatchDetails, ordinal: number, terminal: SpawnChildTerminal): void;
export declare function markSpawnTask(view: SpawnBatchDetails, ordinal: number, status: SpawnTaskStatus, diagnostic: string | null): void;
export declare function spawnModelText(view: SpawnBatchDetails): string;
export declare function spawnFallbackText(view: SpawnBatchDetails): string;
export declare function renderSpawnCall(taskCount: number, theme: SpineTheme): {
    render: (width: number) => string[];
    invalidate: () => void;
};
export declare function renderSpawnResult(view: SpawnBatchDetails, expanded: boolean, theme: SpineTheme): {
    render: (width: number) => string[];
    invalidate: () => void;
};
export declare function describeSpawnCall(taskCount: number): NativeToolView;
export declare function describeSpawnResult(view: SpawnBatchDetails, expanded: boolean): NativeToolView;
/** A failed/cancelled enclosing call must not leave its unfinished rows running. */
export declare function settleSpawnView(view: SpawnBatchDetails, status: "errored" | "aborted", diagnostic: string): SpawnBatchDetails;
//# sourceMappingURL=spawn-view.d.ts.map