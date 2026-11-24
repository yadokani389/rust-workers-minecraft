# Minecraft on Workers

A [Pumpkin](https://github.com/Pumpkin-MC/Pumpkin) Minecraft Java server, compiled
from Rust to WebAssembly and hosted in a Cloudflare Durable Object. A local bridge
connects an unmodified Minecraft Java client to the Worker over WebSocket. Pumpkin
runs the game and stores the world in a mounted SQLite filesystem.

![Minecraft Java 26.2 multiplayer alongside Wrangler running the Pumpkin server](docs/images/minecraft-on-workers.png)

```text
Minecraft → local TCP bridge → WSS → Worker → MinecraftWorld → Pumpkin + SQLite
```

## Play on the public server

Ask the server operator for the bridge token and for the archive of your platform.

| Platform | Start |
| --- | --- |
| Linux x86-64 | `./mc-wss-bridge` |
| Windows x86-64 | `.\mc-wss-bridge.exe` |
| macOS, Apple silicon | `./mc-wss-bridge` |

Extract the archive, then start the executable in a terminal. It asks for each
value it was not given, and Enter keeps the URL and port the prompt shows; paste
the token when it asks. The program needs nothing else installed. The binaries
are unsigned, so macOS Gatekeeper or Windows SmartScreen may ask you to allow
the first run.

On the same PC, connect **Minecraft Java 26.2** to the address the bridge prints,
**`127.0.0.1:25565`** by default.

For build and configuration instructions, see
[the player bridge](docs/development.md#the-player-bridge).

## Run locally

From a checkout, enter the Nix development shell:

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
Object's SQLite storage as Pumpkin saves. When the last player disconnects, the
server saves players, world data, and dirty chunks, then keeps a short reconnect
window. A login during the window cancels the shutdown. When the window ends, it
performs a final save, syncs storage, and reports `phase: "idle"`; the next login
starts it again on the same world. Server-list pings do not start the runtime.
Wait for `phase: "idle"` in status before stopping Miniflare so the final save
completes.

The local Worker reads `MC_BRIDGE_TOKEN` from an untracked `.dev.vars` file.
Start `pnpm run dev`, then run the bridge in another terminal:

```sh
cd bridge
cargo run -- ws://127.0.0.1:8787/minecraft 25566
```

When the bridge asks for the token, paste the same value the Worker reads from
`.dev.vars`. Connect **Minecraft Java 26.2** to `127.0.0.1:25566`. Port `25565`
is already in use by the local raw TCP listener. The bridge requires `wss://`
outside loopback.

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

## Deploy

`pnpm run deploy:check` builds the Worker and validates the prebuilt output with
`cf` without uploading it. `pnpm run deploy` uploads that output. Authenticate
with Cloudflare first. To set `MC_BRIDGE_TOKEN` on deploy, pass
`--secrets-file` with a private file containing only the intended Worker secret.
Keep that file out of Git.

The deployment targets `wss://minecraft.yadokani389.net/minecraft`, with no
Spectrum configuration. Deploying attaches only that custom hostname, not the
apex or `www`. The `workers.dev` and preview URLs are disabled.

Store `MC_BRIDGE_TOKEN` as a Worker secret before allowing players to connect.
The deployed HTTP status route (`/`) requires the same token; `/health` does
not query the Durable Object. The token controls access to the server; it does
not authenticate Minecraft names. Use a trusted group only. The monthly cost of
the deployment has not been measured. See [memory usage](docs/memory-reduction.md)
before increasing player limits.

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
in November 2026.

The bridge in [`bridge/`](bridge/) is a separate program with its own Cargo
workspace and its own [MIT license](bridge/LICENSE), copyright yadokani389. That
grant covers the bridge program and its source alone, so a player can build and
pass on that binary without the GPL. The Worker stays GPL-3.0-only. The crates the
bridge links and the Worker's JavaScript dependencies keep their own licenses,
including MIT for [ws](https://github.com/websockets/ws/blob/8.23.0/LICENSE), and
`bridge/Cargo.lock` pins the crate versions the bridge archives ship notices for.
If you distribute a compiled Worker, provide its GPL-corresponding source and build
scripts. This project is not affiliated with Mojang or Microsoft.
