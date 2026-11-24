// SPDX-License-Identifier: GPL-3.0-only
import assert from "node:assert/strict";
import { on, once } from "node:events";
import http from "node:http";
import net from "node:net";
import test from "node:test";
import { WebSocketServer } from "ws";
import { waitFor } from "./client.mjs";
import { runBridge, spawnBridge } from "./bridge.mjs";

const token = "bridge-test-token";

async function startBridge(t, url) {
  const bridge = await spawnBridge({ url, token });
  t.after(() => bridge.stop());
  return bridge;
}

function remoteServer(t) {
  const remote = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  t.after(() => {
    for (const ws of remote.clients) ws.terminate();
    return new Promise((resolve) => remote.close(resolve));
  });
  return remote;
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
    const remote = remoteServer(t);
    await once(remote, "listening");
    const bridge = await startBridge(t, `ws://localhost:${remote.address().port}/minecraft`);
    const connections = on(remote, "connection");
    t.after(() => connections.return());

    async function connect() {
      const tcp = net.connect(bridge.port, "127.0.0.1");
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
  const bridge = await startBridge(t, `ws://127.0.0.1:${remote.address().port}/minecraft`);
  const tcp = net.connect(bridge.port, "127.0.0.1");
  t.after(() => tcp.destroy());
  await once(tcp, "close");
  assert.deepEqual(requests, ["/minecraft"]);
});

test(
  "a wss: endpoint starts a TLS ClientHello instead of panicking",
  { timeout: 10_000 },
  async (t) => {
    // A plain TCP stub stands in for the real server. TCP may fragment the
    // ClientHello, so wait for the two bytes the assertions read.
    let hello = Buffer.alloc(0);
    const stub = net.createServer((socket) => {
      socket.on("error", () => {});
      socket.on("data", (chunk) => {
        hello = Buffer.concat([hello, chunk]);
        if (hello.length >= 6) socket.destroy();
      });
    });
    t.after(() => new Promise((resolve) => stub.close(resolve)));
    await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
    const bridge = await startBridge(t, `wss://127.0.0.1:${stub.address().port}/minecraft`);

    const tcp = net.connect(bridge.port, "127.0.0.1");
    t.after(() => tcp.destroy());
    await waitFor(() => hello.length >= 6, "a TLS ClientHello", 5000);
    assert.equal(hello[0], 0x16, "the first record must be a TLS handshake");
    assert.equal(hello[5], 0x01, "the handshake must open with a ClientHello");

    await waitFor(() => bridge.stderr().length > 0, "the TLS failure", 5000);
    assert.ok(!bridge.stderr().includes("panicked"), "wss: must not panic the bridge");
    assert.match(bridge.stderr(), /tls/);
  },
);

test(
  "the executable binds loopback and SIGTERM closes the listener and live sessions",
  { timeout: 10_000 },
  async (t) => {
    const remote = remoteServer(t);
    await once(remote, "listening");
    const bridge = await startBridge(t, `ws://127.0.0.1:${remote.address().port}/minecraft`);
    const tcp = net.connect(bridge.port, "127.0.0.1");
    t.after(() => tcp.destroy());
    const tcpClosed = once(tcp, "close");
    const [ws] = await once(remote, "connection");
    const wsClosed = once(ws, "close");
    const exited = once(bridge.child, "exit");
    bridge.child.kill();
    await Promise.all([tcpClosed, wsClosed]);
    assert.deepEqual(await exited, [0, null]);
    const refused = net.connect(bridge.port, "127.0.0.1");
    await once(refused, "error");
  },
);

test(
  "reports its version and refuses a token on the command line",
  { timeout: 10_000 },
  async () => {
    const version = await runBridge(["--version"]);
    assert.equal(version.code, 0);
    assert.match(version.stdout, /^mc-wss-bridge \d+\.\d+\.\d+\n$/);
    const help = await runBridge(["--help"]);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /Usage: mc-wss-bridge \[URL\] \[PORT\]/);
    assert.match(help.stdout, /MC_BRIDGE_URL/);
    assert.match(help.stdout, /port 25565/);
    const tokenFlag = await runBridge(["--token", "secret"]);
    assert.equal(tokenFlag.code, 2);
    assert.match(tokenFlag.stderr, /unexpected argument '--token'/);
  },
);

test("refuses a port outside the range or written with a sign", { timeout: 10_000 }, async () => {
  for (const port of ["65536", "+123", "25_565", ""]) {
    const run = await runBridge(["ws://127.0.0.1:1/minecraft", port], { token });
    assert.equal(run.code, 2, `${port || "an empty port"} should be refused`);
    assert.match(run.stderr, /not a port number/);
  }
});

test("refuses a busy port instead of quietly moving", { timeout: 10_000 }, async (t) => {
  const holder = net.createServer();
  t.after(() => new Promise((resolve) => holder.close(resolve)));
  await new Promise((resolve) => holder.listen(0, "127.0.0.1", resolve));
  const busy = holder.address().port;
  const run = await runBridge(["ws://127.0.0.1:1/minecraft", String(busy)], { token });
  assert.equal(run.code, 1);
  assert.match(run.stderr, new RegExp(`127\\.0\\.0\\.1:${busy}`));
});

