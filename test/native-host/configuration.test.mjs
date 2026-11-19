import assert from 'node:assert/strict';
import { cp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createNativeFixture, readJournal, spineCall, visibleText } from './fixture.mjs';
import { assertFoldedMemory, assertPendingFold } from './fold-assertions.mjs';

const packageRoot = new URL('../../', import.meta.url);
const workspaceModules = fileURLToPath(new URL('../../../../node_modules/', import.meta.url));
const controls = ['open', 'close', 'next', 'spawn'];

// Each case loads the actual compiled extension from a separate OMP package.
// Neither the installed package nor the Pi workspace configuration is mutated.
{
  const variant = 'review';
  test('native OMP local configuration drives JIT, device discovery and schema repair', { timeout: 180_000 }, async (t) => {
    const policy = `For this OMP ${variant} session, retain ${variant} evidence in every returned branch memory.`;
    const descriptions = Object.fromEntries(controls.map((control) => [control,
      `OMP ${variant} ${control} device: retain ${variant} evidence and use this device's canonical arguments.`]));
    const goal = `CONFIG-${variant}-FIRST`;
    const nextGoal = `CONFIG-${variant}-SECOND`;
    const firstMemory = `CONFIG-${variant}-FIRST-MEMORY`;
    const secondMemory = `CONFIG-${variant}-SECOND-MEMORY`;
    const fixture = await createNativeFixture(t, {
      label: `config-${variant}`,
      onRequest(request, { index, send }) {
        const system = visibleText(request.messages.filter((message) => message.role === 'system' || message.role === 'developer'));
        assert.ok(system.includes(policy), 'The provider must receive the OMP-local JIT policy');
        assert.ok(!system.includes('PI-CONFIG-MUST-NOT-LOAD'));
        const tools = request.tools.map((tool) => tool.function.name);
        assert.ok(tools.includes('read') && tools.includes('write'));
        for (const control of controls) assert.ok(!tools.includes(`spine_${control}`), 'Native controls remain discoverable devices');
        const toolText = visibleText(request.messages.filter((message) => message.role === 'tool'));
        switch (index) {
          case 1:
            return send(controls.map((control) => ({ name: 'read', arguments: {
              i: 'Discovering Spine controls', path: `xd://spine_${control}`,
            } })));
          case 2:
            for (const control of controls) {
              assert.ok(toolText.includes(descriptions[control]), `Native read must expose the local ${control} description`);
            }
            return send(spineCall('spine_open', { goal: 17 }));
          case 3:
            assert.ok(request.messages.some((message) => message.role === 'tool' && message.tool_call_id === 'native-path-2-0'));
            return send(spineCall('spine_open', { goal }));
          case 4:
            assert.ok(visibleText(request.messages).includes(`summary="${goal}"`));
            return send(spineCall('spine_next', { memory: firstMemory, goal: nextGoal }));
          case 5:
            assert.ok(visibleText(request.messages).includes(`summary="${nextGoal}"`));
            assertPendingFold(request, '1.1', firstMemory);
            return send('The configured Next succeeded.');
          case 6:
            assertFoldedMemory(request, '1.1', firstMemory);
            return send(spineCall('spine_close', { memory: secondMemory }));
          case 7:
            assertPendingFold(request, '1.2', secondMemory);
            return send(`CONFIG-${variant}-DONE`);
          case 8:
            assertFoldedMemory(request, '1.2', secondMemory);
            return send(`CONFIG-${variant}-FOLDED-MEMORY-VERIFIED`);
          default:
            assert.fail(`Unexpected native configuration request ${index}`);
        }
      },
    });
    const sandbox = join(fixture.root, 'package-layout');
    const omp = join(sandbox, 'packages', 'omp');
    await mkdir(omp, { recursive: true });
    await cp(fileURLToPath(new URL('dist/', packageRoot)), join(omp, 'dist'), { recursive: true });
    await symlink(workspaceModules, join(sandbox, 'node_modules'), 'dir');
    let config = await readFile(new URL('spine.toml', packageRoot), 'utf8');
    config = config.replace(/jit = '''/, `jit = '''${policy}\n`);
    for (const control of controls) {
      config = config.replace(new RegExp(`(\\[tools\\.${control}\\]\\s*description = ")`), `$1${descriptions[control]} `);
    }
    await writeFile(join(omp, 'spine.toml'), config);
    // A sibling Pi package is present but its config is deliberately invalid.
    // Successful native parsing/discovery must therefore come from OMP alone.
    const pi = join(sandbox, 'packages', 'plugin');
    await mkdir(pi, { recursive: true });
    await writeFile(join(pi, 'spine.toml'), 'PI-CONFIG-MUST-NOT-LOAD = [\n');
    const extensionArgument = fixture.invocation.args.indexOf('--extension') + 1;
    assert.ok(extensionArgument > 0);
    fixture.invocation.args[extensionArgument] = join(omp, 'dist', 'omp', 'extension.js');
    const rpc = await fixture.start();
    const result = await rpc.prompt(`Exercise the ${variant} branch workflow using its discovered native devices.`);
    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.equal((await rpc.prompt('Close the next configured branch.')).status, 'completed');
    assert.equal((await rpc.prompt('Recall the second configured branch memory.')).status, 'completed');
    assert.equal(fixture.requests.length, 8);
    const data = await rpc.command('get_state');
    assert.ok(data.sessionFile, 'Native session must expose its persisted journal');
    const rows = await readJournal(data.sessionFile);
    assert.equal(rows.filter((row) => row.customType === 'spine.fault.v1').length, 0);
    const receipts = rows.filter((row) => row.message?.role === 'toolResult').map((row) => row.message);
    for (const control of ['open', 'next', 'close']) {
      assert.ok(receipts.some((receipt) => receipt.details?.xdev?.tool === `spine_${control}` && receipt.isError !== true),
        `Real native ${control} must execute successfully with the local config`);
    }
    assert.ok(receipts.some((receipt) => receipt.toolCallId === 'native-path-2-0' && receipt.isError === true),
      'The real journal must retain the rejected invalid control before its successful repair');
    await rpc.close();
  });
}
