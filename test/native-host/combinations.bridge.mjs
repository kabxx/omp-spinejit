import { createOmpExtension } from '../../dist/omp/extension.js';

// Public native consumers and observation only: no replacement native state or hooks.
export default function combinationsBridge(api) {
  let runtime;
  let context;
  let commitGate;
  api.on('before_agent_start', (_event, ctx) => { context = ctx; });
  createOmpExtension({
    onSessionReady(info) { runtime = info.runtime; },
    async onSamplingCommit() {
      if (!commitGate) return;
      const gate = commitGate;
      commitGate = undefined;
      context.ui.notify(`COMBO-COMMIT-HELD:${gate.token}`, 'info');
      await gate.promise;
      context.ui.notify(`COMBO-COMMIT-RELEASED:${gate.token}`, 'info');
    },
  })(api);
  const releases = new Map();

  function live(ctx) {
    const session = api.pi.AgentRegistry.global().get(ctx.agent.id)?.session;
    if (!session || session.sessionManager !== ctx.sessionManager) {
      throw new Error('Combinations bridge requires the actual live native session');
    }
    return session;
  }

  async function snapshot(session) {
    await session.sessionManager.flush();
    const { source } = await runtime.client.execute({ type: 'source_snapshot' });
    const { projection } = await runtime.client.execute({ type: 'preview' });
    return {
      source, projection,
      sessionId: session.sessionManager.getSessionId(),
      sessionFile: session.sessionManager.getSessionFile(),
      branch: session.sessionManager.getBranch(),
      messages: structuredClone(session.state.messages),
      streaming: session.isStreaming,
    };
  }

  api.registerCommand('native-combination', {
    description: 'Exercise native operation combinations against the live session',
    async handler(args, ctx) {
      const { action, token, text } = JSON.parse(args);
      const session = live(ctx);
      let result;
      if (action === 'inspect') {
        result = { snapshot: await snapshot(session) };
      } else if (action === 'inspect-cursor') {
        const { projection } = await runtime.client.execute({ type: 'preview' });
        result = { cursor: projection.cursor };
      } else if (action === 'reset') {
        const before = await snapshot(session);
        const reset = await session.resetSessionContext();
        await session.sessionManager.flush();
        result = { before, reset, sessionId: session.sessionManager.getSessionId(),
          sessionFile: session.sessionManager.getSessionFile(), messages: structuredClone(session.state.messages) };
      } else if (action === 'thinking') {
        const before = await snapshot(session);
        result = { before, shake: await session.shake('thinking'), after: await snapshot(session) };
      } else if (action === 'idle-custom' || action === 'queue-custom') {
        const streaming = session.isStreaming;
        const agentStreaming = session.agent.state.isStreaming;
        let invoked = false;
        if (action === 'idle-custom') {
          if (agentStreaming) throw new Error('Resource append requires an idle native agent');
          // Maintenance keeps AgentSession.isStreaming true via its enclosing
          // prompt. Use the public durable resource producer, not the user queue.
          session.sessionManager.appendCustomMessageEntry(
            'native-combination.resource', text, false, undefined, 'agent',
          );
        } else {
          invoked = await session.sendCustomMessage({
            customType: 'native-combination.resource', content: text, display: false, attribution: 'agent',
          }, { triggerTurn: false, deliverAs: 'followUp' });
        }
        await session.sessionManager.flush();
        result = { invoked, streaming, agentStreaming, branch: session.sessionManager.getBranch() };
      } else if (action === 'hold-commit') {
        if (commitGate) throw new Error('A commit observer is already held');
        let release;
        const promise = new Promise((resolve) => { release = resolve; });
        releases.set(token, release);
        commitGate = { token, promise };
        result = { armed: true };
      } else if (action === 'release-commit') {
        const release = releases.get(text);
        if (!release) throw new Error(`Unknown commit gate: ${text}`);
        releases.delete(text);
        release();
        result = { released: true };
      } else {
        throw new Error(`Unsupported native combination action: ${action}`);
      }
      ctx.ui.notify(`COMBO-RESULT:${JSON.stringify({ token, ...result })}`, 'info');
    },
  });
}
