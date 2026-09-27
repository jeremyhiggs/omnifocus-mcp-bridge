#!/usr/bin/env sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

pnpm --dir "$ROOT_DIR" run build

export OMNIFOCUS_MCP_BRIDGE_ROOT="$ROOT_DIR"
exec "$ROOT_DIR/scripts/omnifocus-mcp-bridge.sh" "$@"
