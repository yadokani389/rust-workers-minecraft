#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
require_node
require_packages
require_toolchain
"$NODE" "$REPO/scripts/check-ports.mjs" "${TEST_TCP_PORT:-25565}" "${TEST_HTTP_PORT:-8787}"
bash "$REPO/scripts/build.sh"
cd "$REPO"
"$NODE" --test tests/*.test.mjs bridge/*.test.mjs
TEST_TRANSPORT=tcp "$NODE" tests/integration.mjs
TEST_TRANSPORT=websocket exec "$NODE" tests/integration.mjs
