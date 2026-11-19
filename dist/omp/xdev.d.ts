export type HostToolCall = {
    toolName: string;
    input: Record<string, unknown>;
};
/** Map an OMP host tool_call (often `write` + `xd://spine_*`) to the Spine tool. */
export declare function decodeHostToolCall(toolName: string, input: Record<string, unknown>): HostToolCall;
export declare function decodeHostToolResult(toolName: string, details: unknown): string;
//# sourceMappingURL=xdev.d.ts.map