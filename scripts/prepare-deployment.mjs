import { lstatSync, statSync } from 'node:fs';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  BUILD_OUTPUT_ROOT,
  cleanBuildOutputDir,
  getWorkerBundleDir,
  writeRootConfig,
  writeWorkerConfig,
} from '@cloudflare/build-output-utils';

const root = dirname(import.meta.dirname);
const config = JSON.parse(await readFile(join(root, 'worker.config.json'), 'utf8'));
if (!config || typeof config !== 'object' || Array.isArray(config)) {
  throw new Error('worker.config.json must contain a JSON object.');
}
const manifest = {
  type: 'partial',
  mainModule: 'index.js',
  modules: { 'index_bg.wasm': { type: 'wasm' } },
};
const modules = [manifest.mainModule, ...Object.keys(manifest.modules)];
const source = join(root, 'build');
for (const name of modules) {
  const artifact = statSync(join(source, name), { throwIfNoEntry: false });
  if (!artifact?.isFile()) throw new Error(`Missing build/${name}. Run pnpm run build first.`);
}

const output = join(root, BUILD_OUTPUT_ROOT);
for (const directory of [dirname(output), output]) {
  const entry = lstatSync(directory, { throwIfNoEntry: false });
  if (entry && !entry.isDirectory()) throw new Error(`Expected a directory at ${directory}`);
}
await cleanBuildOutputDir(root);
const bundle = getWorkerBundleDir(root);
await mkdir(bundle, { recursive: true });
for (const name of modules) await copyFile(join(source, name), join(bundle, name));
const env = { ...config.env, REQUIRE_STATUS_TOKEN: { type: 'text', value: 'true' } };
await writeWorkerConfig({ root, config: { ...config, env }, manifest });
await writeRootConfig({ root, buildContext: { isPreview: false } });
