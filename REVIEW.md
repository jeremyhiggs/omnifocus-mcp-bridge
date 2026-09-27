# Port review

Imported the tracked source files into fresh history.
Updated the LaunchAgent label to `local.omnifocus-mcp-bridge` and its
documentation/tests. Dependencies and runtime behavior otherwise remain as in
the source. The source checkout and installed services were not changed.

## Findings to fix first

- **Environment verbosity is ignored by both entry points.**
  `parseRuntimeArgs([])` returns `verbose: false`; both runners pass that value
  to `loadConfig`, whose nullish fallback then skips `OMNIFOCUS_MCP_VERBOSE`.
  Return `undefined` when no flag is provided, and add a check that exercises
  argument parsing together with environment loading. The existing config test
  checks these inputs separately, so it misses the bug.
- **Request URL parsing can reject outside the HTTP error handler.**
  In `src/server.ts`, `new URL` uses the client-supplied Host header before the
  `try` block. An authenticated request with a malformed host can cause an
  unhandled rejection. Parse against a fixed base inside the handler and return
  400 for malformed request URLs. Add one raw HTTP regression check.
- **Tailscale conflict detection fails open on invalid status output.**
  `parseStatusOutput` returns a string for malformed JSON, which is treated as
  having no routes. The recursive lookup also stops at the first matching path,
  potentially missing a conflicting route on another listener. Reject invalid
  output and inspect every matching handler before registering a route. Add
  malformed-output and multiple-listener checks.

## Ponytail simplifications

1. **One runtime entry point.** `src/index.ts` and `src/tailscale-start.ts`
   duplicate configuration, upstream launch, logging, and shutdown. Keep one
   runner with a `--tailscale` flag; retain the existing package commands as
   aliases. Put startup cleanup in that runner too, so a bind or Serve failure
   closes resources that already started.
2. **JSON-only upstream arguments.** The README already demonstrates JSON.
   Remove `splitShellLike` and its custom quoting rules; validate a JSON array
   of strings. This intentionally drops shell-like argument compatibility, so
   check existing configurations before applying it. The current parser drops
   empty quoted arguments such as `""`.
3. **Direct Tailscale status traversal.** Once the expected status shape is
   validated, iterate `Web` listeners and their `Handlers` instead of recursively
   searching arbitrary objects. Inspect all listeners and keep the refusal to
   overwrite conflicting routes.

Keep bearer authentication, private token-file checks, atomic token rotation,
and the read-only allowlist. These enforce real boundaries and are not useful
targets for deletion.

The installed 2.1.1 dependency does contain the consolidated `get_tasks` tool;
the README's old reference to version 2.2 was misleading and has been corrected.
The integration tests use a fake upstream, so they do not establish real
OmniFocus automation or LaunchAgent behavior.
