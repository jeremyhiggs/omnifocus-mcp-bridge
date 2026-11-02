#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "./config.js";
import { BRIDGE_VERSION } from "./version.js";

let stage = "load configuration (check the private config and token files)";

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "--help") {
    console.log("Usage: pnpm bridge:test [http://localhost:3050/mcp | https://host/omnifocus-mcp]");
    return;
  }
  stage = "parse endpoint (supply at most one HTTP or HTTPS URL)";
  if (args.length > 1) throw new Error("Too many arguments");
  stage = "load configuration (check the private config and token files)";
  const config = loadConfig();
  const host = config.host === "0.0.0.0" ? "127.0.0.1" : config.host === "::" ? "::1" : config.host;
  const address = host.includes(":") ? `[${host}]` : host;
  stage = "validate endpoint (use loopback HTTP or HTTPS without credentials, query, or fragment)";
  const url = new URL(args[0] ?? `http://${address}:${config.port}/mcp`);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))
  )
    throw new Error("Unsafe endpoint");

  const signal = AbortSignal.timeout(20_000);
  stage = "reach the endpoint without credentials";
  const response = await fetch(url, { signal, redirect: "error" });
  await response.body?.cancel();
  stage = `reject unauthenticated requests (expected HTTP 401, received ${response.status})`;
  if (response.status !== 401) throw new Error("Unauthenticated request was not rejected");
  console.log("PASS: unauthenticated requests return HTTP 401.");

  const client = new Client({ name: "omnifocus-bridge-check", version: BRIDGE_VERSION });
  try {
    stage = "initialize MCP (check the endpoint and bearer token)";
    await client.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { authorization: `Bearer ${config.token}` } },
        fetch: (input, init) =>
          fetch(input, {
            ...init,
            signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
            redirect: "error",
          }),
      }),
    );
    console.log(
      `PASS: MCP initialized; running version ${client.getServerVersion()?.version ?? "unknown"}.`,
    );
    stage = "discover the read-only tool count_tasks";
    const { tools } = await client.listTools();
    if (!tools.some((tool) => tool.name === "count_tasks")) throw new Error("Read tool is missing");
    stage = "read from OmniFocus (check macOS Automation permissions and bridge logs)";
    const result = await client.callTool(
      { name: "count_tasks", arguments: { searchText: "__bridge_health_check_no_match__" } },
      undefined,
      { timeout: 20_000 },
    );
    if (result.isError) throw new Error("App read failed");
    console.log("PASS: count_tasks read from OmniFocus; app content withheld.");
  } finally {
    await client.close();
  }
}

run().catch(() => {
  console.error(`FAIL: ${stage}.`);
  process.exitCode = 1;
});
