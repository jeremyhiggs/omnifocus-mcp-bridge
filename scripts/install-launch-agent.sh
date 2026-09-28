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
SOURCE_ROOT="$ROOT_DIR"
TEMPLATE="$ROOT_DIR/launchd/$LABEL.plist.template"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SERVICE_DIR="$HOME/Library/Application Support/omnifocus-mcp-bridge"
RELEASES_DIR="$SERVICE_DIR/releases"
LOG_DIR="$HOME/Library/Logs/omnifocus-mcp-bridge"
STDOUT_LOG="$LOG_DIR/out.log"
STDERR_LOG="$LOG_DIR/err.log"
GUI_DOMAIN="gui/$(id -u)"
NODE_PATH=""
TAILSCALE_PATH=""
SOURCE_LAUNCHER_PATH="$ROOT_DIR/scripts/omnifocus-mcp-bridge.sh"
LAUNCHER_PATH=""
SERVICE_PATH=""
NEW_RELEASE=""
OLD_ROOT=""

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

RELEASE_VERSION="$(node -e '
const pkg = require(process.argv[1]);
const version = `${pkg.version}+${pkg.buildId}`;
if (!/^[A-Za-z0-9.+_-]+$/.test(version) || !/^[0-9a-f]{12}$/.test(pkg.buildId)) process.exit(1);
process.stdout.write(version);
' "$SOURCE_ROOT/package.json")"
mkdir -p "$RELEASES_DIR"
chmod 700 "$RELEASES_DIR"
LOCK_DIR="$SERVICE_DIR/.install.lock"
if ! mkdir "$LOCK_DIR"; then
  echo "Another install is running, or $LOCK_DIR is stale." >&2
  exit 1
fi
cleanup() {
  if [ -n "$NEW_RELEASE" ]; then rm -rf "$NEW_RELEASE"; fi
  rmdir "$LOCK_DIR"
}
trap cleanup EXIT

ROOT_DIR="$(mktemp -d "$RELEASES_DIR/$RELEASE_VERSION.XXXXXX")"
NEW_RELEASE="$ROOT_DIR"
cp -R "$SOURCE_ROOT/." "$ROOT_DIR/"

if [ -f "$PLIST" ]; then
  OLD_ROOT="$(plutil -extract EnvironmentVariables.OMNIFOCUS_MCP_BRIDGE_ROOT raw "$PLIST" 2>/dev/null || true)"
fi
if [ ! -e "$ROOT_DIR/.env" ] && [ ! -L "$ROOT_DIR/.env" ] && [ -n "$OLD_ROOT" ]; then
  if [ -e "$OLD_ROOT/.env" ] || [ -L "$OLD_ROOT/.env" ]; then
    if [ ! -f "$OLD_ROOT/.env" ] || [ -L "$OLD_ROOT/.env" ]; then
      echo "Previous release .env must be a regular file." >&2
      exit 1
    fi
    cp "$OLD_ROOT/.env" "$ROOT_DIR/.env"
  fi
fi
if [ -e "$ROOT_DIR/.env" ] || [ -L "$ROOT_DIR/.env" ]; then
  if [ ! -f "$ROOT_DIR/.env" ] || [ -L "$ROOT_DIR/.env" ]; then
    echo "Release .env must be a regular file." >&2
    exit 1
  fi
  chmod 600 "$ROOT_DIR/.env"
fi

TEMPLATE="$ROOT_DIR/launchd/$LABEL.plist.template"
SOURCE_LAUNCHER_PATH="$ROOT_DIR/scripts/omnifocus-mcp-bridge.sh"
# Validate the exact copied release and its .env before changing launchd.
(cd "$ROOT_DIR" && node dist/generate-token.js --check)
render_template > "$ROOT_DIR/launch-agent.plist"
plutil -lint "$ROOT_DIR/launch-agent.plist" >/dev/null

mkdir -p "$HOME/Library/LaunchAgents" "$SERVICE_DIR" "$LOG_DIR"
cp "$SOURCE_LAUNCHER_PATH" "$LAUNCHER_PATH"
chmod 755 "$LAUNCHER_PATH"
cp "$ROOT_DIR/launch-agent.plist" "$PLIST"
NEW_RELEASE=""

launchctl bootout "$GUI_DOMAIN/$LABEL" >/dev/null 2>&1 || true
wait_for_service_removal
bootstrap_launch_agent
launchctl enable "$GUI_DOMAIN/$LABEL"
launchctl kickstart -k "$GUI_DOMAIN/$LABEL"
attempts=0
until launchctl print "$GUI_DOMAIN/$LABEL" | grep -q 'state = running'; do
  attempts=$((attempts + 1))
  if [ "$attempts" -ge 10 ]; then
    echo "Timed out waiting for $LABEL to run; previous releases were kept." >&2
    exit 1
  fi
  sleep 1
done

for old_release in "$RELEASES_DIR"/*; do
  if [ "$old_release" != "$ROOT_DIR" ] && [ -d "$old_release" ] \
    && [ ! -L "$old_release" ] && [ -f "$old_release/package.json" ] \
    && [ -f "$old_release/dist/tailscale-start.js" ]; then
    rm -rf "$old_release"
  fi
done

echo "Installed and started $LABEL"
echo "Release: $ROOT_DIR"
echo "Plist: $PLIST"
echo "Launcher: $LAUNCHER_PATH"
echo "Logs:  $LOG_DIR"
