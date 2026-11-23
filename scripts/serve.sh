#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
require_node
require_packages
"$NODE" "$REPO/scripts/check-ports.mjs" 25565 8787
bash "$REPO/scripts/build.sh"
exec "$NODE" "$REPO/scripts/local-worker.mjs" "$@"
