import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { get } from 'node:http';
import { mkdir, mkdtemp, appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import workerConfig from '../worker.config.json' with { type: 'json' };
import { waitFor } from './client.mjs';
import { PORT, HTTP_PORT } from './protocol.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));

export async function testServer({ seed = '1789195700909824175', vars = {} } = {}) {
  const inspectorPort = process.env.TEST_INSPECTOR_PORT;
  if (inspectorPort !== undefined) {
    assert.ok(/^\d+$/.test(inspectorPort) && Number(inspectorPort) >= 1 && Number(inspectorPort) <= 65535,
      'TEST_INSPECTOR_PORT must be a port between 1 and 65535');
  }
  await mkdir(path.join(repo, '.data/probes'), { recursive: true });
  const probe = await mkdtemp(path.join(repo, '.data/probes/workers.'));
  const persistence = path.join(probe, 'state');
  console.log(`Workers probe state: ${probe}`);
  for (const port of [PORT, HTTP_PORT, ...(inspectorPort ? [Number(inspectorPort)] : [])]) {
    const listener = net.createServer();
    await new Promise((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(port, '127.0.0.1', resolve);
    });
    await new Promise(resolve => listener.close(resolve));
  }

  let phase = 0;
  const token = process.env.TEST_TRANSPORT === 'websocket' ? randomBytes(32).toString('hex') : undefined;
  async function startWorker(overrides = {}) {
    const log = path.join(probe, `${++phase}-minecraft.log`);
    assert.ok(!workerConfig.compatibilityFlags.includes('precise_timers'),
      'Integration tests must exercise the standard Workers clock');
    const child = fork(path.join(repo, 'scripts/local-worker.mjs'), {
      cwd: repo, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, NO_COLOR: '1' }, execArgv: [],
    });
    let exited = false, failure, logWrites = Promise.resolve();
    const exit = new Promise(resolve => {
      child.once('error', error => { failure = error; if (!child.pid) resolve(); });
      child.once('exit', () => { exited = true; resolve(); });
    });
    const streams = [child.stdout, child.stderr];
    const drained = Promise.all(streams.map(stream => new Promise(resolve => stream.once('close', resolve))));
    for (const stream of streams) {
      let tail = '';
      stream.on('data', data => {
        logWrites = logWrites.then(() => appendFile(log, data));
        const output = (tail + data.toString()).replace(/\x1b\[[0-9;]*m/g, '');
        if (/RUST PANIC:|Fatal uncaught|runtime crashed unexpectedly|(?:^|\n)\s*ERROR\b/.test(output)) {
          failure = new Error(`Runtime failure; see ${log}`);
        }
        tail = output.slice(-128);
      });
    }
    child.send({
      httpPort: HTTP_PORT,
      tcpPort: token ? undefined : PORT,
      inspectorPort: inspectorPort ? Number(inspectorPort) : undefined,
      persistence,
      // Fixed terrain gives the integration test an editable spawn block.
      vars: { ...vars, ...overrides, WORLD_NAME: 'integration', WORLD_SEED: seed, ...(token && { MC_BRIDGE_TOKEN: token }) },
    });
    let bridge;
    async function stop() {
      if (bridge?.listening) await once(bridge.close(), 'close');
      child.kill('SIGTERM');
      const force = setTimeout(() => {
        if (!child.pid) return;
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
      }, 3000);
      // After an explicit IPC disconnect, Node may omit ChildProcess 'close'.
      await exit;
      clearTimeout(force);
      await drained;
      await logWrites;
    }
    try {
      await waitFor(async () => {
        if (failure) throw failure;
        if (exited) throw new Error(`Miniflare exited; see ${log}`);
        try { return (await fetch(`http://127.0.0.1:${HTTP_PORT}/health`, { signal: AbortSignal.timeout(2000) })).ok; }
        catch { return false; }
      }, `Miniflare (${log})`);
      if (token) {
        const { createBridgeServer } = await import('../bridge/cli.mjs');
        const url = `ws://127.0.0.1:${HTTP_PORT}/minecraft`;
        const unauthorized = await new Promise((resolve, reject) => {
          const request = get(url.replace('ws:', 'http:'), {
            signal: AbortSignal.timeout(2_000),
            headers: {
              Connection: 'Upgrade', Upgrade: 'websocket',
              'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
            },
          }, response => { response.resume(); resolve(response.statusCode); });
          request.once('error', reject);
          request.once('upgrade', (_response, socket) => { socket.destroy(); resolve(101); });
        });
        assert.equal(unauthorized, 401);
        bridge = createBridgeServer({ url, token });
        await once(bridge.listen(PORT), 'listening');
      }
    } catch (error) { await stop(); throw error; }
    return {
      stop,
      healthy() { if (failure) throw failure; assert.ok(!exited, `Miniflare exited; see ${log}`); },
    };
  }

  async function request(route = '/', options) {
    const response = await fetch(`http://127.0.0.1:${HTTP_PORT}${route}`, { ...options, signal: AbortSignal.timeout(60_000) });
    const text = await response.text();
    assert.ok(response.ok, `HTTP ${response.status}: ${text.slice(0,2000)}`);
    return JSON.parse(text);
  }

  async function checkpoint(worker, { stopped = true, after } = {}) {
    return waitFor(async () => {
      worker.healthy();
      let state;
      try { state = await request('/'); }
      catch (error) {
        // workerd can cancel a concurrent status RPC as the TCP event closes.
        if (error.message.startsWith('HTTP 500: Error: Network connection lost.')) return false;
        throw error;
      }
      if (state.failure) throw new Error(state.failure);
      return (stopped ? state.phase === 'idle' && state.saved_at && state.saved_at !== after : state.phase === 'running' && state.idle_deadline)
        && state.connections === 0 && state;
    }, 'world checkpoint');
  }

  return { startWorker, request, checkpoint, probe, seed };
}
