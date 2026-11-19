import { AgentRegistry } from "@oh-my-pi/pi-coding-agent";
import { createOmpExtension } from "../../dist/omp/extension.js";

// Gates only test observers. Neither Native state nor its compaction producer is replaced.
export default function compactionModesBridge(api) {
  let context;
  let pending = 0;
  let settled = 0;
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  const heldOrdinal = Number(process.env.OMP_MODE_HOLD_OBSERVER ?? 0);
  api.on("before_agent_start", (_event, ctx) => { context = ctx; });
  api.registerCommand("modes-release-observer", {
    description: "Release the native mode test's post-commit observer",
    async handler() { release(); },
  });
  api.registerCommand("modes-idle-maintenance", {
    description: "Invoke public Native idle maintenance (RPC does not own the TUI idle timer)",
    async handler(_args, ctx) {
      const session = AgentRegistry.global().get(ctx.agent.id)?.session;
      if (!session || session.sessionManager.getSessionId() !== ctx.sessionManager.getSessionId()) {
        throw new Error("Idle maintenance must use this process's actual registered Native session");
      }
      if (session.isStreaming || !ctx.isIdle()) throw new Error("Idle maintenance requires Native quiescence");
      ctx.ui.notify("MODES-IDLE-API:AgentSession.runIdleCompaction", "info");
      await session.runIdleCompaction();
      ctx.ui.notify("MODES-IDLE-SETTLED", "info");
    },
  });
  createOmpExtension({
    async onSamplingCommit() {
      pending += 1;
      try {
        if (settled + 1 === heldOrdinal) {
          context.ui.notify("MODES-OBSERVER-HELD", "info");
          await released;
        }
        settled += 1;
        context.ui.notify(`MODES-OBSERVER-SETTLED:${settled}`, "info");
      } finally { pending -= 1; }
    },
    async compactionCompletion(...args) {
      if (pending !== 0) throw new Error(`Summary raced ${pending} real sampling observers`);
      context.ui.notify(`MODES-SUMMARY-CALLBACK:${settled}`, "info");
      const signal = args[2]?.signal;
      const abort = () => context.ui.notify("MODES-SUMMARY-ABORTED", "info");
      signal?.addEventListener("abort", abort, { once: true });
      try {
        const { completeSimple } = await import("@oh-my-pi/pi-ai");
        const response = await completeSimple(...args);
        context.ui.notify(`MODES-SUMMARY-RETURNED:${response.stopReason}`, "info");
        return response;
      } finally { signal?.removeEventListener("abort", abort); }
    },
  })(api);
}
