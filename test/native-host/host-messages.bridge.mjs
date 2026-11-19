import { createOmpExtension } from '../../dist/omp/extension.js';

// Only public native producers and read-only Spine observation. No event,
// transcript, storage, tool result or extension-handler replacement.
export default function hostMessagesBridge(api) {
  let runtime;
  createOmpExtension({ onSessionReady(info) { runtime = info.runtime; } })(api);

  function live(ctx) {
    const session = api.pi.AgentRegistry.global().get(ctx.agent.id)?.session;
    if (!session || session.sessionManager !== ctx.sessionManager) {
      throw new Error('Host messages bridge requires the actual active AgentSession');
    }
    return session;
  }
  function report(ctx, token, data) {
    ctx.ui.notify(`HOST-MESSAGES-RESULT:${JSON.stringify({ token, ...data })}`, 'info');
  }
  async function snapshot(session) {
    await session.sessionManager.flush();
    const { source } = await runtime.client.execute({ type: 'source_snapshot' });
    const { projection } = await runtime.client.execute({ type: 'preview' });
    return {
      source, projection, sessionFile: session.sessionManager.getSessionFile(),
      branch: structuredClone(session.sessionManager.getBranch()),
      messages: structuredClone(session.state.messages),
    };
  }
  async function produce(session, action, text) {
    if (action === 'present-todo') {
      await session.setActiveToolPresentation(
        [...new Set([...session.getEnabledToolNames(), 'todo'])],
        session.getMountedXdevToolNames().filter((name) => name !== 'todo'),
      );
      return { topLevel: session.getActiveToolNames().includes('todo') };
    }
    if (action === 'idle-custom' || action === 'streaming-aside') {
      const streaming = session.agent.state.isStreaming;
      if (streaming !== (action === 'streaming-aside')) {
        throw new Error(`Unexpected native streaming state for ${action}: ${streaming}`);
      }
      const invoked = await session.sendCustomMessage({
        customType: 'native-host-messages.resource', content: text,
        display: false, attribution: 'agent',
      }, { triggerTurn: false, ...(action === 'streaming-aside' ? { deliverAs: 'aside' } : {}) });
      return { invoked, streaming };
    }
    if (action === 'bash' || action === 'excluded-bash') {
      const result = await session.executeBash(`printf '%s\\n' '${text}'`, undefined, {
        excludeFromContext: action === 'excluded-bash',
      });
      return { result };
    }
    if (action === 'python' || action === 'excluded-python' || action === 'streaming-python') {
      const streaming = session.isStreaming;
      const result = await session.executePython(text, undefined, {
        excludeFromContext: action === 'excluded-python',
      });
      return { result, streaming, pending: session.hasPendingPythonMessages };
    }
    if (action === 'ephemeral') {
      return { result: await session.runEphemeralTurn({ promptText: text, tools: false }) };
    }
    throw new Error(`Unknown host producer: ${action}`);
  }
  api.registerCommand('native-host-messages', {
    description: 'Observe real native source consumers and exercise public native producers',
    async handler(args, ctx) {
      const { action, token, text } = JSON.parse(args);
      const session = live(ctx);
      if (action === 'snapshot') {
        report(ctx, token, { snapshot: await snapshot(session) });
        return;
      }
      if (action === 'streaming-aside' || action === 'streaming-python' || action === 'ephemeral') {
        report(ctx, token, await produce(session, action, text));
        return;
      }
      // A slash-command itself is admitted prompt work. Let that real command
      // finish before invoking an idle producer, rather than mutating isStreaming
      // or manufacturing a journal entry to imitate the host's idle path.
      const deadline = Date.now() + 30_000;
      const runWhenIdle = async () => {
        if (session.isStreaming) {
          if (Date.now() >= deadline) {
            report(ctx, token, { error: 'Native session did not become idle' });
            return;
          }
          setTimeout(runWhenIdle, 10);
          return;
        }
        try {
          if (live(ctx) !== session) throw new Error('Native session changed before idle producer');
          const data = await produce(session, action, text);
          await session.sessionManager.flush();
          report(ctx, token, data);
        } catch (error) {
          report(ctx, token, { error: error.message });
        }
      };
      setTimeout(runWhenIdle, 0);
    },
  });
}
