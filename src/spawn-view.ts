import type { SpawnTask } from "@spinejit/spine-sdk";
import type { SpawnChildTerminal } from "@spinejit/spine-sdk/host";
import type { NativeToolView } from "@oh-my-pi/pi-tui/tools/renderer";
import type { NativeNode } from "@oh-my-pi/pi-tui/native/node";

import { linesComponent, spineBrand, type SpineTheme } from "./pretty-tree.js";

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
] as const;

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

export function createSpawnBatchView(tasks: readonly SpawnTask[]): SpawnBatchDetails {
  const used = new Set<string>();
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

export function applySpawnTerminal(view: SpawnBatchDetails, ordinal: number, terminal: SpawnChildTerminal): void {
  const task = view.tasks[ordinal];
  if (task === undefined) return;
  task.status = terminal.outcome;
  task.diagnostic = terminal.diagnostic ?? null;
  task.memoryBody = terminal.outcome === "completed" ? terminal.memory ?? null : null;
}

export function markSpawnTask(view: SpawnBatchDetails, ordinal: number, status: SpawnTaskStatus, diagnostic: string | null): void {
  const task = view.tasks[ordinal];
  if (task === undefined) return;
  task.status = status;
  task.diagnostic = diagnostic;
  if (status === "running") task.memoryBody = null;
}

export function spawnModelText(view: SpawnBatchDetails): string {
  const completed = view.tasks.filter((task) => task.status === "completed").length;
  if (completed !== view.tasks.length) return `Spine Spawn ${completed}/${view.tasks.length} completed`;
  return `Spine Spawn completed ${view.tasks.length} child tasks`;
}

export function spawnFallbackText(view: SpawnBatchDetails): string {
  return view.tasks.map((task, index) => spawnPlainTaskLine(task, index + 1 === view.tasks.length)).join("\n");
}

export function renderSpawnCall(taskCount: number, theme: SpineTheme) {
  const count = taskCount === 1 ? "1 task" : `${taskCount} tasks`;
  return linesComponent([`${theme.fg("toolTitle", theme.bold("spine_spawn"))}  ${theme.fg("dim", count)}`]);
}

export function renderSpawnResult(view: SpawnBatchDetails, expanded: boolean, theme: SpineTheme) {
  const lines: string[] = [];
  view.tasks.forEach((task, index) => {
    const isLast = index + 1 === view.tasks.length;
    lines.push(themeSpawnTaskLine(task, isLast, theme));
    if (!expanded) return;
    for (const detail of spawnTaskDetails(task)) {
      lines.push(`${theme.fg("dim", isLast ? "      " : "  │   ")}${theme.fg("dim", detail)}`);
    }
  });
  return linesComponent(lines);
}

export function describeSpawnCall(taskCount: number): NativeToolView {
  return { tool: { title: "Spine Spawn", meta: [`${taskCount} ${taskCount === 1 ? "task" : "tasks"}`] } };
}

export function describeSpawnResult(view: SpawnBatchDetails, expanded: boolean): NativeToolView {
  return {
    ...describeSpawnCall(view.tasks.length),
    body: view.tasks.map((task, index): NativeNode => ({
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
          k: "text" as const,
          p: { text: `      ${detail}`, wrap: "word" as const },
        })) : []),
      ],
    })),
    preview: "children",
  };
}

/** A failed/cancelled enclosing call must not leave its unfinished rows running. */
export function settleSpawnView(
  view: SpawnBatchDetails,
  status: "errored" | "aborted",
  diagnostic: string,
): SpawnBatchDetails {
  return {
    ...view,
    tasks: view.tasks.map((task) => task.status !== "running" ? task : {
      ...task,
      status,
      diagnostic: diagnostic || task.diagnostic,
    }),
  };
}

function spawnPlainTaskLine(task: SpawnTaskView, isLast: boolean): string {
  return `  ${isLast ? "└ " : "├ "}${statusMarker(task.status)} ${task.activityWord} ${task.summary}`;
}

function themeSpawnTaskLine(task: SpawnTaskView, isLast: boolean, theme: SpineTheme): string {
  const branch = theme.fg("dim", isLast ? "  └ " : "  ├ ");
  const marker = themeMarker(statusMarker(task.status), theme);
  const word = spineBrand(task.activityWord, theme);
  return `${branch}${marker} ${word} ${task.summary}`;
}

function spawnTaskDetails(task: SpawnTaskView): string[] {
  if (task.status === "running") return [];
  const source = task.status === "completed" ? task.memoryBody : task.diagnostic ?? task.memoryBody;
  if (source === null || source.trim() === "") return [];
  const clipped = clipDetail(source.trim());
  return clipped.split("\n").map((line) => line.trimEnd());
}

function clipDetail(text: string): string {
  const lines = text.split("\n").slice(0, 4);
  const joined = lines.join("\n");
  if (joined.length <= 240) return joined;
  return `${joined.slice(0, 237).trimEnd()}...`;
}

function statusMarker(status: SpawnTaskStatus): string {
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

function themeMarker(marker: string, theme: SpineTheme): string {
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

function assignActivityWord(ordinal: number, used: Set<string>): string {
  const base = ACTIVITY_WORDS[ordinal % ACTIVITY_WORDS.length] ?? "Unfolding";
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let word = `Further ${base}`;
  while (used.has(word)) word = `Further ${word}`;
  used.add(word);
  return word;
}
