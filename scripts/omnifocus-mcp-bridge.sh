#!/usr/bin/env sh
set -eu

ROOT_DIR="${OMNIFOCUS_MCP_BRIDGE_ROOT:-}"
if [ -z "$ROOT_DIR" ]; then
  ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
fi

cd "$ROOT_DIR"
exec node "$ROOT_DIR/dist/tailscale-start.js" "$@"
