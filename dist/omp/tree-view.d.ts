import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { SpineProjection } from "@spinejit/spine-sdk";
/** Read-only browser; the host's native /tree and active leaf are untouched. */
export declare function registerSpineTreeCommand(api: Pick<ExtensionAPI, "registerCommand">, getProjection: (ctx: ExtensionCommandContext) => SpineProjection | null | undefined): void;
/** Owns one OMP widget. All callbacks into optional views stop at this UI boundary. */
export declare class SpineTreeDisplay {
    private current;
    publish(ctx: ExtensionContext, generation: number, projection: SpineProjection): void;
    /** Caller supplies the latest published projection, not a cached drawing signature. */
    offer(request: unknown, generation: number, projection: SpineProjection): void;
    reset(): void;
    private disposed;
    private render;
    private invalidate;
    private end;
    private redraw;
    private report;
}
//# sourceMappingURL=tree-view.d.ts.map