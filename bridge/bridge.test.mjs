// SPDX-License-Identifier: GPL-3.0-only
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { on, once } from "node:events";
import http from "node:http";
import net from "node:net";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { createBridgeServer } from "./cli.mjs";

const cliPath = fileURLToPath(new URL("./cli.mjs", import.meta.url));
const token = "bridge-test-token";

async function startBridge(t, url) {
  const cli = spawn(process.execPath, [cliPath, url, "0"], {
    env: { ...process.env, MC_BRIDGE_TOKEN: token },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const stopped = once(cli, "exit");
  t.after(async () => {
    cli.kill();
    await stopped;
  });
  const lines = createInterface({ input: cli.stdout });
  const [line] = await Promise.race([
    once(lines, "line"),
    stopped.then(([code]) => {
      throw new Error(`Bridge stopped before listening (${code})`);
    }),
  ]);
  const address = /^Listening on 127\.0\.0\.1:(\d+)$/.exec(line);
  assert.ok(address, line);
  return Number(address[1]);
}

async function receive(messages, size) {
  const chunks = [];
  for (let total = 0; total < size;) {
    const {
      value: [payload, binary],
    } = await messages.next();
    assert.equal(binary, true);
    assert.ok(payload.length > 0 && payload.length <= 16384);
    chunks.push(payload);
    total += payload.length;
  }
  return Buffer.concat(chunks);
}

function payload(size, seed) {
  return Buffer.from(Array.from({ length: size }, (_, i) => (i + (i >> 8) + seed) & 255));
}

test(
  "CLI tunnels isolated binary streams and acknowledges each stream after TCP writes",
  { timeout: 10_000 },
  async (t) => {
    const remote = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    t.after(() => {
      for (const ws of remote.clients) ws.terminate();
      return new Promise((resolve) => remote.close(resolve));
    });
    await once(remote, "listening");
    const port = await startBridge(t, `ws://localhost:${remote.address().port}/minecraft`);
    const connections = on(remote, "connection");
    t.after(() => connections.return());

    async function connect() {
      const tcp = net.connect(port, "127.0.0.1");
      t.after(() => tcp.destroy());
      const {
        value: [ws, request],
      } = await connections.next();
      assert.equal(request.headers.authorization, `Bearer ${token}`);
      assert.equal(request.url, "/minecraft");
      return { tcp, ws, messages: on(ws, "message") };
    }

    async function exchange({ tcp, ws, messages }, seed) {
      const outbound = payload(384 * 1024 + 3, seed);
      tcp.write(outbound);
      assert.deepEqual(await receive(messages, outbound.length), outbound);

      const received = [];
      tcp.on("data", (chunk) => received.push(chunk));
      const frames = [payload(16384, seed), payload(7, seed + 1), payload(16384, seed + 2)];
      for (const frame of frames) ws.send(frame);
      let written = 0;
      for (const frame of frames) {
        const {
          value: [ack, binary],
        } = await messages.next();
        assert.equal(binary, false);
        assert.equal(ack.toString(), String((written += frame.length)));
      }
      return { received, expected: Buffer.concat(frames) };
    }

    const a = await connect();
    const b = await connect();
    const [fromA, fromB] = await Promise.all([exchange(a, 3), exchange(b, 71)]);

    const aTcpClosed = once(a.tcp, "close");
    const aWsClosed = once(a.ws, "close");
    const last = payload(48 * 1024, 124);
    const aTail = receive(a.messages, last.length);
    a.tcp.end(last);
    assert.deepEqual(await aTail, last);
    assert.deepEqual(await aWsClosed, [1000, Buffer.alloc(0)]);
    await aTcpClosed;
    assert.deepEqual(Buffer.concat(fromA.received), fromA.expected);

    const bTcpClosed = once(b.tcp, "close");
    const bWsClosed = once(b.ws, "close");
    const finalFrame = payload(16384, 827);
    b.ws.send(finalFrame);
    b.ws.close(1000);
    await Promise.all([bTcpClosed, bWsClosed]);
    assert.deepEqual(Buffer.concat(fromB.received), Buffer.concat([fromB.expected, finalFrame]));
    const c = await connect();
    const cTcpClosed = once(c.tcp, "close");
    const cWsClosed = once(c.ws, "close");
    const unexpected = [];
    c.tcp.on("data", (chunk) => unexpected.push(chunk));
    c.ws.send(Buffer.alloc(16385));
    await Promise.all([cTcpClosed, cWsClosed]);
    assert.deepEqual(unexpected, []);
    assert.equal(remote.clients.size, 0);
  },
);

test("CLI closes the TCP stream when the upstream redirects", { timeout: 10_000 }, async (t) => {
  const requests = [];
  const remote = http.createServer((request, response) => {
    requests.push(request.url);
    if (request.url === "/minecraft") response.writeHead(302, { location: "/redirect" });
    else response.writeHead(400);
    response.end();
  });
  t.after(() => new Promise((resolve) => remote.close(resolve)));
  remote.listen(0, "127.0.0.1");
  await once(remote, "listening");
  const port = await startBridge(t, `ws://127.0.0.1:${remote.address().port}/minecraft`);
  const tcp = net.connect(port, "127.0.0.1");
  t.after(() => tcp.destroy());
  await once(tcp, "close");
  assert.deepEqual(requests, ["/minecraft"]);
});

test(
  "server factory binds loopback and closes active TCP and WebSocket connections",
  { timeout: 10_000 },
  async (t) => {
    const remote = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    t.after(() => {
      for (const ws of remote.clients) ws.terminate();
      return new Promise((resolve) => remote.close(resolve));
    });
    await once(remote, "listening");
    const server = createBridgeServer({
      url: `ws://127.0.0.1:${remote.address().port}/minecraft`,
      token,
    });
    t.after(() => {
      if (server.listening) server.close();
    });
    await once(server.listen(0), "listening");
    const { address, port } = server.address();
    assert.equal(address, "127.0.0.1");
    const tcp = net.connect(port, address);
    t.after(() => tcp.destroy());
    const tcpClosed = once(tcp, "close");
    const [ws] = await once(remote, "connection");
    const wsClosed = once(ws, "close");
    await Promise.all([tcpClosed, wsClosed, once(server.close(), "close")]);
    assert.equal(server.address(), null);
  },
);