test(
  "a rejected token ends the session and keeps the listener up",
  { timeout: 10_000 },
  async (t) => {
    const remote = http.createServer((_request, response) => {
      response.writeHead(401);
      response.end();
    });
    t.after(() => new Promise((resolve) => remote.close(resolve)));
    remote.listen(0, "127.0.0.1");
    await once(remote, "listening");
    const bridge = await startBridge(t, `ws://127.0.0.1:${remote.address().port}/minecraft`);
    for (let attempt = 0; attempt < 2; attempt++) {
      const tcp = net.connect(bridge.port, "127.0.0.1");
      t.after(() => tcp.destroy());
      await once(tcp, "close");
    }
    await waitFor(() => /rejected the token/.test(bridge.stderr()), "the auth error", 2000);
    assert.ok(!bridge.stderr().includes(token), "the token must never reach a log line");
  },
);

test(
  "relays a server ping as a pong without disturbing the data path",
  { timeout: 10_000 },
  async (t) => {
    const remote = remoteServer(t);
    await once(remote, "listening");
    const bridge = await startBridge(t, `ws://127.0.0.1:${remote.address().port}/minecraft`);
    const tcp = net.connect(bridge.port, "127.0.0.1");
    t.after(() => tcp.destroy());
    const [ws] = await once(remote, "connection");

    const pong = once(ws, "pong");
    const started = Date.now();
    ws.ping(Buffer.from("keepalive"));
    const [echo] = await pong;
    assert.equal(echo.toString(), "keepalive");
    assert.ok(Date.now() - started < 2000, "the pong took longer than a healthy round trip");
    assert.equal(bridge.child.exitCode, null);

    const delivered = once(tcp, "data");
    const acked = once(ws, "message");
    ws.send(Buffer.from("after-ping"));
    assert.deepEqual(Buffer.from((await delivered)[0]), Buffer.from("after-ping"));
    const [ack, binary] = await acked;
    assert.equal(binary, false);
    assert.equal(ack.toString(), "10");

    const uploaded = once(ws, "message");
    tcp.write("hello");
    const [frame, frameIsBinary] = await uploaded;
    assert.equal(frameIsBinary, true);
    assert.deepEqual(Buffer.from(frame), Buffer.from("hello"));
  },
);

test("answers a server close with 1000 and closes Minecraft", { timeout: 10_000 }, async (t) => {
  const remote = remoteServer(t);
  await once(remote, "listening");
  const bridge = await startBridge(t, `ws://127.0.0.1:${remote.address().port}/minecraft`);
  const tcp = net.connect(bridge.port, "127.0.0.1");
  t.after(() => tcp.destroy());
  const chunks = [];
  tcp.on("data", (chunk) => chunks.push(chunk));
  const [ws] = await once(remote, "connection");
  const tcpClosed = once(tcp, "close");
  const wsClosed = once(ws, "close");
  ws.close(1000);
  assert.deepEqual(await wsClosed, [1000, Buffer.alloc(0)]);
  await tcpClosed;
  assert.deepEqual(chunks, []);
});

test(
  "reports a failed server close without echoing terminal control codes",
  { timeout: 10_000 },
  async (t) => {
    const remote = remoteServer(t);
    await once(remote, "listening");
    const bridge = await startBridge(t, `ws://127.0.0.1:${remote.address().port}/minecraft`);
    const tcp = net.connect(bridge.port, "127.0.0.1");
    t.after(() => tcp.destroy());
    const [ws] = await once(remote, "connection");
    const tcpClosed = once(tcp, "close");
    ws.close(1011, "\u001b[2Jambiguous");
    await tcpClosed;
    await waitFor(
      () => /the server closed the tunnel \(1011:/.test(bridge.stderr()),
      "the close error",
      2000,
    );
    assert.ok(
      !bridge.stderr().includes("\u001b"),
      "a server reason must not reach the terminal raw",
    );
  },
);

test("refuses URLs a URL parser would quietly rewrite", { timeout: 10_000 }, async () => {
  for (const url of [
    "wss:///minecraft",
    "wss://@127.0.0.1:1/minecraft",
    "wss://user:secret@example.com/minecraft",
    "ws://minecraft.example.com/minecraft",
    "wss:minecraft",
  ]) {
    const run = await runBridge([url], { token });
    assert.equal(run.code, 2, `${url} should be refused`);
    assert.match(run.stderr, /^error: /);
    assert.ok(!run.stderr.includes(token), `${url} must not log the token`);
  }
});

test("text and empty frames from the server end the session", { timeout: 10_000 }, async (t) => {
  const remote = remoteServer(t);
  await once(remote, "listening");
  const bridge = await startBridge(t, `ws://127.0.0.1:${remote.address().port}/minecraft`);
  const connections = on(remote, "connection");
  t.after(() => connections.return());

  async function connect() {
    const tcp = net.connect(bridge.port, "127.0.0.1");
    t.after(() => tcp.destroy());
    const chunks = [];
    tcp.on("data", (chunk) => chunks.push(chunk));
    const {
      value: [ws],
    } = await connections.next();
    return { tcp, ws, chunks };
  }

  const acked = await connect();
  acked.ws.send("17");
  await once(acked.tcp, "close");
  assert.deepEqual(acked.chunks, []);

  const empty = await connect();
  empty.ws.send(Buffer.alloc(0));
  await once(empty.tcp, "close");
  assert.deepEqual(empty.chunks, []);
});
