#!/usr/bin/env sh
set -eu

SERVICE="gui/$(id -u)/local.omnifocus-mcp-bridge"
if ! launchctl print "$SERVICE" >/dev/null 2>&1; then
  echo "The LaunchAgent is not loaded. Run pnpm launchd:install first." >&2
  exit 1
fi

mkdir -p "$HOME/Library/Logs/omnifocus-mcp-bridge"
launchctl kickstart -k "$SERVICE"
attempts=0
until launchctl print "$SERVICE" | grep -q 'state = running'; do
  attempts=$((attempts + 1))
  if [ "$attempts" -ge 10 ]; then
    echo "The LaunchAgent did not start. Check pnpm launchd:logs." >&2
    exit 1
  fi
  sleep 1
done

echo "Restarted local.omnifocus-mcp-bridge. Run pnpm bridge:test to check app access."
