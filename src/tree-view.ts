import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { matchesKey, stripTerminalSequences, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
import { OverlayPanel, PanelDivider, PanelRows } from "@oh-my-pi/pi-tui/chrome";
import type { MemorySlot, SpineProjection } from "@spinejit/spine-sdk";
import {
  displayTreeSignature,
  formatThemedPrettySpineTree,
  formatNodeId,
  prettySpineTreeHasTasks,
  spineTreeLabel,
  spineTreeMarker,
  spineTreeMarkerText,
  type SpineTheme,
} from "@spinejit/spine-sdk/view";
import type {
  SpineTreeView,
  SpineTreeViewEnd,
  SpineTreeViewRequest,
} from "./tree-view-contract.js";
import { clampLines, visibleWidth } from "./tui-width.js";

const WIDGET_KEY = "spine-tree";
const BROWSER_WIDGET_KEY = "spine-tree-browser";
const TREE_PANEL_INSET = 4; // Two columns per side in OverlayPanel.
const TREE_PANEL_CHROME = 4; // Top and bottom borders, help row, divider.
const TREE_BROWSER_RESERVED_ROWS = 6; // Leave room for OMP's composer and status chrome.

type TreeItem = { id: string; title: string; heading: string; marker?: string; detail: () => string };

/** Read-only browser; the host's native /tree and active leaf are untouched. */
export function registerSpineTreeCommand(
  api: Pick<ExtensionAPI, "registerCommand">,
  getProjection: (ctx: ExtensionCommandContext) => SpineProjection | null | undefined,
): void {
  let open = false;
  api.registerCommand("spine-tree", {
    description: "Browse Spine nodes, memory, and past summaries",
    async handler(args, ctx) {
      if (ctx.mode !== "tui" || !ctx.hasUI || open) return;
      open = true;
      try {
        const projection = getProjection(ctx);
        if (!projection) {
          ctx.ui.notify("There is no active Spine tree in this session.", "info");
          return;
        }
        const current = formatNodeId(projection.cursor);
        const items: TreeItem[] = projection.nodes.map(node => {
          const id = formatNodeId(node.id);
          const active = id === current;
          const marker = spineTreeMarker(node, active, node.children.length > 0);
          const summary = node.kind === "RootEpoch" ? node.summary?.trim() || "Epoch" : spineTreeLabel(node, active);
          const goal = singleLine(summary);
          return {
            id,
            title: `${"  ".repeat(Math.min(6, Math.max(0, node.id.length - 1)))}${marker} ${id} ${goal}${active ? " (current)" : ""}`,
            heading: goal,
            marker,
            detail: () => node.memory?.length ? node.memory.map(memoryText).join("\n\n") : "No saved memory for this node.",
          };
        });
        // Use the active journal branch, not the compacted model context or sibling branches.
        for (const entry of ctx.sessionManager.getBranch().slice().reverse()) {
          if (entry.type !== "compaction" && entry.type !== "branch_summary") continue;
          if (!entry.summary.trim()) continue;
          const kind = entry.type === "compaction" ? "Compaction" : "Branch summary";
          const title = `Past: ${kind} · ${singleLine(entry.timestamp)}`;
          items.push({ id: `past:${entry.id}`, title, heading: title, detail: () => entry.summary });
        }
        if (!items.length) {
          ctx.ui.notify("No Spine nodes or past summaries are available.", "info");
          return;
        }
        const target = args.trim();
        const requested = target ? items.findIndex(item => item.id === target) : -1;
        if (target && requested < 0) ctx.ui.notify(`Spine node ${singleLine(target)} is unavailable; showing the current node.`, "warning");
        let selected = requested >= 0 ? requested : Math.max(0, items.findIndex(item => item.id === current));
        const { promise: closed, resolve: close } = Promise.withResolvers<void>();
        let mounted = false;
        ctx.ui.setWidget(BROWSER_WIDGET_KEY, (tui, theme) => {
          const previousFocus = tui.getFocused();
          const panel = new OverlayPanel("Spine Tree");
          const help = new PanelRows();
          const body = new PanelRows();
          panel.addChild(help);
          panel.addChild(new PanelDivider());
          panel.addChild(body);
          let detail: string | null = null;
          let wrapped: string[] = [];
          let wrappedWidth = 0;
          let offset = 0;
          const pageSize = () => Math.max(1, tui.terminal.rows - TREE_BROWSER_RESERVED_ROWS - TREE_PANEL_CHROME);
          const browser = {
            render(width: number) {
              if (width < 1) return [];
              const innerWidth = Math.max(1, width - TREE_PANEL_INSET);
              const page = pageSize();
              if (detail !== null) {
                if (wrappedWidth !== innerWidth) {
                  const item = items[selected]!;
                  const title = theme.bold(item.heading);
                  const heading = item.marker === undefined ? title : `${spineTreeMarkerText(item.marker, theme)} ${title}`;
                  wrapped = [
                    ...wrapTextWithAnsi(heading, innerWidth),
                    "",
                    ...wrapTextWithAnsi(detail, innerWidth).map(line => line ? theme.fg("muted", line) : line),
                  ];
                  wrappedWidth = innerWidth;
                }
                offset = Math.min(offset, Math.max(0, wrapped.length - page));
                const position = `${offset + 1}–${Math.min(offset + page, wrapped.length)}/${wrapped.length}`;
                help.setLines([theme.fg("dim", fitTreeHelp(innerWidth,
                  `↑↓ Scroll · PgUp/PgDn Page · Esc Back (${position})`,
                  "↑↓ Scroll · Esc Back", "Esc Back"))]);
                body.setLines(wrapped.slice(offset, offset + page));
              } else {
                const start = Math.max(0, Math.min(selected - Math.floor(page / 2), items.length - page));
                const position = `${selected + 1}/${items.length}`;
                help.setLines([theme.fg("dim", fitTreeHelp(innerWidth,
                  `↑↓ Move · PgUp/PgDn Page · Enter Read · Esc Close (${position})`,
                  "↑↓ · Enter Read · Esc Close", "Enter · Esc", "Esc"))]);
                body.setLines(items.slice(start, start + page).map((item, index) => start + index === selected
                  ? theme.fg("accent", `> ${item.title}`) : `  ${item.title}`));
              }
              return panel.render(width);
            },
            invalidate() { panel.invalidate(); wrappedWidth = 0; },
            capturesInput(input: string) { return matchesKey(input, "escape"); },
            handleInput(input: string) {
              if (matchesKey(input, "escape")) {
                if (detail === null) return close();
                detail = null;
              } else if (matchesKey(input, "enter") && detail === null) {
                detail = terminalText(items[selected]!.detail());
                wrappedWidth = 0;
                offset = 0;
              } else {
                const delta = matchesKey(input, "up") ? -1 : matchesKey(input, "down") ? 1
                  : matchesKey(input, "pageUp") ? -pageSize() : matchesKey(input, "pageDown") ? pageSize() : 0;
                if (!delta) return;
                if (detail !== null) offset = Math.max(0, offset + delta);
                else selected = Math.max(0, Math.min(items.length - 1, selected + delta));
              }
              tui.requestRender();
            },
            dispose() {
              mounted = false;
              if (tui.getFocused() === browser) tui.setFocus(previousFocus);
              close();
            },
          };
          mounted = true;
          tui.setFocus(browser);
          return browser;
        }, { placement: "aboveEditor" });
        await closed;
        if (mounted) ctx.ui.setWidget(BROWSER_WIDGET_KEY, undefined);
      } catch (cause) {
        ctx.ui.notify(`Spine tree unavailable: ${cause instanceof Error ? cause.message : String(cause)}`, "error");
      } finally {
        open = false;
      }
    },
  });
}

function fitTreeHelp(width: number, ...variants: string[]): string {
  return variants.find(text => visibleWidth(text) <= width) ?? variants.at(-1)!;
}

function memoryText(slot: MemorySlot): string {
  if ("Summary" in slot) return slot.Summary.body;
  if ("User" in slot) return `User\n${slot.User.message.content}`;
  if ("Reply" in slot) return `Reply\n${slot.Reply.message.content}`;
  if ("Birth" in slot) return `Spawn assignment\n${slot.Birth.task.summary}\n${slot.Birth.task.prompt}`;
  const arrival = slot.Arrival.arrival;
  return `Spawn result from ${formatNodeId(arrival.producer)} (${arrival.outcome})\n${arrival.memory ?? arrival.diagnostic ?? ""}`;
}

function terminalText(text: string): string {
  return stripTerminalSequences(text).replace(/\r\n/g, "\n").replace(/\t/g, "    ").replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, "");
}

