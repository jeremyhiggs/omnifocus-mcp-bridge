#!/usr/bin/env sh
set -eu

ROOT_DIR="${OMNIFOCUS_MCP_BRIDGE_ROOT:-}"
if [ -z "$ROOT_DIR" ]; then
  ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
fi

if [ -z "${OMNIFOCUS_MCP_ENV_FILE:-}" ] && [ -f "$ROOT_DIR/.env" ]; then
  export OMNIFOCUS_MCP_ENV_FILE="$ROOT_DIR/.env"
fi

exec node "$ROOT_DIR/dist/tailscale-start.js" "$@"
