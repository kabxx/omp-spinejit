import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
export interface ChildSessionScope {
    parentSessionId: string;
    parentSessionFile?: string;
}
/** Producer ids may repeat across native tree branches; origin names the committed birth. */
export interface ChildBirthRef {
    origin: string;
    producer: readonly number[];
}
export declare function buildChildAssignment(task: {
    summary: string;
    prompt: string;
}, peers: readonly {
    summary: string;
    prompt: string;
}[]): string;
export declare function buildChildContinuation(guidance?: string, fallbackAssignment?: string): string;
export declare function childSessionPath(scope: ChildSessionScope, birth: ChildBirthRef, attempt?: number): string;
export declare function latestChildSession(scope: ChildSessionScope, birth: ChildBirthRef): Promise<{
    path: string;
    attempt: number;
} | null>;
export declare function writeChildPrefixSession(options: {
    cwd: string;
    destPath: string;
    entries: readonly SessionEntry[];
    birth: readonly number[];
    parentSession?: string;
}): Promise<string>;
/** OMP preserves these header fields across native title and history rewrites. */
export declare function childBirthOf(header: unknown): readonly number[] | null;
export declare function readChildSession(path: string, expectedId?: string): Promise<{
    id: string;
    birth: readonly number[];
    branch: SessionEntry[];
    ownEntries: SessionEntry[];
    complete: boolean;
}>;
export declare function inspectChildSession(options: {
    destPath: string;
    expectedId?: string;
    birth: readonly number[];
    assignment: string;
}): Promise<{
    id: string;
    assignmentPresent: boolean;
}>;
//# sourceMappingURL=child-session.d.ts.map