// SPDX-License-Identifier: GPL-3.0-only

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { setTimeout as wait } from 'node:timers/promises';
import { after, test } from 'node:test';
import { Miniflare } from 'miniflare';
import WebSocket from 'ws';

const auth = { Authorization: 'Bearer fixture-token' };
const mf = new Miniflare({ workers: [{ config: {
  name: 'tunnel-fixture',
  compatibilityDate: '2026-09-05',
  compatibilityFlags: ['nodejs_compat', 'new_module_registry', 'no_handle_cross_request_promise_resolution'],
  exports: { World: { type: 'durable-object', storage: 'sqlite' } },
  manifest: { mainModule: 'fixture.js', modules: {
    'tunnel.js': { type: 'esm', contents: await readFile(new URL('../src/js/tunnel.js', import.meta.url), 'utf8') },
    'fixture.js': { type: 'esm', contents: `
      import { DurableObject, exports } from 'cloudflare:workers';
      import { handleAsNodeConnection } from 'cloudflare:node';
      import net from 'node:net';
      import { matchesBearer, upgradeMinecraft } from './tunnel.js';

      export class World extends DurableObject {
        listener = net.createServer(socket => socket.pipe(socket));
        ready = new Promise(resolve => this.listener.listen(25565, resolve));
        async connect(socket) {
          await this.ready;
          await handleAsNodeConnection(socket);
        }
      }

      export default { fetch(request) {
        if (!matchesBearer(request.headers.get('authorization') ?? '', 'fixture-token')) {
          return new Response(null, { status: 401 });
        }
        const path = new URL(request.url).pathname;
        return upgradeMinecraft(async ({ readable, writable, relay }) => {
          if (path === '/stalled') return new Promise(() => {});
          const reader = readable.getReader();
          const { value } = await reader.read();
          reader.releaseLock();
          if (path === '/burst') return writable.getWriter().write(new Uint8Array(256 * 1024 + 17));
          return relay(exports.World.getByName('world').connect('world:25565'), value);
        }, 16384, path === '/burst' ? 25_000 : path === '/stalled' ? 5000 : 1000);
      }};
    ` },
  } },
} }] });
after(() => mf.dispose());

async function open(path = '/', headers = auth) {
  const url = new URL(path, await mf.ready);
  url.protocol = 'ws:';
  const ws = new WebSocket(url, { headers });
  await once(ws, 'open');
  return ws;
}

function receive(ws, expected) {
  let received = 0;
  const chunks = [];
  const { promise, resolve, reject } = Promise.withResolvers();
  const read = (bytes, binary) => {
    if (!binary || bytes.length > 16384) {
      reject(new Error('Invalid tunnel frame'));
      return;
    }
    chunks.push(bytes);
    received += bytes.length;
    ws.send(String(received));
    if (received >= expected) {
      ws.off('message', read);
      resolve(Buffer.concat(chunks));
    }
  };
  ws.on('message', read);
  return promise;
}

test('rejects a bad bearer and relays ordered bytes across isolated connections', { timeout: 8000 }, async () => {
  await assert.rejects(open('/', { Authorization: 'Bearer fixture-tokeN' }), /401/);
  const a = await open(), b = await open();
  try {
    const prefix = Buffer.alloc(16384, 42);
    const echoed = receive(a, prefix.length + 3);
    a.send(prefix);
    a.send(Buffer.from('def'));
    assert.deepEqual(await echoed, Buffer.concat([prefix, Buffer.from('def')]));
    const ended = once(a, 'close');
    a.close();
    await ended;
    const other = receive(b, 4);
    b.send(Buffer.from('live'));
    assert.equal((await other).toString(), 'live');
  } finally {
    a.terminate();
    b.terminate();
  }
});

test('bounds the outbound window and waits for acknowledgements before normal close', { timeout: 8000 }, async () => {
  const ws = await open('/burst');
  try {
    const ended = once(ws, 'close');
    let received = 0;
    const window = 256 * 1024;
    const full = Promise.withResolvers();
    ws.on('message', (bytes, binary) => {
      assert.ok(binary && bytes.length <= 16384);
      received += bytes.length;
      if (received >= window) full.resolve();
    });
    ws.send(Buffer.of(1));
    await full.promise;
    await wait(50);
    assert.equal(received, window);
    ws.send(String(received));
    const [last] = await once(ws, 'message');
    assert.equal(last.length, 17);
    assert.equal(ws.readyState, WebSocket.OPEN);
    ws.send(String(received));
    assert.equal((await ended)[0], 1000);
  } finally {
    ws.terminate();
  }
});

test('closes over-limit ingress or invalid acknowledgement rather than losing bytes', { timeout: 8000 }, async () => {
  const examples = [
    [1009, [Buffer.alloc(16385)]],
    [1008, ['1']],
    [1008, Array.from({ length: 17 }, () => Buffer.alloc(16384))],
    [1008, Array.from({ length: 257 }, () => Buffer.of(1))],
  ];
  for (const [code, frames] of examples) {
    const ws = await open('/stalled');
    const ended = once(ws, 'close');
    for (const frame of frames) ws.send(frame);
    assert.equal((await ended)[0], code);
  }
});

test('closes a tunnel that never sends a handshake', { timeout: 4000 }, async () => {
  const ws = await open();
  assert.equal((await once(ws, 'close'))[0], 1008);
});

test('enforces isolate admission and releases a slot on disconnect', { timeout: 8000 }, async () => {
  const held = await Promise.all(Array.from({ length: 32 }, () => open('/stalled')));
  try {
    await assert.rejects(open('/stalled'), /503/);
    const first = held.pop();
    const ended = once(first, 'close');
    first.close();
    await ended;
    held.push(await open('/stalled'));
  } finally {
    await Promise.all(held.map(ws => {
      const ended = once(ws, 'close');
      ws.close();
      return ended;
    }));
  }
});

test('closes when an acknowledgement stalls', { timeout: 20_000 }, async () => {
  const ws = await open('/burst');
  try {
    const ended = once(ws, 'close');
    ws.send(Buffer.of(1));
    const [code, reason] = await ended;
    assert.equal(code, 1008);
    assert.match(reason.toString(), /Acknowledgement timed out/);
  } finally {
    ws.terminate();
  }
});
