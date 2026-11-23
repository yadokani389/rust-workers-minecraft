// SPDX-License-Identifier: GPL-3.0-only
import net from "node:net";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const MAX_CHUNK = 16 * 1024;
const MAX_PENDING = 256n * 1024n;

function parseOptions({ url: address, token }) {
  address = String(address);
  const authority = /^wss?:\/\/([^/?#]+)/i.exec(address)?.[1];
  if (!authority || authority.includes("@") || /[\\#\s\x00-\x1f\x7f]/.test(address)) {
    throw new Error("Expected a WebSocket URL without credentials or a fragment");
  }
  const url = URL.parse(address);
  if (!url) throw new Error("Invalid WebSocket URL");
  if (url.protocol === "ws:") {
    if (url.hostname === "localhost") url.hostname = "127.0.0.1";
    const ipv4Loopback = url.hostname.startsWith("127.") && net.isIP(url.hostname) === 4;
    if (url.hostname !== "[::1]" && !ipv4Loopback) {
      throw new Error("Use wss: except for loopback development");
    }
  }
  if (typeof token !== "string" || !token || /[^!-~]/.test(token)) {
    throw new Error("Set MC_BRIDGE_TOKEN in the environment");
  }
  return { url, token };
}

function bridge(tcp, { url, token }) {
  const ws = new WebSocket(url, {
    headers: { Authorization: `Bearer ${token}` },
    followRedirects: false,
    rejectUnauthorized: true,
    agent: false,
    perMessageDeflate: false,
    maxPayload: MAX_CHUNK,
    handshakeTimeout: 10_000,
    closeTimeout: 5_000,
  });
  let received = 0n;
  let written = 0n;

  function abort() {
    tcp.destroy();
    ws.terminate();
  }

  tcp.setNoDelay(true);
  tcp.setTimeout(60_000, abort);
  tcp.on("error", abort);
  tcp.once("close", () => ws.terminate());
  ws.on("error", abort);
  ws.once("close", (code) => {
    if (code === 1000 || code === 1005) tcp.destroySoon();
    else tcp.destroy();
  });

  tcp.on("drain", () => {
    if (ws.readyState === WebSocket.OPEN) ws.resume();
  });
  ws.on("message", (data, binary) => {
    if (!binary || data.length === 0) return abort();
    const size = BigInt(data.length);
    received += size;
    if (received - written > MAX_PENDING) return abort();
    if (
      !tcp.write(data, (error) => {
        if (error) return abort();
        written += size;
        if (ws.readyState === WebSocket.OPEN)
          ws.send(String(written), (error) => {
            if (error) abort();
          });
      })
    )
      ws.pause();
  });

  ws.once("open", () => {
    async function send() {
      for await (const data of tcp.iterator({ destroyOnReturn: false })) {
        for (let i = 0; i < data.length; i += MAX_CHUNK) {
          if (ws.readyState !== WebSocket.OPEN) return;
          await new Promise((resolve, reject) => {
            ws.send(data.subarray(i, i + MAX_CHUNK), (error) =>
              error ? reject(error) : resolve(),
            );
          });
        }
      }
      ws.close(1000);
    }
    void send().catch(abort);
  });
}

export function createBridgeServer(config) {
  const options = parseOptions(config);
  const sockets = new Set();
  const server = net.createServer({ allowHalfOpen: true }, (tcp) => {
    sockets.add(tcp);
    tcp.once("close", () => sockets.delete(tcp));
    bridge(tcp, options);
  });
  const listen = server.listen.bind(server);
  server.listen = (port = 25565, callback) => {
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid TCP port");
    return listen(port, "127.0.0.1", callback);
  };
  const close = server.close.bind(server);
  server.close = (callback) => {
    close(callback);
    for (const tcp of sockets) tcp.destroy();
    return server;
  };
  return server;
}

async function main() {
  const [url, port = "25565", ...rest] = process.argv.slice(2);
  if (!url || rest.length) throw new Error("Usage: node bridge/cli.mjs URL [port]");
  if (!/^\d+$/.test(port)) throw new Error("Invalid TCP port");
  const server = createBridgeServer({ url, token: process.env.MC_BRIDGE_TOKEN });
  server.listen(Number(port));
  await once(server, "listening");
  console.log(`Listening on 127.0.0.1:${server.address().port}`);

  process.once("SIGINT", () => server.close());
  process.once("SIGTERM", () => server.close());
}

if (import.meta.main ?? process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
