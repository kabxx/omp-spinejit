import * as AIError from '@oh-my-pi/pi-ai/error';
import { createOmpExtension } from '../../dist/omp/extension.js';

// Observe real SDK-classified failures and native durable state; never replace
// streamFn, provider clients, recovery policy, or journal messages.
export default function providerFailuresBridge(api) {
  let runtime;
  createOmpExtension({ onSessionReady(info) { runtime = info.runtime; } })(api);
  api.registerCommand('provider-snapshot', {
    description: 'Inspect provider failure recovery and canonical Spine Source',
    handler: async (args, ctx) => {
      const session = api.pi.AgentRegistry.global().get(ctx.agent.id)?.session;
      if (!runtime || !session || session.sessionManager !== ctx.sessionManager) {
        throw new Error('Provider bridge requires the live native session');
      }
      await session.sessionManager.flush();
      const { source } = await runtime.client.execute({ type: 'source_snapshot' });
      const { projection } = await runtime.client.execute({ type: 'preview' });
      const errors = session.sessionManager.getBranch()
        .filter((entry) => entry.type === 'message' && entry.message.role === 'assistant' && entry.message.stopReason === 'error')
        .map(({ message }) => {
          const id = message.errorId;
          return {
            message, id,
            transient: AIError.is(id, AIError.Flag.Transient),
            timeout: AIError.is(id, AIError.Flag.Timeout),
            contentBlocked: AIError.is(id, AIError.Flag.ContentBlocked),
            retriable: AIError.retriable(id),
          };
        });
      ctx.ui.notify(`PROVIDER-SNAPSHOT:${args.trim()}:${JSON.stringify({
        source, projection, errors, messages: session.state.messages,
      })}`, 'info');
    },
  });
}
