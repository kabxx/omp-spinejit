import { createOmpExtension } from "../../dist/omp/extension.js";

export default function nativeOwnershipBridge(api) {
  let initialized = 0;
  let contextObservations = 0;
  let compactObservations = 0;
  const options = { onSessionReady() { initialized += 1; } };
  createOmpExtension(options)(api);
  if (process.env.OMP_OWNERSHIP_DUPLICATE === "true") createOmpExtension(options)(api);
  // Same-extension composition adds observers, not another context/summary owner.
  api.on("context", () => { contextObservations += 1; });
  api.on("session_before_compact", () => { compactObservations += 1; });
  api.registerCommand("ownership-inspect", {
    description: "Inspect this real native extension's initialization and public metadata",
    handler(_args, ctx) {
      const session = api.pi.AgentRegistry.global().get(ctx.agent.id)?.session;
      if (session?.sessionManager !== ctx.sessionManager) throw new Error("Expected this real native session");
      const runner = session.extensionRunner;
      ctx.ui.notify(`OWNERSHIP-STATE:${JSON.stringify({
        initialized, contextObservations, compactObservations,
        sessionId: ctx.sessionManager.getSessionId(),
        extensions: runner.getLoadedExtensions().map((extension) => ({
          path: extension.path, active: runner.isExtensionActive(extension.path),
          context: extension.handlers.get("context")?.length ?? 0,
          compact: extension.handlers.get("session_before_compact")?.length ?? 0,
        })),
      })}`, "info");
    },
  });
  api.registerCommand("ownership-reload", {
    description: "Reload this native session through the public AgentSession API",
    async handler(_args, ctx) {
      const session = api.pi.AgentRegistry.global().get(ctx.agent.id)?.session;
      if (session?.sessionManager !== ctx.sessionManager) throw new Error("Expected this real native session");
      await session.reload();
      // Keep the old command context out of the notification: reload may invalidate it.
    },
  });
}
