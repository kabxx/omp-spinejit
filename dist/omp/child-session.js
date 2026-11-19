import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { assertOmpV3ReplayBranch, buildOmpReplayPlan } from "./recovery.js";
import { projectOmpSession, sessionEntryToOmpMessages } from "./host-projection.js";
const OMP_SESSION_VERSION = 3;
export function buildChildAssignment(task, peers) {
    const identity = task.summary.trim();
    const peerLines = peers.filter((peer) => peer !== task).map((peer) => `- ${peer.summary.trim()}`);
    return `You are a spawned execution branch. Your role is to complete exactly the assignment below and return bounded terminal memory to the spawning continuation.

You are: ${identity}

Peer branches in this spawn:
${peerLines.length === 0 ? "- (none)" : peerLines.join("\n")}

The assignment is already an active branch scope. Begin the assigned work directly. Use spine_open, spine_close, and spine_next only to manage genuine descendant work within this assignment. Use spine_spawn only when this assignment itself has two or more independent parallel sub-assignments.

Executable work is defined by the assignment. Inherited context supplies constraints and evidence for that work.

When the assignment declares a collaboration contract, follow its named root, peer roles, artifact format, update/read protocol, synchronization points, and bounded fallback. Inspect the coordination root before substantive work. Coordinate through it to minimize unnecessary duplicate work: respect assigned scopes, share reusable evidence early, and independently verify load-bearing or disputed claims. Within the coordination root, write only your declared single-writer artifact and read peer artifacts through the declared protocol, even when the investigated source and evidence are otherwise read-only. Unless the contract provides locking or atomic append, preserve your artifact append-only. Publish findings, conflicts, or requests useful to peers at the declared coordination points.

Other shared-workspace changes remain context for the assignment and do not add executable work. Production-file ownership and any integration responsibility remain exactly as declared in the assignment.

When the assignment is complete and any children you spawned have arrived, end with a final plain reply containing the complete continuation memory.

Assignment:
${task.prompt}`;
}
export function buildChildContinuation(guidance, fallbackAssignment) {
    const fallback = fallbackAssignment === undefined
        ? ""
        : `\n\nThe original assignment was not present in the active session context. Use the following only to restore task context; inspect the existing state first and do not repeat work that is already complete.\n\nAssignment context:\n${fallbackAssignment}`;
    const note = guidance === undefined ? "" : `\n\nUser guidance:\n${guidance}`;
    return `The previous execution attempt did not complete the assigned work. Continue the same active branch from the existing session history. Inspect the current state, finish the assignment, and end with a final plain reply containing the complete continuation memory after any children of your own have arrived. Do not start a new branch or repeat work that is already complete.${fallback}${note}`;
}
function childSessionDir(scope) {
    const root = scope.parentSessionFile === undefined ? join(tmpdir(), "omp-spine-spawn") : join(dirname(scope.parentSessionFile), "spine-spawn");
    return join(root, hash(JSON.stringify([scope.parentSessionId, scope.parentSessionFile])));
}
function childSessionStem(birth) {
    if (birth.producer.length === 0 || birth.producer.some((part) => !Number.isSafeInteger(part) || part < 0)) {
        throw new Error("OMP Spawn child requires a valid producer id");
    }
    return `${hash(birth.origin)}.${birth.producer.join(".")}`;
}
function hash(value) {
    return createHash("sha256").update(value).digest("hex").slice(0, 32);
}
export function childSessionPath(scope, birth, attempt = 0) {
    if (!Number.isSafeInteger(attempt) || attempt < 0)
        throw new Error("OMP Spawn child requires a valid attempt number");
    return join(childSessionDir(scope), `${childSessionStem(birth)}${attempt === 0 ? "" : `.attempt-${attempt}`}.jsonl`);
}
export async function latestChildSession(scope, birth) {
    const dir = childSessionDir(scope);
    const stem = childSessionStem(birth);
    const pattern = new RegExp(`^${stem.replaceAll(".", "\\.")}(?:\\.attempt-([1-9]\\d*))?\\.jsonl$`);
    let names;
    try {
        names = await readdir(dir);
    }
    catch (cause) {
        if (cause.code === "ENOENT")
            return null;
        throw cause;
    }
    let latest = null;
    for (const name of names) {
        const match = pattern.exec(name);
        if (match === null)
            continue;
        const attempt = Number(match[1] ?? 0);
        if (Number.isSafeInteger(attempt) && (latest === null || attempt > latest.attempt))
            latest = { path: join(dir, name), attempt };
    }
    return latest;
}
export async function writeChildPrefixSession(options) {
    assertOmpV3ReplayBranch(options.entries);
    await mkdir(dirname(options.destPath), { recursive: true });
    const id = randomUUID();
    const header = {
        type: "session",
        version: OMP_SESSION_VERSION,
        id,
        timestamp: new Date().toISOString(),
        cwd: options.cwd,
        parentSession: options.parentSession,
        birth: options.birth,
        inheritedLeafId: options.entries.at(-1)?.id ?? null,
    };
    const lines = [JSON.stringify(header)];
    for (const entry of options.entries)
        lines.push(JSON.stringify(entry));
    // A stale runner must not replace a previous attempt's journal.
    await writeFile(options.destPath, `${lines.join("\n")}\n`, { flag: "wx", mode: 0o600 });
    return id;
}
/** OMP preserves these header fields across native title and history rewrites. */
export function childBirthOf(header) {
    if (header === null || typeof header !== "object" || !("birth" in header) || !Array.isArray(header.birth))
        return null;
    const birth = header.birth;
    return birth.length > 0 && birth.every((part) => typeof part === "number" && Number.isSafeInteger(part) && part >= 0) ? birth : null;
}
export async function readChildSession(path, expectedId) {
    const lines = (await readFile(path, "utf8")).split("\n");
    const invalid = (reason) => new Error(`OMP Spawn child journal ${reason}: ${path}`);
    const decode = (line) => {
        const value = JSON.parse(line);
        if (value === null || typeof value !== "object" || Array.isArray(value))
            throw invalid("has a non-object record");
        return value;
    };
    let header;
    let next = 0;
    try {
        header = decode(lines[next++] ?? "");
        if (header.type === "title")
            header = decode(lines[next++] ?? "");
    }
    catch {
        throw invalid("has an invalid header");
    }
    const birth = childBirthOf(header);
    if (header.type !== "session" || typeof header.id !== "string" || header.id.length === 0 || birth === null
        || (header.inheritedLeafId !== null && typeof header.inheritedLeafId !== "string"))
        throw invalid("has no valid child metadata");
    if (expectedId !== undefined && header.id !== expectedId)
        throw invalid("identity changed");
    const entries = new Map();
    let leafId = null;
    let fallbackLeafId = null;
    const complete = lines.at(-1) === "";
    for (; next < lines.length - 1; next += 1) {
        const line = lines[next];
        if (!line.trim())
            continue;
        const value = decode(line);
        if (typeof value.id !== "string" || typeof value.type !== "string" || entries.has(value.id)
            || !(value.parentId === null || typeof value.parentId === "string"))
            throw invalid("has an invalid tree record");
        const entry = value;
        entries.set(entry.id, entry);
        leafId = entry.activeLeafId !== undefined ? entry.activeLeafId : entry.id;
        if (leafId === entry.id)
            fallbackLeafId = leafId;
    }
    // OMP late bookkeeping records capture the then-active leaf; they need not select themselves.
    if (leafId !== null && !entries.has(leafId))
        leafId = fallbackLeafId;
    const branch = [];
    const visited = new Set();
    while (leafId !== null) {
        const entry = entries.get(leafId);
        if (entry === undefined || visited.has(leafId))
            throw invalid("has a broken active branch");
        visited.add(leafId);
        branch.push(entry);
        leafId = entry.parentId;
    }
    branch.reverse();
    const inherited = header.inheritedLeafId === null ? -1 : branch.findIndex((entry) => entry.id === header.inheritedLeafId);
    if (header.inheritedLeafId !== null && inherited < 0)
        throw invalid("no longer descends from its birth prefix");
    return { id: header.id, birth, branch, ownEntries: branch.slice(inherited + 1), complete };
}
export async function inspectChildSession(options) {
    const { id, birth, branch, complete } = await readChildSession(options.destPath, options.expectedId);
    if (birth.join(".") !== options.birth.join("."))
        throw new Error("OMP Spawn child session belongs to a different birth");
    if (!complete)
        throw new Error("OMP Spawn child journal has a truncated record");
    buildOmpReplayPlan({ currentSessionId: id, branch, messagesForEntry: (entry) => sessionEntryToOmpMessages(entry) });
    const assignmentPresent = projectOmpSession(branch).messages.some((message) => messageContainsText(message, options.assignment));
    return { id, assignmentPresent };
}
function messageContainsText(message, text) {
    if (message.role !== "user")
        return false;
    if (typeof message.content === "string")
        return message.content.includes(text);
    return Array.isArray(message.content) && message.content.some((item) => item.type === "text" && item.text.includes(text));
}
//# sourceMappingURL=child-session.js.map