import { sliceByColumn, truncateToWidth as truncateTerminalText, visibleWidth } from "@oh-my-pi/pi-tui";

export { visibleWidth };

export function truncateToWidth(text: string, width: number, ellipsis?: string): string {
  if (width <= 0) return "";
  if (ellipsis === undefined) return truncateTerminalText(text, width);
  if (visibleWidth(text) <= width) return text;
  const remaining = width - visibleWidth(ellipsis);
  return remaining <= 0 ? truncateTerminalText(ellipsis, width, "") : `${sliceByColumn(text, 0, remaining, true)}${ellipsis}`;
}

export function clampLines(lines: readonly string[], width: number): string[] {
  return width <= 0 ? [] : lines.map(line => truncateTerminalText(line, width));
}

export function linesComponent(lines: readonly string[]): { render: (width: number) => string[]; invalidate: () => void } {
  return { render: width => clampLines(lines, width), invalidate() {} };
}
