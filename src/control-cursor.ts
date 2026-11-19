const CONTROL_TOOLS = ["spine_open", "spine_close", "spine_next"] as const;

export type ControlToolName = (typeof CONTROL_TOOLS)[number];

export function isControlToolName(name: string): name is ControlToolName {
  return (CONTROL_TOOLS as readonly string[]).includes(name);
}
