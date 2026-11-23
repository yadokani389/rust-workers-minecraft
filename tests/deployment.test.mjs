import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempDisposableSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const repo = dirname(import.meta.dirname);
const config = JSON.parse(readFileSync(join(repo, "worker.config.json"), "utf8"));

test("prepare replaces stale output with only the Worker config and bundle", () => {
  using fixture = mkdtempDisposableSync(join(tmpdir(), "minecraft-deployment-"));
  const { path: root } = fixture;
  const cloudflare = join(root, ".cloudflare");
  const output = join(cloudflare, "output");
  const worker = join(output, "v1/workers/default");
  const bundle = join(worker, "bundle");
  for (const directory of ["build", "scripts", ".cloudflare/output/v2"]) {
    mkdirSync(join(root, directory), { recursive: true });
  }
  symlinkSync(join(repo, "node_modules"), join(root, "node_modules"), "junction");
  const script = join(root, "scripts/prepare-deployment.mjs");
  copyFileSync(join(repo, "scripts/prepare-deployment.mjs"), script);
  writeFileSync(join(root, "worker.config.json"), JSON.stringify(config));
  writeFileSync(join(root, "build/index.js"), "export default {};");
  writeFileSync(join(root, "build/extra.js"), "not a Worker module");
  writeFileSync(join(cloudflare, "keep"), "not output");
  const prepare = () => execFileSync(process.execPath, [script], { stdio: "pipe" });
  assert.throws(prepare, { status: 1 });
  assert.deepEqual(readdirSync(output), ["v2"]);

  const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
  writeFileSync(join(root, "build/index_bg.wasm"), wasm);
  writeFileSync(join(root, "worker.config.json"), "null");
  assert.throws(prepare, { status: 1 });
  assert.deepEqual(readdirSync(output), ["v2"]);
  writeFileSync(join(root, "worker.config.json"), JSON.stringify(config));
  prepare();
  writeFileSync(join(bundle, "stale.js"), "old Worker module");
  prepare();
  assert.deepEqual(readdirSync(output), ["v1"]);
  assert.deepEqual(readdirSync(bundle).sort(), ["index.js", "index_bg.wasm"]);
  assert.deepEqual(readFileSync(join(bundle, "index_bg.wasm")), wasm);
  assert.equal(readFileSync(join(bundle, "index.js"), "utf8"), "export default {};");
  assert.equal(readFileSync(join(cloudflare, "keep"), "utf8"), "not output");
  assert.deepEqual(JSON.parse(readFileSync(join(worker, "worker.config.json"), "utf8")), {
    ...config,
    env: { ...config.env, REQUIRE_STATUS_TOKEN: { type: "text", value: "true" } },
    manifest: {
      type: "partial",
      mainModule: "index.js",
      modules: { "index_bg.wasm": { type: "wasm" } },
    },
  });
  assert.deepEqual(JSON.parse(readFileSync(join(output, "v1/config.json"), "utf8")), {
    buildContext: { isPreview: false },
  });
});
