import { createOmpExtension } from "../../dist/omp/extension.js";

// Exercise the actual native context reset, never the extension's new-session API.
export default function resetBridge(api) {
  createOmpExtension()(api);
  const events = { session_start: 0, session_switch: 0 };
  let busyResetToken;
  for (const name of Object.keys(events)) {
    api.on(name, () => { events[name] += 1; });
  }

  function live(ctx) {
    const session = api.pi.AgentRegistry.global().get(ctx.agent.id)?.session;
    if (!session || session.sessionManager !== ctx.sessionManager) {
      throw new Error("Reset bridge requires the active native AgentSession");
    }
    return session;
  }

  async function snapshot(session) {
    await session.sessionManager.flush();
    const manager = session.sessionManager;
    return {
      sessionId: manager.getSessionId(),
      sessionFile: manager.getSessionFile(),
      title: manager.getSessionName() ?? null,
      cwd: manager.getCwd(),
      model: session.model ? { id: session.model.id, provider: session.model.provider } : null,
      autoRetry: session.autoRetryEnabled,
      autoCompaction: session.autoCompactionEnabled,
      messages: structuredClone(session.state.messages),
      entries: manager.getBranch().map(({ id, type }) => ({ id, type })),
      events: { ...events },
    };
  }

  function report(ctx, token, data) {
    ctx.ui.notify(`CASE-RESULT:${JSON.stringify({ token, ...data })}`, "info");
  }

  api.registerCommand("native-reset-case", {
    description: "Native reset consumer test bridge",
    handler: async (args, ctx) => {
      const { action, token, title } = JSON.parse(args);
      const session = live(ctx);
      if (title !== undefined) await api.setSessionName(title);
      if (action === "snapshot") {
        report(ctx, token, { snapshot: await snapshot(session) });
      } else if (action === "reset") {
        const before = await snapshot(session);
        const result = await session.resetSessionContext();
        report(ctx, token, { before, result: result ?? null, after: await snapshot(session) });
      } else if (action === "arm-busy-reset") {
        busyResetToken = token;
        report(ctx, token, { armed: true });
      } else {
        throw new Error(`Unknown native reset bridge action: ${action}`);
      }
    },
  });

  // A pre-provider hook executes inside a real streaming native turn. Calling
  // reset here tests the native busy refusal without fabricating agent state.
  api.on("before_provider_request", async (_event, ctx) => {
    if (busyResetToken === undefined) return;
    const token = busyResetToken;
    busyResetToken = undefined;
    const session = live(ctx);
    const before = await snapshot(session);
    const streaming = session.isStreaming;
    const result = await session.resetSessionContext();
    report(ctx, `${token}:busy`, {
      streaming,
      before,
      result: result ?? null,
      after: await snapshot(session),
    });
  });
}
