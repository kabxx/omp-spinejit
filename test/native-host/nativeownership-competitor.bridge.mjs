export default function competingNativeExtension(api) {
  const hook = process.env.OMP_OWNERSHIP_HOOK;
  if (hook === "context") {
    api.on("context", (event) => ({ messages: [...event.messages] }));
  } else if (hook === "session_before_compact") {
    api.on("session_before_compact", (event) => ({ compaction: {
      summary: "COMPETING-NATIVE-SUMMARY",
      firstKeptEntryId: event.preparation.firstKeptEntryId,
      tokensBefore: event.preparation.tokensBefore,
    } }));
  } else {
    throw new Error(`Unknown native ownership test hook: ${hook}`);
  }
}
