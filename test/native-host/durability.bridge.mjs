import { createOmpExtension } from '../../dist/omp/extension.js';
import { renameSync, writeFileSync } from 'node:fs';
import { dirname, sep } from 'node:path';

// Stop only after the boundary has been flushed by the live SessionManager.
// The isolated fixture sends SIGKILL; this bridge only holds the boundary.
export default function durabilityBridge(api) {
  let runtime;
  let context;
  let armed;
  const errors = [];
  const notices = [];
  const observed = new WeakSet();

  const serializeError = (error) => ({ name: error.name, message: error.message, code: error.code ?? null });
  function observe(ctx) {
    context = ctx;
    const manager = ctx.sessionManager;
    if (observed.has(manager)) return;
    observed.add(manager);
    manager.onPersistenceError((error) => {
      const value = serializeError(error);
      errors.push(value);
      context.ui.notify(`DURABILITY-STORAGE-ERROR:${JSON.stringify(value)}`, 'error');
    });
    manager.onPersistenceNotice((notice) => {
      notices.push(structuredClone(notice));
      context.ui.notify(`DURABILITY-STORAGE-NOTICE:${JSON.stringify(notice)}`, 'warning');
    });
  }
  api.on('session_start', (_event, ctx) => observe(ctx));
  api.on('session_switch', (_event, ctx) => observe(ctx));
  api.on('before_agent_start', (_event, ctx) => observe(ctx));

  function holdBoundary(boundary, ctx) {
    if (armed?.boundary !== boundary) return;
    const token = armed.token;
    armed = undefined;
    const manager = ctx.sessionManager;
    manager.flushSync();
    ctx.ui.notify(`DURABILITY-HELD:${JSON.stringify({
      token, boundary, sessionFile: manager.getSessionFile(), leafId: manager.getLeafId(),
    })}`, 'info');
    // SIGSTOP holds synchronous append and event observers in place.
    process.kill(process.pid, 'SIGSTOP');
  }

  const append = api.appendEntry.bind(api);
  api.appendEntry = (type, data) => {
    const result = append(type, data);
    const boundary = type === 'spine.source.v1' ? 'source-checkpoint'
      : type === 'spine.archive.v1' ? data.record.type : null;
    if (boundary !== null) holdBoundary(boundary, context);
    return result;
  };
  // The receipt is durable here, before Spine's event handler applies it
  // and before Native acknowledges the command.
  api.on('session_compact', (event, ctx) => {
    if (event.compactionEntry?.details?.['spine.compact.v1']) holdBoundary('compact-receipt', ctx);
  });

  createOmpExtension({ onSessionReady(info) { runtime = info.runtime; } })(api);

  function live(ctx) {
    const session = api.pi.AgentRegistry.global().get(ctx.agent.id)?.session;
    if (!session || session.sessionManager !== ctx.sessionManager) {
      throw new Error('Durability bridge requires the active Native AgentSession');
    }
    return session;
  }
  async function attempt(operation) {
    try { return { ok: true, value: (await operation()) ?? null }; }
    catch (error) { return { ok: false, error: serializeError(error) }; }
  }
  async function snapshot(ctx) {
    if (!runtime) throw new Error('Native Spine runtime is not ready');
    const flush = await attempt(() => ctx.sessionManager.flush());
    const { source } = await runtime.client.execute({ type: 'source_snapshot' });
    const { projection } = await runtime.client.execute({ type: 'preview' });
    return {
      sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile(),
      source, projection, flush, errors: [...errors], notices: [...notices],
      branch: structuredClone(ctx.sessionManager.getBranch()),
      messages: structuredClone(live(ctx).state.messages),
    };
  }
  api.registerCommand('native-durability-case', {
    description: 'Exercise actual Native persistence and precise crash boundaries',
    handler: async (args, ctx) => {
      observe(ctx);
      const { action, token, boundary, sessionFile } = JSON.parse(args);
      const manager = ctx.sessionManager;
      let data;
      if (action === 'snapshot') data = { snapshot: await snapshot(ctx) };
      else if (action === 'arm') {
        if (armed) throw new Error('A durability boundary is already armed');
        armed = { boundary, token };
        data = { armed: boundary };
      } else if (action === 'obstruct') {
        manager.flushSync();
        const directory = dirname(manager.getSessionFile());
        const root = dirname(process.env.OMP_CODING_AGENT_DIR);
        if (!directory.startsWith(root + sep)) throw new Error('Refusing to obstruct a non-fixture directory');
        const backup = directory + '.durability-backup';
        renameSync(directory, backup);
        writeFileSync(directory, 'Fixture-owned ENOTDIR obstruction.\n');
        data = { directory, backup };
      } else if (action === 'probe-append') {
        // Real Native hot append: intentionally nonthrowing; flush exposes the
        // producer's latched errno. A late subscriber must replay that failure.
        const entryId = manager.appendCustomEntry('durability.native-probe', { token });
        const flush = await attempt(() => manager.flush());
        const replayed = [];
        const unsubscribe = manager.onPersistenceError((error) => replayed.push(serializeError(error)));
        unsubscribe();
        data = { entryId, flush, replayed, errors: [...errors] };
      } else if (action === 'rewrite') {
        data = { result: await attempt(() => manager.rewriteEntries()), flush: await attempt(() => manager.flush()) };
      } else if (action === 'late-notices') {
        const replayed = [];
        const unsubscribe = manager.onPersistenceNotice((notice) => replayed.push(structuredClone(notice)));
        unsubscribe();
        data = { notices: [...notices], replayed };
      } else if (action === 'new') data = { result: await attempt(() => live(ctx).newSession()) };
      else if (action === 'reset') data = { result: await attempt(() => live(ctx).resetSessionContext()), flush: await attempt(() => manager.flush()) };
      else if (action === 'switch') data = { result: await attempt(() => live(ctx).switchSession(sessionFile)) };
      else throw new Error(`Unknown durability action: ${action}`);
      ctx.ui.notify(`DURABILITY-RESULT:${JSON.stringify({ token, ...data })}`, 'info');
    },
  });
}
