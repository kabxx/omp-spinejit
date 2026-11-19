import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import type { SpawnTask } from "@spinejit/spine-sdk";
import type { SpawnChildContext, SpawnChildTerminal } from "@spinejit/spine-sdk/host";
import { type ChildSessionScope } from "./child-session.js";
import { type OmpChildInvocationFactory } from "./invocation.js";
export declare const OMP_CHILD_CONFIG_ENV = "SPINE_OMP_CHILD_CONFIG_TOML";
export declare const OMP_CHILD_BIRTH_ENV = "SPINE_OMP_CHILD_BIRTH";
export interface OmpChildProcessOptions extends ChildSessionScope {
    cwd: string;
    origin: string;
    peers: readonly SpawnTask[];
    /** Only supply a prefix known to recreate the committed birth's context. */
    prefixEntries?: readonly SessionEntry[];
    extensionPath: string;
    runtimeFlags?: readonly string[];
    configToml: string;
    childInvocation?: OmpChildInvocationFactory;
    assertGeneration?: () => void;
    existingSessionId?: string;
    ordinal?: number;
}
/** The child stops when its exact launching process is gone, not on normal model completion. */
export declare function watchOmpChildParent(): (() => void) | undefined;
/** Run one attempt in a fresh native session, or Continue in the exact existing journal. */
export declare function runOmpChild(task: SpawnTask, child: SpawnChildContext, options: OmpChildProcessOptions): Promise<SpawnChildTerminal>;
//# sourceMappingURL=child-process.d.ts.map