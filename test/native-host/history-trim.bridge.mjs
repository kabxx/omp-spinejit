import { createOmpExtension } from '../../dist/omp/extension.js';

const HEAVY_RESULT = 'OLD-TOOL-PAYLOAD ' + 'discardable-result '.repeat(256);
const KEPT_RESULT = 'KEPT-TOOL-RESULT';
const IMAGE_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNQ6tgNAAI1AWbwtPEaAAAAAElFTkSuQmCC';

export default function historyTrimBridge(api) {
  let runtime;
  createOmpExtension({ onSessionReady(info) { runtime = info.runtime; } })(api);

  for (const [name, text] of [
    ['native_trim_heavy', HEAVY_RESULT],
    ['native_trim_kept', KEPT_RESULT],
  ]) {
    api.registerTool({
      name,
      label: name,
      description: 'Return a history-trim test payload through the native tool runner.',
      parameters: api.typebox.Type.Object({}),
      async execute() { return { content: [{ type: 'text', text }], details: {} }; },
    });
  }

  api.registerTool({
    name: 'native_trim_image',
    label: 'Native trim image',
    description: 'Produce a fixture PNG with non-image text through the actual native tool runner.',
    parameters: api.typebox.Type.Object({}),
    async execute() {
      return {
        content: [
          { type: 'text', text: 'IMAGE-TOOL-TEXT-TO-KEEP' },
          { type: 'image', data: IMAGE_PNG, mimeType: 'image/png' },
        ],
        details: { fixture: 'one-pixel-png' },
      };
    },
  });

  api.registerCommand('native-history-trim', {
    description: 'Exercise the public native shake API and inspect its durable result.',
    async handler(args, ctx) {
      const { operation, nonce } = JSON.parse(args);
      const session = api.pi.AgentRegistry.global().get(ctx.agent.id)?.session;
      if (!session) throw new Error('Native root AgentSession is unavailable');
      let result;
      if (operation === 'elide') {
        result = await session.shake('elide', {
          config: {
            protectTokens: 0,
            minSavings: 0,
            protectedTools: ['native_trim_kept', 'write'],
            fenceMinTokens: 1,
          },
        });
      } else if (operation === 'thinking') {
        result = await session.shake('thinking');
      } else if (operation === 'images') {
        result = await session.shake('images');
      } else if (operation !== 'inspect') {
        throw new Error(`Unsupported native history operation: ${operation}`);
      }
      const source = (await runtime.client.execute({ type: 'source_snapshot' })).source;
      ctx.ui.notify('CASE-RESULT:' + JSON.stringify({
        nonce,
        result,
        source,
        artifactPath: result?.artifactId ? await session.sessionManager.getArtifactPath(result.artifactId) : null,
        branch: session.sessionManager.getBranch(),
        sessionPath: session.sessionManager.getSessionFile(),
      }), 'info');
    },
  });
}
