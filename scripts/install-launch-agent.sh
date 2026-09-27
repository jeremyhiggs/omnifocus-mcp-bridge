#!/usr/bin/env sh
set -eu

LABEL="local.omnifocus-mcp-bridge"

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
TEMPLATE="$ROOT_DIR/launchd/$LABEL.plist.template"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SERVICE_DIR="$HOME/Library/Application Support/omnifocus-mcp-bridge"
LOG_DIR="$HOME/Library/Logs/omnifocus-mcp-bridge"
STDOUT_LOG="$LOG_DIR/out.log"
STDERR_LOG="$LOG_DIR/err.log"
GUI_DOMAIN="gui/$(id -u)"
PNPM_PATH=""
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

xml_escape() {
  printf '%s' "$1" \
    | sed \
      -e 's/&/\&amp;/g' \
      -e 's/</\&lt;/g' \
      -e 's/>/\&gt;/g' \
      -e 's/"/\&quot;/g' \
      -e "s/'/\&apos;/g"
}

render_template() {
  sed \
    -e "s#__LABEL__#$(xml_escape "$LABEL")#g" \
    -e "s#__REPO_ROOT__#$(xml_escape "$ROOT_DIR")#g" \
    -e "s#__WORKING_DIRECTORY__#$(xml_escape "$SERVICE_DIR")#g" \
    -e "s#__LAUNCHER__#$(xml_escape "$LAUNCHER_PATH")#g" \
    -e "s#__PATH__#$(xml_escape "$SERVICE_PATH")#g" \
    -e "s#__STDOUT_LOG__#$(xml_escape "$STDOUT_LOG")#g" \
    -e "s#__STDERR_LOG__#$(xml_escape "$STDERR_LOG")#g" \
    "$TEMPLATE"
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

require_command pnpm
require_command node
require_command tailscale
require_command launchctl
require_command plutil

PNPM_PATH="$(command -v pnpm)"
NODE_PATH="$(command -v node)"
TAILSCALE_PATH="$(command -v tailscale)"
LAUNCHER_PATH="$SERVICE_DIR/omnifocus-mcp-bridge.sh"
SERVICE_PATH="$(dirname "$PNPM_PATH"):$(dirname "$NODE_PATH"):$(dirname "$TAILSCALE_PATH"):$PATH"

if [ ! -f "$ROOT_DIR/.secrets/omnifocus-mcp-token" ]; then
  echo "Missing default token file. Run: pnpm token:generate" >&2
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
