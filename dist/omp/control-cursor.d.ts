declare const CONTROL_TOOLS: readonly ["spine_open", "spine_close", "spine_next"];
export type ControlToolName = (typeof CONTROL_TOOLS)[number];
export declare function isControlToolName(name: string): name is ControlToolName;
export {};
//# sourceMappingURL=control-cursor.d.ts.map