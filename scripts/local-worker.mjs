import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs, parseEnv } from "node:util";
import { Miniflare } from "miniflare";
import workerConfig from "../worker.config.json" with { type: "json" };

const host = "127.0.0.1";
const root = new URL("../", import.meta.url);
const read = (file, encoding) => readFile(new URL(file, root), encoding);

async function devOptions() {
  const { values } = parseArgs({ options: { var: { type: "string", multiple: true } } });
  const vars = new Map(
    Object.entries(
      parseEnv(
        await read(".dev.vars", "utf8").catch((error) => {
          if (error.code !== "ENOENT") throw error;
          return "";
        }),
      ),
    ),
  );
  for (const binding of values.var ?? []) {
    const separator = binding.indexOf(":");
    const name = binding.slice(0, separator);
    if (separator < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error("Expected --var NAME:VALUE");
    }
    vars.set(name, binding.slice(separator + 1));
  }
  return {
    httpPort: 8787,
    tcpPort: 25565,
    // Keep the v3 resource root and worker name so local SQLite worlds reopen in place.
    persistence: fileURLToPath(new URL(".data/workers/server/v3", root)),
    vars: Object.fromEntries(vars),
  };
}

const options = process.connected ? (await once(process, "message"))[0] : await devOptions();
if (process.connected) process.disconnect();
const { httpPort, tcpPort, inspectorPort, persistence, vars } = options;
const [js, wasm] = await Promise.all([read("build/index.js", "utf8"), read("build/index_bg.wasm")]);
const env = Object.fromEntries(
  Object.entries(vars).map(([key, value]) => [key, { type: "text", value }]),
);
const mf = new Miniflare({
  host,
  port: httpPort,
  inspectorHost: host,
  inspectorPort,
  cf: false,
  resourcePersistencePath: persistence,
  workers: [
    {
      config: {
        ...workerConfig,
        env: { ...workerConfig.env, ...env },
        triggers:
          tcpPort === undefined
            ? []
            : [{ type: "connect", protocol: "tcp", address: host, port: tcpPort }],
        manifest: {
          mainModule: "index.js",
          modules: {
            "index.js": { type: "esm", contents: js },
            "index_bg.wasm": { type: "wasm", contents: wasm },
          },
        },
      },
    },
  ],
});
const stop = () =>
  mf.dispose().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try {
  console.log(`HTTP ${await mf.ready}`);
  if (tcpPort !== undefined) console.log(`Minecraft ${host}:${tcpPort}`);
} catch (error) {
  await stop();
  throw error;
}
