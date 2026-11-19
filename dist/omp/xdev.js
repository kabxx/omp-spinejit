import { isSpineToolName } from "@spinejit/spine-sdk/host";
const XD_PREFIX = "xd://";
/** Map an OMP host tool_call (often `write` + `xd://spine_*`) to the Spine tool. */
export function decodeHostToolCall(toolName, input) {
    if (isSpineToolName(toolName)) {
        return { toolName, input };
    }
    if (toolName !== "write") {
        return { toolName, input };
    }
    const path = typeof input.path === "string" ? input.path : "";
    const device = deviceNameFromXdPath(path);
    if (device === undefined) {
        return { toolName, input };
    }
    return { toolName: device, input: parseWriteContent(input.content) };
}
export function decodeHostToolResult(toolName, details) {
    if (details !== null && typeof details === "object") {
        const xdev = details.xdev;
        if (xdev !== null && typeof xdev === "object") {
            const inner = xdev.tool;
            if (typeof inner === "string" && isSpineToolName(inner))
                return inner;
        }
    }
    return toolName;
}
function deviceNameFromXdPath(path) {
    if (!path.startsWith(XD_PREFIX))
        return undefined;
    const name = path.slice(XD_PREFIX.length).split("/")[0] ?? "";
    return isSpineToolName(name) ? name : undefined;
}
function parseWriteContent(content) {
    if (content !== null && typeof content === "object" && !Array.isArray(content)) {
        return content;
    }
    if (typeof content !== "string")
        return {};
    const text = content.trim();
    if (text.length === 0)
        return {};
    try {
        const parsed = JSON.parse(text);
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
            return parsed;
        }
    }
    catch {
        return {};
    }
    return {};
}
//# sourceMappingURL=xdev.js.map