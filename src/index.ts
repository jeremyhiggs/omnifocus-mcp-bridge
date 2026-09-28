#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import { parseRuntimeArgs } from "./runtime-args.js";
import { startBridge } from "./server.js";
import { connectUpstream } from "./upstream.js";
import { BRIDGE_VERSION } from "./version.js";

export async function run(args: string[] = process.argv.slice(2)): Promise<void> {
  if (args.length === 1 && args[0] === "--version") {
    console.log(BRIDGE_VERSION);
    return;
  }
  const runtimeArgs = parseRuntimeArgs(args);
  const config = loadConfig(process.env, {
    verbose: runtimeArgs.verbose,
  });
  const upstream = await connectUpstream(config.upstreamCommand, config.upstreamArgs);
  const runtime = await startBridge(config, upstream);

  console.error(
    `omnifocus-mcp-bridge listening on ${runtime.url.href} version=${BRIDGE_VERSION} readOnly=${String(config.readOnly)} verbose=${String(config.verbose)} upstreamBin=${config.upstreamBinPath}`,
  );

  let shuttingDown = false;
  const shutdown = async (exitCode: number) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    await runtime.close();
    process.exit(exitCode);
  };

  upstream.onClose(() => {
    if (!shuttingDown) {
      console.error("upstream stdio MCP process exited; shutting down bridge");
      void shutdown(1);
    }
  });

  process.once("SIGINT", () => {
    void shutdown(0);
  });
  process.once("SIGTERM", () => {
    void shutdown(0);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  run().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
