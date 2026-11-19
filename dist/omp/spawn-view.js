import { linesComponent, spineBrand } from "./pretty-tree.js";
const ACTIVITY_WORDS = [
    "Germinating",
    "Budding",
    "Sprouting",
    "Rooting",
    "Branching",
    "Unfurling",
    "Blooming",
    "Flourishing",
    "Sketching",
    "Shaping",
    "Layering",
    "Weaving",
    "Composing",
    "Rendering",
    "Unfolding",
    "Evolving",
    "Awakening",
    "Becoming",
    "Emerging",
    "Stirring",
    "Quickening",
    "Kindling",
    "Growing",
    "Greening",
    "Blossoming",
    "Ripening",
    "Renewing",
    "Cultivating",
    "Nurturing",
    "Deepening",
    "Flowing",
    "Gathering",
    "Coalescing",
    "Distilling",
    "Refining",
    "Crystallizing",
    "Illuminating",
    "Glimmering",
    "Resonating",
    "Materializing",
];
export function createSpawnBatchView(tasks) {
    const used = new Set();
    return {
        schema: "spine.spawn.view.v1",
        tasks: tasks.map((task, ordinal) => ({
            summary: task.summary.trim(),
            activityWord: assignActivityWord(ordinal, used),
            status: "running",
            diagnostic: null,
            memoryBody: null,
        })),
    };
}
export function applySpawnTerminal(view, ordinal, terminal) {
    const task = view.tasks[ordinal];
    if (task === undefined)
        return;
    task.status = terminal.outcome;
    task.diagnostic = terminal.diagnostic ?? null;
    task.memoryBody = terminal.outcome === "completed" ? terminal.memory ?? null : null;
}
export function markSpawnTask(view, ordinal, status, diagnostic) {
    const task = view.tasks[ordinal];
    if (task === undefined)
        return;
    task.status = status;
    task.diagnostic = diagnostic;
    if (status === "running")
        task.memoryBody = null;
}
export function spawnModelText(view) {
    const completed = view.tasks.filter((task) => task.status === "completed").length;
    if (completed !== view.tasks.length)
        return `Spine Spawn ${completed}/${view.tasks.length} completed`;
    return `Spine Spawn completed ${view.tasks.length} child tasks`;
}
export function spawnFallbackText(view) {
    return view.tasks.map((task, index) => spawnPlainTaskLine(task, index + 1 === view.tasks.length)).join("\n");
}
export function renderSpawnCall(taskCount, theme) {
    const count = taskCount === 1 ? "1 task" : `${taskCount} tasks`;
    return linesComponent([`${theme.fg("toolTitle", theme.bold("spine_spawn"))}  ${theme.fg("dim", count)}`]);
}
export function renderSpawnResult(view, expanded, theme) {
    const lines = [];
    view.tasks.forEach((task, index) => {
        const isLast = index + 1 === view.tasks.length;
        lines.push(themeSpawnTaskLine(task, isLast, theme));
        if (!expanded)
            return;
        for (const detail of spawnTaskDetails(task)) {
            lines.push(`${theme.fg("dim", isLast ? "      " : "  │   ")}${theme.fg("dim", detail)}`);
        }
    });
    return linesComponent(lines);
}
export function describeSpawnCall(taskCount) {
    return { tool: { title: "Spine Spawn", meta: [`${taskCount} ${taskCount === 1 ? "task" : "tasks"}`] } };
}
export function describeSpawnResult(view, expanded) {
    return {
        ...describeSpawnCall(view.tasks.length),
        body: view.tasks.map((task, index) => ({
            k: "col",
            key: `child-${index}`,
            p: { role: "spine.spawn.child", gap: "none" },
            c: [
                {
                    k: "text",
                    p: {
                        wrap: "word",
                        spans: [
                            { t: `  ${index + 1 === view.tasks.length ? "└ " : "├ "}`, s: "dim" },
                            { t: `${statusMarker(task.status)} `, s: task.status === "errored" ? "error" : task.status === "aborted" ? "warning" : "accent" },
                            { t: `${task.activityWord} `, s: "accent" },
                            { t: task.summary },
                        ],
                    },
                },
                ...(expanded ? spawnTaskDetails(task).map((detail) => ({
                    k: "text",
                    p: { text: `      ${detail}`, wrap: "word" },
                })) : []),
            ],
        })),
        preview: "children",
    };
}
/** A failed/cancelled enclosing call must not leave its unfinished rows running. */
export function settleSpawnView(view, status, diagnostic) {
    return {
        ...view,
        tasks: view.tasks.map((task) => task.status !== "running" ? task : {
            ...task,
            status,
            diagnostic: diagnostic || task.diagnostic,
        }),
    };
}
function spawnPlainTaskLine(task, isLast) {
    return `  ${isLast ? "└ " : "├ "}${statusMarker(task.status)} ${task.activityWord} ${task.summary}`;
}
function themeSpawnTaskLine(task, isLast, theme) {
    const branch = theme.fg("dim", isLast ? "  └ " : "  ├ ");
    const marker = themeMarker(statusMarker(task.status), theme);
    const word = spineBrand(task.activityWord, theme);
    return `${branch}${marker} ${word} ${task.summary}`;
}
function spawnTaskDetails(task) {
    if (task.status === "running")
        return [];
    const source = task.status === "completed" ? task.memoryBody : task.diagnostic ?? task.memoryBody;
    if (source === null || source.trim() === "")
        return [];
    const clipped = clipDetail(source.trim());
    return clipped.split("\n").map((line) => line.trimEnd());
}
function clipDetail(text) {
    const lines = text.split("\n").slice(0, 4);
    const joined = lines.join("\n");
    if (joined.length <= 240)
        return joined;
    return `${joined.slice(0, 237).trimEnd()}...`;
}
function statusMarker(status) {
    switch (status) {
        case "running":
            return "◐";
        case "completed":
            return "✓";
        case "errored":
            return "×";
        case "aborted":
            return "!";
    }
}
function themeMarker(marker, theme) {
    switch (marker) {
        case "◐":
        case "◉":
        case "✓":
            return spineBrand(marker, theme);
        case "×":
            return theme.fg("error", theme.bold(marker));
        case "!":
            return theme.fg("warning", theme.bold(marker));
        default:
            return theme.fg("dim", marker);
    }
}
function assignActivityWord(ordinal, used) {
    const base = ACTIVITY_WORDS[ordinal % ACTIVITY_WORDS.length] ?? "Unfolding";
    if (!used.has(base)) {
        used.add(base);
        return base;
    }
    let word = `Further ${base}`;
    while (used.has(word))
        word = `Further ${word}`;
    used.add(word);
    return word;
}
//# sourceMappingURL=spawn-view.js.map