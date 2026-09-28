# OmniFocus MCP bridge

Run OmniFocus MCP tools over authenticated HTTP on your Mac. The bridge starts
the pinned [`omnifocus-mcp-enhanced`](https://github.com/jqlts1/omnifocus-mcp-enhanced)
server locally over stdio and exposes it at `http://127.0.0.1:3050/mcp`.
It requires a bearer token and exposes read-only tools by default. Tailscale
Serve is optional; the LaunchAgent stays local unless you enable it.

## First-time setup

You need macOS with OmniFocus installed and automation access allowed, Node.js
24+, and pnpm 11.28.0 to build. Tailscale is needed only if you enable Serve.
Run these commands from the checkout:

```sh
pnpm install --frozen-lockfile
pnpm token:generate
pnpm release
```

Run `pnpm token:generate` only if this is a new installation. It creates a
token in `${XDG_CONFIG_HOME:-$HOME/.config}/omnifocus-mcp-bridge/token` without
printing it. If that file already exists, keep it so existing clients retain
their credentials. The config directory has mode `0700`; the token file has
mode `0600`.

To make the LaunchAgent available through your tailnet, install and connect
Tailscale, then create or edit
`${XDG_CONFIG_HOME:-$HOME/.config}/omnifocus-mcp-bridge/config.env` **before**
installing the agent:

```dotenv
OMNIFOCUS_MCP_TAILSCALE_SERVE=true
```

Keep `config.env` at mode `0600` and its directory at `0700`. You do not need
`config.env` for a local-only installation. The installer requires the
`tailscale` command only when Serve is enabled.

Install and start the background service:

```sh
pnpm launchd:install
launchctl print "gui/$(id -u)/local.omnifocus-mcp-bridge"
```

The installer copies the standalone release into
`~/Library/Application Support/omnifocus-mcp-bridge/releases/` and starts the
LaunchAgent from that copy. It validates the private configuration before
switching agents and removes older installed releases only after the new agent
is running. The installed service needs Node.js, but neither pnpm nor
`node_modules`.

## Connect a client

For a client on the Mac, use:

```text
http://127.0.0.1:3050/mcp
```

When Serve is enabled, run `tailscale serve status` and use the shown tailnet
hostname with `/omnifocus-mcp`:

```text
https://<mac-name>.<tailnet>.ts.net/omnifocus-mcp
```

Both endpoints require the same header:

```text
Authorization: Bearer <contents of ~/.config/omnifocus-mcp-bridge/token>
```

If you use `XDG_CONFIG_HOME`, read the token from that directory instead. An
unauthenticated request to either endpoint should return HTTP `401`; this is
a quick way to confirm the route reaches the bridge without exposing a token:

```sh
curl -i http://127.0.0.1:3050/mcp
```

The local endpoint works whether Serve is enabled or not. Read-only mode is on
by default. Set `OMNIFOCUS_MCP_READ_ONLY=false` in private `config.env` only
if clients should be able to change OmniFocus data.

## Foreground runs

Stop the LaunchAgent first if it already uses port 3050. Then run one of:

```sh
pnpm start            # local only, regardless of config.env
pnpm start:tailscale  # register Serve, regardless of config.env
```

Both commands build before starting. Serve uses the fixed `/omnifocus-mcp`
path and requires a nonzero local port. It accepts an existing route to this
bridge, refuses to overwrite a different target, and leaves unrelated Serve
routes alone.

Disabling `OMNIFOCUS_MCP_TAILSCALE_SERVE` stops registration on future agent
starts. A background Serve route already registered with `--bg` persists until
you remove it. To remove **only** this path, then check the remaining routes:

```sh
tailscale serve --https=443 --set-path=/omnifocus-mcp off
tailscale serve status
```

Do not use `tailscale serve reset` when other routes are configured. See
[Tailscale's Serve CLI reference](https://tailscale.com/docs/reference/tailscale-cli/serve#disable-tailscale-serve).

## Configuration and security

The user config file is `$XDG_CONFIG_HOME/omnifocus-mcp-bridge/config.env`,
defaulting to `~/.config/omnifocus-mcp-bridge/config.env`. A direct run loads
that file first, then a local `.env`, then process environment values; later
values win. The installed LaunchAgent has no `.env` and reads from its own
working directory, so a checkout `.env` does not affect it. The installer
records `XDG_CONFIG_HOME` in the LaunchAgent for custom config locations.

| Setting | Default | Purpose |
| --- | --- | --- |
| `OMNIFOCUS_MCP_HOST` | `127.0.0.1` | HTTP bind address. Serve requires `127.0.0.1` or `localhost`. |
| `OMNIFOCUS_MCP_PORT` | `3050` | Local HTTP port. Serve requires a fixed, nonzero port. |
| `OMNIFOCUS_MCP_READ_ONLY` | `true` | Set to `false` to expose mutating tools. |
| `OMNIFOCUS_MCP_TAILSCALE_SERVE` | `false` | Register `/omnifocus-mcp` on LaunchAgent startup. |
| `OMNIFOCUS_MCP_VERBOSE` | `false` | Enable redacted request logs. |
| `OMNIFOCUS_MCP_TOKEN_FILE` | User-config `token` file | Override the private bearer-token file. |
| `OMNIFOCUS_MCP_TOKEN` | unset | Direct token override; avoid typing tokens into shell history. |
| `OMNIFOCUS_MCP_ENV_FILE` | local `.env` when present | Select another direct-run dotenv file; an explicit path must exist. |
| `OMNIFOCUS_MCP_UPSTREAM_COMMAND` | Node.js | Override the stdio upstream command for testing. |
| `OMNIFOCUS_MCP_UPSTREAM_ARGS` | Bundled upstream entry point | Override arguments using a JSON array or shell-like quoted string. |

The config directory must be owned by the current user with mode `0700`.
`config.env` and token files must be regular, user-owned files with mode
`0600`; symlinks are rejected. Relative token paths in `config.env` resolve
beside that file, while paths in a local `.env` resolve beside the local file.
The bridge refuses to start without a token. Tailscale access does not replace
bearer authentication.

To create an optional config file with the required permissions:

```sh
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/omnifocus-mcp-bridge"
mkdir -p -m 700 "$CONFIG_DIR"
touch "$CONFIG_DIR/config.env"
chmod 700 "$CONFIG_DIR"
chmod 600 "$CONFIG_DIR/config.env"
```

The upstream server stays local to the Mac. The bridge imports no upstream
internals. Binding plain HTTP to a LAN address is possible with
`OMNIFOCUS_MCP_HOST=0.0.0.0`, but it is not HTTPS; prefer loopback with
Tailscale Serve for remote access.

In read-only mode, the exposed tools are `dump_database`, `get_task_by_id`,
`read_task_attachment`, `get_tasks`, `filter_tasks`, `get_projects`,
`manage_perspectives` (`list` and `get` only), and `count_tasks`. Known and
unknown mutating tools are blocked. Custom-perspective task reads use
`get_tasks` with `source: "custom"`; task IDs are returned in structured
output.

## Releases and updates

`pnpm release` builds `release/omnifocus-mcp-bridge/` and
`release/omnifocus-mcp-bridge.tar.gz`. The archive includes the bundled bridge,
upstream server, launch scripts, and dependency license notices. It excludes
`.env`, token files, `.secrets`, and `node_modules`. A local `.env` placed in
the release folder survives rebuilds for direct runs, but is never copied into
an installed release.

After building a new release, run `pnpm launchd:install` again to update the
background service. Compare these versions to see whether the installed agent
needs updating:

```sh
node release/omnifocus-mcp-bridge/dist/index.js --version
pnpm launchd:logs
```

The version combines `package.json`'s version with a short hash of the
bundled JavaScript. The running version appears in the startup log and MCP
`serverInfo.version`.

An extracted archive can be run directly with Node from its folder:

```sh
./scripts/generate-token.sh # only if no token exists yet
./scripts/run-server.sh
# Or: ./scripts/run-tailscale.sh
```

Install an extracted archive with `./scripts/install-launch-agent.sh`, or
pass its folder to the checkout's installer. On migration, if `config.env`
does not exist, the installer copies a previous release's `.env` (or the
source release's `.env`) into the private user config directory. It rejects
inline tokens and release-local token paths; move those tokens to a separate
private file before installing. Existing `config.env` is left untouched.

The LaunchAgent plist is
`~/Library/LaunchAgents/local.omnifocus-mcp-bridge.plist`. The launcher and
release live outside `~/Documents` to avoid macOS background-item privacy
restrictions. The launcher runs Node directly and does not rebuild or install
dependencies.

## Troubleshooting

Read the agent logs or uninstall it with:

```sh
pnpm launchd:logs
pnpm launchd:uninstall
```

To enable redacted request logs, set `OMNIFOCUS_MCP_VERBOSE=true` in the
private config file and reinstall, or add `--verbose` to a foreground run.
Logs include request metadata and authorization success, but never tokens or
request bodies. A logged `401` means the request reached the bridge without
a valid token. A `502` with no bridge request log suggests the request did not
reach the bridge. Check the Serve route and local listener:

```sh
tailscale serve status --json
lsof -nP -iTCP:3050 -sTCP:LISTEN
```

## Development

```sh
pnpm install --frozen-lockfile
pnpm run format:check
pnpm run lint
pnpm run typecheck
pnpm test
pnpm run build
```

The source checkout resolves the pinned upstream package's `bin` entry and
starts it as a child stdio MCP process. A release starts its bundled
`upstream/dist/server.js` with the same Node executable. To test another
stdio server:

```sh
OMNIFOCUS_MCP_UPSTREAM_COMMAND=node \
OMNIFOCUS_MCP_UPSTREAM_ARGS='["/absolute/path/to/custom/server.js"]' \
pnpm start
```

Tests use a fake stdio MCP process. The release test starts the bundled real
upstream with a mock `osascript` and checks relocation and installation with
a temporary home and mock `launchctl` and Tailscale commands.

To check dependency updates and vulnerabilities:

```sh
pnpm outdated
pnpm audit --audit-level moderate
```

CI runs formatting, lint, typecheck, tests, and release builds on pull
requests. Dependency audits run on pull requests, pushes to `main`, and daily
at 00:00 UTC. Moderate-or-higher findings fail the audit; registry errors
are not ignored. Scheduled workflows start from the default branch.
