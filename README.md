# Minecraft on Workers

A [Pumpkin](https://github.com/Pumpkin-MC/Pumpkin) Minecraft Java server, compiled
from Rust to WebAssembly and hosted in a Cloudflare Durable Object. A local bridge
connects an unmodified Minecraft Java client to the Worker over WebSocket. Pumpkin
runs the game and stores the world in a mounted SQLite filesystem.

![Minecraft Java 26.2 multiplayer alongside Wrangler running the Pumpkin server](docs/images/minecraft-on-workers.png)

```text
Minecraft → local TCP bridge → WSS → Worker → MinecraftWorld → Pumpkin + SQLite
```

## Try it

From a checkout of this repository, enter the Nix development shell:

```sh
nix develop
bash scripts/setup.sh
pnpm run dev
```

The flake provides Rust, the Emscripten target, Node, and pnpm. Setup fetches
and patches Pumpkin under `.work/` and installs worker-build, which provisions
Emscripten and wasm-bindgen itself. `pnpm run dev` compiles Pumpkin with
`worker-build --emscripten` and starts Miniflare. The first build takes several
minutes; later builds use Cargo's cache.

Connect **Minecraft Java 26.2** to **`localhost:25565`**. Status is available at
**http://localhost:8787/**.

The example uses offline mode with encryption disabled and fast packet compression. Local
listeners bind to loopback. `WORLD_NAME` in [worker.config.json](worker.config.json) selects
the Durable Object; [gameplay settings](docs/configuration.md) such as view
distance and the player limit are Worker variables.

World data lives under `.data/workers/server/`, written through to the Durable
Object's SQLite storage as Pumpkin saves. After the last player leaves, the
server saves and keeps a short reconnect window before stopping; the next
connection starts it on the same world. Server-list pings do not start the
runtime. Wait for status to report `phase: "idle"` before stopping Miniflare so
the final save completes.

## Build and contribute

```sh
pnpm run build        # Compile the Worker without starting Miniflare
pnpm test             # Two-player gameplay, a persistent block edit, and restart
pnpm run test:scheduler
```

The tests use separate data under `.data/probes/`. They verify that two clients
observe the same block edit and that the edit and player position survive restart.

See [development](docs/development.md), [architecture](docs/architecture.md), and
[dependency pins](docs/dependencies.md) for build details and patch maintenance.

## Connect through WebSocket

For local development, set `MC_BRIDGE_TOKEN` to a random value in an untracked
`.dev.vars` file. Start `pnpm run dev`, then run the bridge in another terminal
with the same token exported in its environment:

```sh
pnpm run bridge ws://127.0.0.1:8787/minecraft 25566
```

Connect Minecraft Java 26.2 to `127.0.0.1:25566`. Port `25565` is already in use
by the local raw TCP listener. The bridge defaults to port `25565` when you omit
the port argument. Outside loopback, the bridge requires `wss://`.

The deployment targets `wss://minecraft.yadokani389.net/minecraft`, with no
Spectrum configuration. Deploying attaches only that custom hostname, not the
apex or `www`. The `workers.dev` and preview URLs are disabled.
Store `MC_BRIDGE_TOKEN` as a Worker secret before allowing players to connect.
The deployed HTTP status route (`/`) requires the same token; `/health` does
not query the Durable Object.
The token controls access to the server; it does not authenticate Minecraft
names. Use a trusted group only. Production compatibility of the internal
Workers-to-Durable-Object TCP path and the monthly cost still need verification.
See [memory usage](docs/memory-reduction.md) before increasing player limits.

## Deployment check

`pnpm run deploy:check` builds the Worker and validates the prebuilt output with
`cf` without uploading it. `pnpm run deploy` uploads that output. Authenticate
with Cloudflare first. To set `MC_BRIDGE_TOKEN` on deploy, pass
`--secrets-file` with a private file containing only the intended Worker secret.
Keep that file out of Git.

## Credits and license

Built on [Pumpkin](https://github.com/Pumpkin-MC/Pumpkin),
[workers-rs](https://github.com/cloudflare/workers-rs),
[Tokio](https://github.com/tokio-rs/tokio), [Emscripten](https://emscripten.org/),
[wasm-bindgen](https://github.com/wasm-bindgen/wasm-bindgen), and
[Guy Bedford's Rust/Emscripten work](https://github.com/guybedford).

Licensed under [GPL-3.0-only](LICENSE), consistent with Pumpkin. The
[original MIT notice](LICENSES/rust-workers-minecraft-MIT.txt) is retained for
inherited code. This fork adds WebSocket access, a local bridge, and pnpm/Nix
setup to [the upstream project](https://github.com/danlapid/rust-workers-minecraft)
in November 2026. Dependencies retain their own licenses, including MIT for
[ws](https://github.com/websockets/ws/blob/8.23.0/LICENSE). If you distribute a
compiled Worker, provide its GPL-corresponding source and build scripts.
This project is not affiliated with Mojang or Microsoft.
