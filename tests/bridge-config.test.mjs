// SPDX-License-Identifier: GPL-3.0-only
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocketServer } from "ws";
import { waitFor } from "./client.mjs";
import { runBridge, spawnBridge } from "./bridge.mjs";

const token = "dotenv-token";
const unreachable = "ws://127.0.0.1:1/minecraft";

function scratch(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "mc-bridge-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function writeDotenv(directory, entries) {
  const lines = Object.entries(entries).map(([key, value]) => `${key}=${value}\n`);
  writeFileSync(path.join(directory, ".env"), lines.join(""));
  return directory;
}

/** A WebSocket server that records the Authorization header of each connection. */
async function remoteServer(t) {
  const seen = [];
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  server.on("connection", (_socket, request) => seen.push(request.headers.authorization));
  const closed = once(server, "close");
  t.after(() => {
    for (const socket of server.clients) socket.terminate();
    server.close();
    return closed;
  });
  await once(server, "listening");
  return { seen, url: `ws://127.0.0.1:${server.address().port}/minecraft` };
}

function dial(t, bridge) {
  const tcp = net.connect(bridge.port, "127.0.0.1");
  tcp.on("error", () => {});
  t.after(() => tcp.destroy());
}

test(
  "reads the server URL, port and token from .env in the working directory",
  { timeout: 10_000 },
  async (t) => {
    const remote = await remoteServer(t);
    const cwd = writeDotenv(scratch(t), {
      MC_BRIDGE_URL: remote.url,
      MC_BRIDGE_PORT: "0",
      MC_BRIDGE_TOKEN: token,
    });
    const bridge = await spawnBridge({ cwd });
    t.after(() => bridge.stop());
    dial(t, bridge);
    await waitFor(() => remote.seen.length > 0, "the tunnel to reach .env's URL", 5000);
    assert.deepEqual(remote.seen, [`Bearer ${token}`]);
    assert.ok(!bridge.stderr().includes(token), ".env must not be echoed to the terminal");
  },
);

test(
  "the process environment wins over .env for all three values",
  { timeout: 10_000 },
  async (t) => {
    const remote = await remoteServer(t);
    const cwd = writeDotenv(scratch(t), {
      MC_BRIDGE_URL: unreachable,
      MC_BRIDGE_PORT: "2556x",
      MC_BRIDGE_TOKEN: "dotenv-loses",
    });
    const bridge = await spawnBridge({
      cwd,
      token: "environment-wins",
      env: { MC_BRIDGE_URL: remote.url, MC_BRIDGE_PORT: "0" },
    });
    t.after(() => bridge.stop());
    dial(t, bridge);
    await waitFor(() => remote.seen.length > 0, "the tunnel to reach the environment's URL", 5000);
    assert.deepEqual(remote.seen, ["Bearer environment-wins"]);
  },
);

test("the URL argument wins over the environment and .env", { timeout: 10_000 }, async (t) => {
  const silent = await remoteServer(t);
  const loud = await remoteServer(t);
  const cwd = writeDotenv(scratch(t), {
    MC_BRIDGE_URL: silent.url,
    MC_BRIDGE_PORT: "0",
    MC_BRIDGE_TOKEN: "dotenv-loses",
  });
  const bridge = await spawnBridge({
    url: loud.url,
    port: "0",
    token,
    cwd,
    env: { MC_BRIDGE_URL: silent.url },
  });
  t.after(() => bridge.stop());
  dial(t, bridge);
  await waitFor(() => loud.seen.length + silent.seen.length > 0, "the tunnel to be dialled", 5000);
  assert.deepEqual(loud.seen, [`Bearer ${token}`]);
  assert.deepEqual(silent.seen, []);
});

test(".env in a parent directory is not read", { timeout: 10_000 }, async (t) => {
  const parent = writeDotenv(scratch(t), {
    MC_BRIDGE_URL: unreachable,
    MC_BRIDGE_PORT: "0",
    MC_BRIDGE_TOKEN: token,
  });
  const child = path.join(parent, "child");
  mkdirSync(child);
  const run = await runBridge([], { cwd: child });
  assert.equal(run.code, 2);
  assert.match(run.stderr, /MC_BRIDGE_TOKEN/);
});

test(
  "a script without a terminal is told which values to supply",
  { timeout: 10_000 },
  async (t) => {
    const cwd = scratch(t);
    const nothing = await runBridge([], { cwd });
    assert.equal(nothing.code, 2);
    assert.match(nothing.stderr, /no terminal to ask on/);
    for (const name of ["MC_BRIDGE_URL", "MC_BRIDGE_PORT", "MC_BRIDGE_TOKEN"])
      assert.ok(nothing.stderr.includes(name), `${name} must be named`);

    const withoutToken = await runBridge([unreachable, "0"], { cwd });
    assert.equal(withoutToken.code, 2);
    assert.match(withoutToken.stderr, /supply MC_BRIDGE_TOKEN/);
    assert.ok(!withoutToken.stderr.includes("MC_BRIDGE_URL"), "only the gap is named");

    const complete = await spawnBridge({ url: unreachable, port: "0", token, cwd });
    await complete.stop();
  },
);

test("--help and --version work without touching a broken .env", { timeout: 10_000 }, async (t) => {
  const cwd = scratch(t);
  writeFileSync(path.join(cwd, ".env"), "not a pair\n");
  const help = await runBridge(["--help"], { cwd });
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Usage: mc-wss-bridge \[URL\] \[PORT\]/);
  const version = await runBridge(["--version"], { cwd });
  assert.equal(version.code, 0);
  assert.match(version.stdout, /^mc-wss-bridge \d+\.\d+\.\d+\n$/);
});

test(
  "a .env line the parser rejects never reaches the terminal",
  { timeout: 10_000 },
  async (t) => {
    for (const line of ['MC_BRIDGE_TOKEN=leaked-secret "unterminated\n', "leaked-secret\n"]) {
      const cwd = scratch(t);
      writeFileSync(path.join(cwd, ".env"), line);
      const run = await runBridge([], { cwd });
      assert.equal(run.code, 2);
      assert.match(run.stderr, /\.env has a line that is neither a comment nor KEY=VALUE/);
      assert.ok(
        !run.stderr.includes("leaked-secret"),
        "the file's text must stay out of the error",
      );
    }
  },
);

test(
  "an unusable .env value names its key without repeating it",
  { timeout: 10_000 },
  async (t) => {
    const badPort = await runBridge([unreachable], {
      token,
      cwd: writeDotenv(scratch(t), { MC_BRIDGE_PORT: "2556x" }),
    });
    assert.equal(badPort.code, 2);
    assert.match(badPort.stderr, /MC_BRIDGE_PORT in \.env is not usable/);

    const badToken = await runBridge([unreachable, "0"], {
      cwd: writeDotenv(scratch(t), { MC_BRIDGE_TOKEN: '"ünïcode"' }),
    });
    assert.equal(badToken.code, 2);
    assert.match(badToken.stderr, /MC_BRIDGE_TOKEN in \.env is not usable/);
    assert.ok(!badToken.stderr.includes("ünïcode"), "the token must never be repeated");
  },
);
