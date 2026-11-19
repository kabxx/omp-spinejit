import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

test('an installed OMP loader reports a missing package config instead of using embedded defaults', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'omp-config-missing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'dist', 'omp');
  await mkdir(directory, { recursive: true });
  const loader = join(directory, 'spine-config.mjs');
  await copyFile(new URL('../dist/omp/spine-config.js', import.meta.url), loader);
  const { loadOmpSpineConfigToml: loadInstalledConfig } = await import(pathToFileURL(loader).href);
  assert.throws(() => loadInstalledConfig(), (error) => error.code === 'ENOENT' && error.path === join(root, 'spine.toml'));
});
