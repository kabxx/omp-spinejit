import { appendFile } from 'node:fs/promises';
import { createOmpExtension } from '../../dist/omp/extension.js';

export default function tuiBridge(api) {
  let runtime;
  createOmpExtension({ onSessionReady(info) { runtime = info.runtime; } })(api);
  api.on('session_start', (_event, ctx) => ctx.ui.notify('TUI-NATIVE-READY', 'info'));
  api.registerCommand('native-tui-inspect', {
    description: 'Inspect the real TUI session after keyboard operations',
    async handler(args, ctx) {
      const session = api.pi.AgentRegistry.global().get(ctx.agent.id)?.session;
      if (!runtime || !session || session.sessionManager !== ctx.sessionManager) throw new Error('TUI bridge requires its real native session');
      await session.sessionManager.flush();
      const { source } = await runtime.client.execute({ type: 'source_snapshot' });
      const { projection } = await runtime.client.execute({ type: 'preview' });
      await appendFile(process.env.OMP_TUI_PROBE_PATH, JSON.stringify({ label: args.trim(), source, projection, sessionId: session.sessionId, sessionFile: session.sessionManager.getSessionFile() }) + '\n');
      ctx.ui.notify(`TUI-INSPECTED-${args.trim()}`, 'info');
    },
  });
}
