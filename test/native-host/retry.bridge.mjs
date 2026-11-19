import { createOmpExtension } from '../../dist/omp/extension.js';

// Observe the real extension runtime; never alter the native transcript or recovery.
export default function retryBridge(api) {
  let runtime;
  createOmpExtension({
    onSessionReady(info) { runtime = info.runtime; },
  })(api);
  api.registerCommand('retry-snapshot', {
    description: 'Inspect native retry canonical Source and current Spine projection',
    handler: async (args, ctx) => {
      if (!runtime) throw new Error('Spine runtime is not ready');
      const { source } = await runtime.client.execute({ type: 'source_snapshot' });
      const { projection } = await runtime.client.execute({ type: 'preview' });
      ctx.ui.notify(`RETRY-SNAPSHOT:${args.trim()}:${JSON.stringify({
        source,
        projection,
        branch: ctx.sessionManager.getBranch(),
      })}`, 'info');
    },
  });
}
