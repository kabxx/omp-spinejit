import { AgentRegistry } from '@oh-my-pi/pi-coding-agent';
import { createOmpExtension } from '../../dist/omp/extension.js';

export default function projectionPressureBridge(api) {
  if (process.env.OMP_PRESSURE_NATIVE_ONLY !== '1') {
    createOmpExtension(process.env.OMP_PRESSURE_SUMMARY_ERROR === '1' ? {
      compactionCompletion() { throw new Error('PRIVATE-PRESSURE-OWNER-FAILURE'); },
    } : {})(api);
  }
  api.registerCommand('pressure-inspect', {
    description: 'Inspect actual native and owned compaction context token estimates',
    handler(_args, ctx) {
      const session = AgentRegistry.global().get(ctx.agent.id)?.session;
      if (session?.sessionManager !== ctx.sessionManager) throw new Error('Wrong native session');
      const raw = session.agent.state.messages;
      const pending = [{ role: 'user', content: 'Next small user request', timestamp: Date.now() }];
      const projected = process.env.OMP_PRESSURE_NATIVE_ONLY === '1'
        ? undefined : session.extensionRunner.projectCompactionContext(raw, pending);
      const count = (messages) => session.agent.tokenizer.countMessages(messages, { excludeEncryptedReasoning: true });
      ctx.ui.notify('PRESSURE-STATE:' + JSON.stringify({
        rawTokens: count(raw), projectedTokens: projected === undefined ? null : count(projected),
        anchored: session.getContextBreakdown()?.anchored,
        sessionFile: ctx.sessionManager.getSessionFile(),
      }), 'info');
    },
  });
}
