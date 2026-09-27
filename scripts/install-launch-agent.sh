#!/usr/bin/env sh
set -eu

LABEL="local.omnifocus-mcp-bridge"

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
if [ "$#" -gt 1 ]; then
  echo "Usage: $0 [release-folder]" >&2
  exit 1
fi
if [ ! -f "$ROOT_DIR/upstream/dist/server.js" ]; then
  ROOT_DIR="$ROOT_DIR/release/omnifocus-mcp-bridge"
fi
ROOT_DIR="${1:-$ROOT_DIR}"
if [ ! -f "$ROOT_DIR/upstream/dist/server.js" ] || [ ! -f "$ROOT_DIR/dist/tailscale-start.js" ]; then
  echo "Missing release folder. Run pnpm release first, or pass a release-folder path." >&2
  exit 1
fi
ROOT_DIR="$(CDPATH= cd -- "$ROOT_DIR" && pwd)"
TEMPLATE="$ROOT_DIR/launchd/$LABEL.plist.template"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SERVICE_DIR="$HOME/Library/Application Support/omnifocus-mcp-bridge"
LOG_DIR="$HOME/Library/Logs/omnifocus-mcp-bridge"
STDOUT_LOG="$LOG_DIR/out.log"
STDERR_LOG="$LOG_DIR/err.log"
GUI_DOMAIN="gui/$(id -u)"
NODE_PATH=""
TAILSCALE_PATH=""
SOURCE_LAUNCHER_PATH="$ROOT_DIR/scripts/omnifocus-mcp-bridge.sh"
LAUNCHER_PATH=""
SERVICE_PATH=""

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

render_template() {
  node - "$TEMPLATE" "$LABEL" "$ROOT_DIR" "$SERVICE_DIR" "$LAUNCHER_PATH" \
    "$SERVICE_PATH" "$STDOUT_LOG" "$STDERR_LOG" <<'JS'
const fs = require("node:fs");
const [template, ...values] = process.argv.slice(2);
const keys = ["LABEL", "REPO_ROOT", "WORKING_DIRECTORY", "LAUNCHER", "PATH", "STDOUT_LOG", "STDERR_LOG"];
const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
const replacements = Object.fromEntries(keys.map((key, i) => [
  `__${key}__`, values[i].replace(/[&<>"']/g, char => entities[char])
]));
process.stdout.write(fs.readFileSync(template, "utf8").replace(/__[A-Z_]+__/g, key => replacements[key]));
JS
}

wait_for_service_removal() {
  attempts=0
  while launchctl print "$GUI_DOMAIN/$LABEL" >/dev/null 2>&1; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 10 ]; then
      echo "Timed out waiting for $LABEL to stop." >&2
      return 1
    fi
    sleep 1
  done
}

bootstrap_launch_agent() {
  attempts=0
  while ! launchctl bootstrap "$GUI_DOMAIN" "$PLIST"; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 5 ]; then
      echo "Failed to bootstrap $LABEL after $attempts attempts." >&2
      return 1
    fi
    sleep 1
  done
}

require_command node
require_command tailscale
require_command launchctl
require_command plutil

NODE_PATH="$(command -v node)"
TAILSCALE_PATH="$(command -v tailscale)"
LAUNCHER_PATH="$SERVICE_DIR/omnifocus-mcp-bridge.sh"
SERVICE_PATH="$(dirname "$NODE_PATH"):$(dirname "$TAILSCALE_PATH"):$PATH"

if [ ! -f "$ROOT_DIR/.secrets/omnifocus-mcp-token" ]; then
  echo "Missing release token file. Run: $ROOT_DIR/scripts/generate-token.sh" >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$SERVICE_DIR" "$LOG_DIR"
cp "$SOURCE_LAUNCHER_PATH" "$LAUNCHER_PATH"
chmod 755 "$LAUNCHER_PATH"
render_template > "$PLIST"
plutil -lint "$PLIST" >/dev/null

launchctl bootout "$GUI_DOMAIN/$LABEL" >/dev/null 2>&1 || true
wait_for_service_removal
bootstrap_launch_agent
launchctl enable "$GUI_DOMAIN/$LABEL"
launchctl kickstart -k "$GUI_DOMAIN/$LABEL"

echo "Installed and started $LABEL"
echo "Plist: $PLIST"
echo "Launcher: $LAUNCHER_PATH"
echo "Logs:  $LOG_DIR"
