// SPDX-License-Identifier: GPL-3.0-only
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../", import.meta.url));
const binary = process.platform === "win32" ? "mc-wss-bridge.exe" : "mc-wss-bridge";

function hostTriple() {
  try {
    return /^host: (.+)$/m
      .exec(
        execFileSync("rustc", ["-vV"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }),
      )?.[1]
      .trim();
  } catch {
    return undefined;
  }
}

export function bridgeBinary() {
  if (process.env.MC_BRIDGE_BIN) return process.env.MC_BRIDGE_BIN;
  const root = path.join(repo, "bridge/target");
  const profiles = ["debug", "release"];
  const triple = hostTriple();
  const candidates = profiles.map((profile) => path.join(root, profile, binary));
  if (triple)
    for (const profile of profiles) candidates.unshift(path.join(root, triple, profile, binary));
  const found = candidates.find((candidate) => existsSync(candidate));
  assert.ok(
    found,
    `Build the bridge first (bash scripts/test.sh, or the cargo build in docs/development.md), ` +
      `or point MC_BRIDGE_BIN at it. Tried ${candidates.join(", ")}`,
  );
  return found;
}

const VARIABLES = ["MC_BRIDGE_URL", "MC_BRIDGE_PORT", "MC_BRIDGE_TOKEN"];

function environment(token, extra) {
  const env = { ...process.env };
  for (const name of VARIABLES) delete env[name];
  Object.assign(env, extra);
  if (token === undefined) delete env.MC_BRIDGE_TOKEN;
  else env.MC_BRIDGE_TOKEN = token;
  return env;
}

/** Starts the bridge and resolves once it reports its listening port. */
export async function spawnBridge({ url, port = "0", token, env = {}, cwd } = {}) {
  const child = spawn(bridgeBinary(), url === undefined ? [] : [url, port], {
    cwd,
    env: environment(token, env),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  const exited = once(child, "exit");
  const lines = createInterface({ input: child.stdout });
  const [line] = await Promise.race([
    once(lines, "line"),
    exited.then(([code]) => {
      throw new Error(`mc-wss-bridge stopped before listening (exit ${code}): ${stderr}`);
    }),
  ]);
  const address = /^Listening on 127\.0\.0\.1:(\d+)$/.exec(line);
  assert.ok(address, `unexpected first line: ${line}\n${stderr}`);
  return {
    port: Number(address[1]),
    child,
    stderr: () => stderr,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill();
      await exited;
    },
  };
}

/** Runs the bridge to completion, for the paths that exit instead of listening. */
export async function runBridge(args = [], { token, env = {}, cwd } = {}) {
  const child = spawn(bridgeBinary(), args, {
    cwd,
    env: environment(token, env),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data) => {
    stdout += data;
  });
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  const [code] = await once(child, "exit");
  return { code, stdout, stderr };
}
