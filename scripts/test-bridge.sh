#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
require_node
require_packages
MC_BRIDGE_BIN="$(build_bridge)"
export MC_BRIDGE_BIN
cd "$REPO"
exec "$NODE" --test tests/wss-bridge.test.mjs tests/bridge-config.test.mjs
