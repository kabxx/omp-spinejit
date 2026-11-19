import { visibleWidth } from "@oh-my-pi/pi-tui";
export { visibleWidth };
export declare function truncateToWidth(text: string, width: number, ellipsis?: string): string;
export declare function clampLines(lines: readonly string[], width: number): string[];
export declare function linesComponent(lines: readonly string[]): {
    render: (width: number) => string[];
    invalidate: () => void;
};
//# sourceMappingURL=tui-width.d.ts.map