function singleLine(text: string): string {
  return terminalText(text).replace(/\s+/g, " ").trim();
}

type Contribution = {
  view: SpineTreeView;
  onEnd: (reason: SpineTreeViewEnd) => void;
};

type DisplaySession = {
  ctx: ExtensionContext;
  sessionId: string;
  generation: number;
  projection: SpineProjection;
  signature: string;
  contribution: Contribution | null;
  requestRender: () => void;
};

/** Owns one OMP widget. All callbacks into optional views stop at this UI boundary. */
export class SpineTreeDisplay {
  private current: DisplaySession | null = null;

  publish(ctx: ExtensionContext, generation: number, projection: SpineProjection): void {
    if (ctx.mode !== "tui") return;
    try {
      const sessionId = ctx.sessionManager.getSessionId();
      let current = this.current;
      if (current === null || current.generation !== generation || current.sessionId !== sessionId) {
        this.reset();
        current = {
          ctx, sessionId, generation, projection,
          signature: displayTreeSignature(projection),
          contribution: null,
          requestRender() {},
        };
        this.current = current;
        const installed = current;
        try {
          ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
            installed.requestRender = () => tui.requestRender();
            return {
              render: (width) => this.render(
                installed,
                theme,
                width,
                Math.max(1, tui.terminal.rows - 6),
              ),
              invalidate: () => this.invalidate(installed),
              dispose: () => this.disposed(installed),
            };
          }, { placement: "aboveEditor" });
        } catch (error) {
          // A failed registration must not offer an invisible browsing surface.
          if (this.current === installed) this.current = null;
          throw error;
        }
        return;
      }
      // Always retain the newest projection, including memory-only changes.
      current.projection = projection;
      const signature = displayTreeSignature(projection);
      if (signature !== current.signature) {
        current.signature = signature;
        if (current.contribution === null) this.redraw(current);
      }
    } catch (error) {
      this.report(ctx, error);
    }
  }

  /** Caller supplies the latest published projection, not a cached drawing signature. */
  offer(request: unknown, generation: number, projection: SpineProjection): void {
    const current = this.current;
    if (current === null || current.generation !== generation || !isRequest(request)
      || request.sessionId !== current.sessionId) return;
    try {
      current.projection = projection;
      const snapshot = structuredClone({
        sessionId: current.sessionId,
        generation,
        nodes: projection.nodes,
        cursor: projection.cursor,
      });
      request.accept({
        version: 1,
        snapshot,
        attach: (view, onEnd) => {
          if (this.current !== current) throw new Error("Spine tree connection is no longer active");
          if (current.contribution !== null) throw new Error("Spine tree is already being browsed");
          const contribution = { view, onEnd };
          current.contribution = contribution;
          this.redraw(current);
          return {
            redraw: () => {
              if (this.current === current && current.contribution === contribution) this.redraw(current);
            },
            release: () => {
              if (this.current !== current || current.contribution !== contribution) return;
              this.end(current, "released");
              this.redraw(current);
            },
          };
        },
      });
    } catch (error) {
      this.report(current.ctx, error);
    }
  }

  reset(): void {
    const current = this.current;
    if (current === null) return;
    this.current = null;
    this.end(current, "invalidated");
    try {
      current.ctx.ui.setWidget(WIDGET_KEY, undefined);
    } catch (error) {
      this.report(current.ctx, error);
    }
  }

  private disposed(current: DisplaySession): void {
    if (this.current !== current) return;
    this.current = null;
    // OMP may dispose this widget before session_shutdown (notably on reload).
    // Notify now; never recursively remove the widget being disposed by OMP.
    this.end(current, "invalidated");
  }

  private render(current: DisplaySession, theme: SpineTheme, width: number, height: number): string[] {
    if (this.current !== current) return [];
    if (current.contribution !== null) {
      try {
        return clampLines(current.contribution.view.render(width, height).slice(0, height), width);
      } catch (error) {
        this.report(current.ctx, error);
        this.end(current, "render-error");
      }
    }
    try {
      const projection = current.projection;
      if (!prettySpineTreeHasTasks(projection)
        && !projection.nodes.some(node => node.kind === "Spawn" || node.status === "Compacted")) return [];
      const view = {
        ...projection,
        nodes: projection.nodes.map(node => node.summary === null ? node : { ...node, summary: singleLine(node.summary) }),
      };
      return clampLines([...formatThemedPrettySpineTree(view, theme, { compactedHint: "See /spine-tree" }), ""].slice(0, height), width);
    } catch (error) {
      this.report(current.ctx, error);
      return [];
    }
  }

  private invalidate(current: DisplaySession): void {
    if (this.current !== current || current.contribution === null) return;
    try {
      current.contribution.view.invalidate();
    } catch (error) {
      this.report(current.ctx, error);
      this.end(current, "render-error");
    }
  }

  private end(current: DisplaySession, reason: SpineTreeViewEnd): void {
    const contribution = current.contribution;
    current.contribution = null;
    if (contribution === null) return;
    try {
      contribution.onEnd(reason);
    } catch (error) {
      this.report(current.ctx, error);
    }
  }

  private redraw(current: DisplaySession): void {
    try {
      current.requestRender();
    } catch (error) {
      this.report(current.ctx, error);
    }
  }

  private report(ctx: ExtensionContext, error: unknown): void {
    try {
      ctx.ui.notify(`Spine tree display: ${error instanceof Error ? error.message : String(error)}`, "error");
    } catch {
      // UI failure must not escape into sampling/compaction error handling.
    }
  }
}

function isRequest(value: unknown): value is SpineTreeViewRequest {
  if (typeof value !== "object" || value === null) return false;
  const request = value as Partial<SpineTreeViewRequest>;
  return request.version === 1 && typeof request.sessionId === "string" && typeof request.accept === "function";
}
