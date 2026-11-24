# Development

Follow the [README setup instructions](../README.md#run-locally) to install the pinned
Rust toolchain, provision the patched Pumpkin checkout and install worker-build.
The initial Pumpkin compilation takes several minutes. Later builds use Cargo's
cache. worker-build owns the common codegen and link settings; `build.rs` adds
the application's own and the JS library (`src/workerd.js`), tracking changes to
it. `.cargo/config.toml` repeats the codegen cfgs so `cargo check` sees them.
The build runs `worker-build --emscripten --release`. Miniflare serves the
resulting JS and Wasm directly.

```sh
pnpm run build          # Compile the production Worker
pnpm test               # Full Miniflare integration suite
pnpm run test:scheduler # Native scheduler, chunk-queue and shutdown regressions
pnpm run test:memory    # Two-player memory probe on a fresh, fixed-seed world
pnpm run test:experience # Configuration and movement/traffic probe
```

Tests fail if their loopback ports (25565 and 8787 by default) are occupied; set
`TEST_TCP_PORT` and `TEST_HTTP_PORT` to use others. They start and
stop only their own Miniflare instances. Their databases and logs live in
`.data/probes/`; playable worlds are separate under `.data/workers/server/`.

`pnpm test` runs protocol, tunnel, and bridge tests. It then runs the same
Java protocol integration suite over local TCP and over WebSocket through the
bridge. Both runs must print `PUMPKIN-DO-SQLITE-RESTART-OK`. The suite checks
server-list pings without starting Pumpkin, two-player gameplay, a shared block
edit, reconnect, and restoration from SQLite after restart.

The memory probe waits for both clients to receive their configured view, observes 30 seconds
of stationary play, then stops the server. Each run creates a fresh isolated world
with a fixed seed; use the same seed when comparing builds. See
[configuration](configuration.md) for the exploration probe:

```sh
pnpm run test:memory --seed 1789200079352125165
```

The probe writes `memory.json` under `.data/probes/`, recording the seed, Wasm and
host-glue hashes, observed capacity, and sampled allocator usage. Sampling ends
before the stop and can miss short-lived allocations. These numbers exclude
JavaScript memory; use an inspector snapshot to check the combined footprint.

The test harness sets `WORLD_SEED` to known terrain with a stable spawn block.
The optional Worker variable also makes new playable worlds reproducible; existing
worlds keep the seed in their saved metadata. Without it, new worlds use a random
seed as before.

## The player bridge

`bridge/` is the native program a player runs instead of connecting to the Worker
directly. It opens a loopback TCP port, tunnels each connection over WebSocket with
the bearer token, and writes nothing to disk. It is its own Cargo workspace, so
build it from `bridge/` inside `nix develop`.

```sh
cd bridge
cargo build --locked   # target/<host>/debug/mc-wss-bridge
cargo test --locked    # URL, token and port parsing
cargo clippy --all-targets
cargo fmt --check
```

The bridge takes the URL and port from the `URL` and `PORT` arguments first, then
from `MC_BRIDGE_URL` and `MC_BRIDGE_PORT`, then from `.env` in the working
directory. The token comes from `MC_BRIDGE_TOKEN` or `.env`, or from a prompt. A
value that is still missing is asked for on a terminal, where Enter keeps the URL
and port the prompt shows. The process environment is never written. The token has
no argument, because arguments are visible in the process list. Without a terminal
the bridge names each missing value and exits 2, so a script must supply every
value up front.

An optional `.env` in the working directory (`bridge/` from a checkout) can hold
these values. Keep it private; it is separate from the Worker's `.dev.vars`.

```sh
MC_BRIDGE_URL=wss://minecraft.yadokani389.net/minecraft
MC_BRIDGE_PORT=25565
MC_BRIDGE_TOKEN=replace-with-the-bridge-token
```

Omit a line to be prompted for that value. Leaving the token out keeps it off
disk, so you paste it at the prompt.

`pnpm run test:bridge` builds the binary and runs the black-box suites in
`tests/wss-bridge.test.mjs` and `tests/bridge-config.test.mjs` against it. `pnpm
test` builds the same binary, runs those suites, and then drives the Java protocol
integration suite through the bridge over WebSocket. Both scripts export the binary
path as `MC_BRIDGE_BIN`.

The `Bridge build` workflow in
[`bridge-build.yml`](../.github/workflows/bridge-build.yml) runs only on
`workflow_dispatch`. It installs the channel pinned in `rust-toolchain.toml`
rather than a floating stable, then builds Windows x64 with a static CRT, Linux
x64 on musl, and macOS on Apple silicon. Each platform uploads an archive holding
the executable as `mc-wss-bridge` (`mc-wss-bridge.exe` on Windows), `LICENSE`, and
`THIRD-PARTY-NOTICES.txt`. Nothing creates a release, so the operator downloads
the artifacts and passes the archives to players by hand. The notices are
distribution text, not anything the executable reads. To regenerate them, install
the generator with
`cargo install cargo-about --locked --version =0.9.0 --features cli`, then run
`cargo fetch --locked` and
`cargo about generate --offline --locked --fail -o THIRD-PARTY-NOTICES.txt third-party.hbs`
inside `bridge/`. The generator reads the release targets from
`bridge/about.toml`.

Node runs the development tools. The game server runs in Workers. Use `nix develop`
for Node 24, pnpm, Rust, and the native build tools.
The Nix shell selects Emscripten for C and C++ code targeting WebAssembly.
It also enables host C optimization for crates that compile with glibc fortify.
The Miniflare runner and the `cf --prebuilt` packaging step share
`worker.config.json`. Restart `pnpm run dev` to rebuild after source changes.

Read [dependency pins](dependencies.md) before changing a checkout. Every change
to a patched dependency must be reflected in `patches/`. The embedded build uses
the root Cargo.lock. Native Pumpkin tests use the dependency's own workspace.
