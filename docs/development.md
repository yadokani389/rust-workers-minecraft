# Development

Follow the [README setup instructions](../README.md#try-it) to install the pinned
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
pnpm run test:memory -- --seed 1789200079352125165
```

The probe writes `memory.json` under `.data/probes/`, recording the seed, Wasm and
host-glue hashes, observed capacity, and sampled allocator usage. Sampling ends
before the stop and can miss short-lived allocations. These numbers exclude
JavaScript memory; use an inspector snapshot to check the combined footprint.

The test harness sets `WORLD_SEED` to known terrain with a stable spawn block.
The optional Worker variable also makes new playable worlds reproducible; existing
worlds keep the seed in their saved metadata. Without it, new worlds use a random
seed as before.

Node runs the local bridge and development tools. The game server runs in
Workers. Use `nix develop` for Node 24, pnpm, Rust, and the native build tools.
The Nix shell selects Emscripten for C and C++ code targeting WebAssembly.
It also enables host C optimization for crates that compile with glibc fortify.
The Miniflare runner and the `cf --prebuilt` packaging step share
`worker.config.json`. Restart `pnpm run dev` to rebuild after source changes.

Read [dependency pins](dependencies.md) before changing a checkout. Every change
to a patched dependency must be reflected in `patches/`. The embedded build uses
the root Cargo.lock. Native Pumpkin tests use the dependency's own workspace.
