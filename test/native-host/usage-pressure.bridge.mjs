import { createOmpExtension } from '../../dist/omp/extension.js';

export default function usagePressureBridge(api) {
  createOmpExtension()(api);
  api.registerCommand('usage-pressure-inspect', {
    description: 'Inspect the actual owned native projection without changing pressure or usage',
    handler(args, ctx) {
      const { pending, marker } = args.trim() ? JSON.parse(args) : {};
      const session = api.pi.AgentRegistry.global().get(ctx.agent.id)?.session;
      if (session?.sessionManager !== ctx.sessionManager) throw new Error('Wrong native session');
      const raw = session.agent.state.messages;
      const additions = pending === undefined ? undefined : [{ role: 'user', content: pending, timestamp: Date.now() }];
      const projected = session.extensionRunner.projectCompactionContext(raw, additions);
      if (projected === undefined) throw new Error('Spine must own the compaction projection');
      const text = (message) => typeof message.content === 'string' ? message.content
        : (message.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\n');
      const projectedText = projected.map(text).join('\n');
      const count = (messages) => session.agent.tokenizer.countMessages(messages, { excludeEncryptedReasoning: true });
      ctx.ui.notify('USAGE-PRESSURE-STATE:' + JSON.stringify({
        rawTokens: count(raw),
        projectedTokens: count(projected),
        projectedTextLength: projectedText.length,
        markerVisible: marker === undefined ? null : projectedText.includes(marker),
        assistants: projected.filter((message) => message.role === 'assistant').map((message) => ({
          text: text(message).slice(0, 160), usage: message.usage, stopReason: message.stopReason,
        })),
        sessionFile: ctx.sessionManager.getSessionFile(),
        sessionId: ctx.sessionManager.getSessionId(),
      }), 'info');
    },
  });
}
