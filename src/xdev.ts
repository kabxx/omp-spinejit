import { isSpineToolName } from "@spinejit/spine-sdk/host";

const XD_PREFIX = "xd://";

export type HostToolCall = {
  toolName: string;
  input: Record<string, unknown>;
};

/** Map an OMP host tool_call (often `write` + `xd://spine_*`) to the Spine tool. */
export function decodeHostToolCall(toolName: string, input: Record<string, unknown>): HostToolCall {
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

export function decodeHostToolResult(
  toolName: string,
  details: unknown,
): string {
  if (details !== null && typeof details === "object") {
    const xdev = (details as { xdev?: unknown }).xdev;
    if (xdev !== null && typeof xdev === "object") {
      const inner = (xdev as { tool?: unknown }).tool;
      if (typeof inner === "string" && isSpineToolName(inner)) return inner;
    }
  }
  return toolName;
}

function deviceNameFromXdPath(path: string): string | undefined {
  if (!path.startsWith(XD_PREFIX)) return undefined;
  const name = path.slice(XD_PREFIX.length).split("/")[0] ?? "";
  return isSpineToolName(name) ? name : undefined;
}

function parseWriteContent(content: unknown): Record<string, unknown> {
  if (content !== null && typeof content === "object" && !Array.isArray(content)) {
    return content as Record<string, unknown>;
  }
  if (typeof content !== "string") return {};
  const text = content.trim();
  if (text.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return {};
  }
  return {};
}
