// SPDX-License-Identifier: GPL-3.0-only
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Miniflare } from 'miniflare';
import config from '../worker.config.json' with { type: 'json' };

const fixtureToken = 'public-status-test-token';
const modules = {
  'index.js': { type: 'esm', contents: await readFile(new URL('../build/index.js', import.meta.url), 'utf8') },
  'index_bg.wasm': { type: 'wasm', contents: await readFile(new URL('../build/index_bg.wasm', import.meta.url)) },
};

test('public diagnostics require a token and do not start gameplay', async t => {
  const mf = new Miniflare({ workers: [{ config: {
    ...config,
    env: {
      ...config.env,
      REQUIRE_STATUS_TOKEN: { type: 'text', value: 'true' },
      MC_BRIDGE_TOKEN: { type: 'text', value: fixtureToken },
    },
    manifest: { mainModule: 'index.js', modules },
  } }] });
  t.after(() => mf.dispose());
  const url = await mf.ready;
  const request = (route, token) => fetch(new URL(route, url), {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(5000),
  });
  assert.equal((await request('/health')).status, 200);
  assert.equal((await request('/')).status, 401);
  assert.equal((await request('/', 'wrong-token')).status, 401);
  assert.equal((await request('/minecraft')).status, 401);
  const status = await request('/', fixtureToken);
  assert.equal(status.status, 200);
  assert.equal((await status.json()).runtime_starts, 0);
});
