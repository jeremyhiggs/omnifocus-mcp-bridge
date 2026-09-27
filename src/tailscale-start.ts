#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import { parseRuntimeArgs } from "./runtime-args.js";
import { startBridge } from "./server.js";
import {
  assertPersistentTailscalePort,
  buildTailscaleServeArgs,
  checkTailscaleServePathAvailable,
  registerTailscaleServe,
  TAILSCALE_SERVE_PATH,
} from "./tailscale.js";
import { connectUpstream } from "./upstream.js";

export async function run(args: string[] = process.argv.slice(2)): Promise<void> {
  const runtimeArgs = parseRuntimeArgs(args);
  const config = loadConfig(process.env, {
    verbose: runtimeArgs.verbose,
  });
  if (config.host !== "127.0.0.1" && config.host !== "localhost") {
    throw new Error("Tailscale Serve mode requires OMNIFOCUS_MCP_HOST=127.0.0.1.");
  }
  assertPersistentTailscalePort(config.port);

  const upstream = await connectUpstream(config.upstreamCommand, config.upstreamArgs);
  const runtime = await startBridge(config, upstream);
  const serveArgs = buildTailscaleServeArgs(runtime);

  checkTailscaleServePathAvailable(runtime);
  registerTailscaleServe(runtime);

  console.error(
    `omnifocus-mcp-bridge local=${runtime.url.href} readOnly=${String(config.readOnly)} verbose=${String(config.verbose)} upstreamBin=${config.upstreamBinPath}`,
  );
  console.error(
    `tailscale serve path=${TAILSCALE_SERVE_PATH} command=tailscale ${serveArgs.join(" ")}`,
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
