# omnifocus-mcp-bridge

Authenticated Streamable HTTP bridge for
[`omnifocus-mcp-enhanced`](https://github.com/jqlts1/omnifocus-mcp-enhanced).

Use this when an MCP client needs remote access to OmniFocus on your Mac. The
upstream OmniFocus MCP server is a local stdio process; this repo wraps it in a
small authenticated Streamable HTTP server.

What it does:

- installs the published `omnifocus-mcp-enhanced` package as a pinned dependency
- launches that package locally as a child stdio MCP process
- exposes MCP over HTTP at `/mcp`
- requires Bearer auth on every request
- defaults to read-only tool exposure
- optionally publishes the bridge through Tailscale Serve at `/omnifocus-mcp`

What it does not do:

- it does not import upstream server internals
- it does not require the upstream repo to become a monorepo
- it does not make OmniFocus itself remote; OmniFocus stays on the Mac

## Requirements

- macOS with OmniFocus installed and automation access allowed
- Node.js 22+
- pnpm 11+
- Tailscale, only if using `pnpm start:tailscale`

## Quick Start

```sh
pnpm install
pnpm token:generate
pnpm start
```

Default local endpoint:

```text
http://127.0.0.1:3050/mcp
```

Clients must send:

```text
Authorization: Bearer <contents of .secrets/omnifocus-mcp-token>
```

Smoke test:

```sh
TOKEN="$(cat .secrets/omnifocus-mcp-token)"

curl -i http://127.0.0.1:3050/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

`pnpm token:generate` writes `.secrets/omnifocus-mcp-token` with private
permissions and does not print the token. Rotate it with:

```sh
pnpm token:generate -- --force
```

## Security

- Bearer auth is required on every request.
- The bridge refuses to start without `OMNIFOCUS_MCP_TOKEN`,
  `OMNIFOCUS_MCP_TOKEN_FILE`, or `.secrets/omnifocus-mcp-token`.
- Token files must be regular files and must not be group/world readable.
- The default bind host is `127.0.0.1`.
- Read-only mode is enabled by default. Set `OMNIFOCUS_MCP_READ_ONLY=false` only
  when remote mutation is intended.
- The upstream OmniFocus server stays local to the Mac and is launched over
  stdio; no upstream internals are imported.

## Configuration

`.env` is optional. If present, it is loaded before process environment values,
so shell, launchd, or service-manager env vars override `.env`.

| Variable | Default | Description |
| --- | --- | --- |
| `OMNIFOCUS_MCP_TOKEN_FILE` | `.secrets/omnifocus-mcp-token` when present | Private file containing the bearer token. |
| `OMNIFOCUS_MCP_TOKEN` | none | Direct bearer token override. Avoid inline shell usage because it can leak through history. |
| `OMNIFOCUS_MCP_ENV_FILE` | `.env` when present | Optional dotenv file path. If explicitly set, the file must exist. |
| `OMNIFOCUS_MCP_HOST` | `127.0.0.1` | HTTP bind host. Keep this as `127.0.0.1` for Tailscale Serve mode. |
| `OMNIFOCUS_MCP_PORT` | `3050` | HTTP bind port. |
| `OMNIFOCUS_MCP_READ_ONLY` | `true` | Set to `false` to expose mutating upstream tools. |
| `OMNIFOCUS_MCP_VERBOSE` | `false` | Set to `true` for redacted request logs. |
| `OMNIFOCUS_MCP_UPSTREAM_COMMAND` | Node executable | Optional override for the stdio upstream command. |
| `OMNIFOCUS_MCP_UPSTREAM_ARGS` | resolved dependency bin path | Optional override args. Supports JSON arrays or shell-like quoted strings. |

To expose plain HTTP on a trusted LAN, set `OMNIFOCUS_MCP_HOST=0.0.0.0`. This is
not HTTPS; prefer Tailscale Serve for remote access.

## Tailscale Serve

For tailnet HTTPS:

```sh
pnpm start:tailscale
```

This starts the bridge on `127.0.0.1:${OMNIFOCUS_MCP_PORT:-3050}` and registers a
persistent background Tailscale Serve route. With the default port, the Serve
command is:

```sh
tailscale serve --bg --set-path /omnifocus-mcp http://127.0.0.1:3050/mcp
```

Remote endpoint:

```text
https://<mac-name>.<tailnet>.ts.net/omnifocus-mcp
```

The wrapper accepts an existing `/omnifocus-mcp` route when it already points to
the expected local bridge. It refuses to overwrite a route pointing elsewhere,
leaves unrelated Serve routes alone, and does not run `tailscale serve reset`.
Tailscale Serve mode requires a fixed port; `OMNIFOCUS_MCP_PORT=0` is rejected
because a persistent route must keep the same local target across restarts.

## Run in the Background

Use a macOS LaunchAgent, not a LaunchDaemon, so OmniFocus automation runs in the
logged-in user's GUI session.

```sh
pnpm launchd:install
```

This renders `launchd/local.omnifocus-mcp-bridge.plist.template` to:

```text
~/Library/LaunchAgents/local.omnifocus-mcp-bridge.plist
```

If migrating from a previous installation of this service, uninstall
it from the previous checkout before installing this service. Both use the same
default port, installed launcher, and log directory. Generate a token in this
checkout and update your client's credentials before switching services.

The service runs an installed copy of `scripts/omnifocus-mcp-bridge.sh`, so
macOS Login Items show a named bridge entry instead of `pnpm`. The installed
launcher lives outside `~/Documents` to avoid macOS background-item privacy
restrictions, keeps the bridge alive, and writes logs to:

```text
~/Library/Logs/omnifocus-mcp-bridge/
```

Check status:

```sh
launchctl print "gui/$(id -u)/local.omnifocus-mcp-bridge"
pnpm launchd:logs
```

Uninstall:

```sh
pnpm launchd:uninstall
```

## Upstream Launch

The upstream package is pinned in `package.json`. At runtime, the bridge:

1. resolves `omnifocus-mcp-enhanced/package.json`
2. reads the package `bin` entry
3. starts `node <resolved-bin-path>` as a child stdio MCP process

Override launch only when testing a different stdio server:

```sh
OMNIFOCUS_MCP_UPSTREAM_COMMAND=node \
OMNIFOCUS_MCP_UPSTREAM_ARGS='["/absolute/path/to/custom/server.js"]' \
pnpm start
```

## Read-Only Mode

When `OMNIFOCUS_MCP_READ_ONLY` is unset or true, only these tools are exposed:

- `dump_database`
- `get_task_by_id`
- `read_task_attachment`
- `get_tasks`
- `filter_tasks`
- `get_projects`
- `manage_perspectives` (`list` and `get` only)
- `count_tasks`

In the pinned upstream package, custom-perspective task reads use
`get_tasks` with `source: "custom"`; task IDs are returned in structured output.

Known and unknown mutating tools are blocked in read-only mode.

## Diagnostics

Enable redacted request logs:

```sh
pnpm start:tailscale -- --verbose
```

or:

```sh
OMNIFOCUS_MCP_VERBOSE=true pnpm start:tailscale
```

Verbose logs include method, path, status, duration, remote address,
forwarded-for, user agent, content type, accept header, whether an Authorization
header was present, and whether bearer auth passed. They do not include bearer
tokens or request bodies.

If a client gets `502 Bad Gateway` and no bridge request log appears, the request
did not reach the bridge. Check:

```sh
tailscale serve status --json
lsof -nP -iTCP:3050 -sTCP:LISTEN
```

If the bridge logs `statusCode:401`, the request reached the bridge but the
token was missing or invalid.

## Development

```sh
pnpm install
pnpm run format:check
pnpm run lint
pnpm run typecheck
pnpm test
pnpm run build
```

Tests use a fake stdio MCP child process. They do not launch OmniFocus or call
the real upstream package.

`pnpm start`, `pnpm start:tailscale`, and `pnpm token:generate` run
`pnpm run build` before executing compiled output.
