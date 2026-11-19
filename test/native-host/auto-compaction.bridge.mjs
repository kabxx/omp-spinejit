import { createOmpExtension } from "../../dist/omp/extension.js";

// Hold the pressure turn's real observer until the test sees native maintenance.
// Provider usage, transcript persistence and summary completion remain native.
export default function automaticCompactionBridge(api) {
  let pendingCommits = 0;
  let settledCommits = 0;
  let context;
  let releaseObserver;
  const observerReleased = new Promise((resolve) => { releaseObserver = resolve; });
  api.on("before_agent_start", (_event, ctx) => { context = ctx; });
  api.registerCommand("auto-release-observer", {
    description: "Release the held post-commit observer in the native compaction test",
    handler() { releaseObserver(); },
  });
  createOmpExtension({
    async onSamplingCommit() {
      pendingCommits += 1;
      try {
        if (settledCommits === 2) {
          context.ui.notify("AUTO-COMMIT-OBSERVER-HELD", "info");
          await observerReleased;
        }
        settledCommits += 1;
      } finally {
        pendingCommits -= 1;
      }
    },
    async compactionCompletion(...args) {
      if (pendingCommits !== 0 || settledCommits !== 3) {
        throw new Error(`Native automatic summary raced sampling settlement: pending=${pendingCommits}, settled=${settledCommits}`);
      }
      const { completeSimple } = await import("@oh-my-pi/pi-ai");
      return completeSimple(...args);
    },
  })(api);
}
