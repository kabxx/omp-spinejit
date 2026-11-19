import { sliceByColumn, truncateToWidth as truncateTerminalText, visibleWidth } from "@oh-my-pi/pi-tui";
export { visibleWidth };
export function truncateToWidth(text, width, ellipsis) {
    if (width <= 0)
        return "";
    if (ellipsis === undefined)
        return truncateTerminalText(text, width);
    if (visibleWidth(text) <= width)
        return text;
    const remaining = width - visibleWidth(ellipsis);
    return remaining <= 0 ? truncateTerminalText(ellipsis, width, "") : `${sliceByColumn(text, 0, remaining, true)}${ellipsis}`;
}
export function clampLines(lines, width) {
    return width <= 0 ? [] : lines.map(line => truncateTerminalText(line, width));
}
export function linesComponent(lines) {
    return { render: width => clampLines(lines, width), invalidate() { } };
}
//# sourceMappingURL=tui-width.js.map