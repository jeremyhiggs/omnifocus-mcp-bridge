import { spawnSync } from "node:child_process";
import type { BridgeRuntime } from "./server.js";

export const TAILSCALE_SERVE_PATH = "/omnifocus-mcp";

export type TailscaleServeOptions = {
  tailscaleCommand?: string;
};

export function assertPersistentTailscalePort(port: number): void {
  if (port === 0) {
    throw new Error("Tailscale Serve mode requires a fixed OMNIFOCUS_MCP_PORT.");
  }
}

export function buildTailscaleServeArgs(runtime: BridgeRuntime): string[] {
  return ["serve", "--bg", "--set-path", TAILSCALE_SERVE_PATH, runtime.url.href];
}

export function assertTailscalePathAvailable(
  statusOutput: string,
  path: string = TAILSCALE_SERVE_PATH,
  expectedProxy?: string,
): void {
  const normalizedPath = normalizePath(path);
  const parsed = parseStatusOutput(statusOutput);
  const handler = findPathHandler(parsed, normalizedPath);
  if (handler !== undefined && proxyTarget(handler) !== expectedProxy) {
    throw new Error(
      `Tailscale Serve path ${normalizedPath} is already configured for a different target. Refusing to overwrite it.`,
    );
  }
}

export function checkTailscaleServePathAvailable(
  runtime: BridgeRuntime,
  tailscaleCommand: string = "tailscale",
): void {
  const status = spawnSync(tailscaleCommand, ["serve", "status", "--json"], {
    encoding: "utf8",
  });

  if (status.error) {
    throw status.error;
  }

  if (status.status !== 0) {
    const output = `${status.stdout ?? ""}${status.stderr ?? ""}`.trim();
    throw new Error(output || `tailscale serve status exited with ${String(status.status)}`);
  }

  assertTailscalePathAvailable(status.stdout ?? "", TAILSCALE_SERVE_PATH, runtime.url.href);
}

export function registerTailscaleServe(
  runtime: BridgeRuntime,
  options: TailscaleServeOptions = {},
): void {
  const tailscaleCommand = options.tailscaleCommand ?? "tailscale";
  const result = spawnSync(tailscaleCommand, buildTailscaleServeArgs(runtime), {
    encoding: "utf8",
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    throw new Error(output || `tailscale serve exited with ${String(result.status)}`);
  }
}

function parseStatusOutput(output: string): unknown {
  if (output.trim() === "") {
    return {};
  }

  try {
    return JSON.parse(output) as unknown;
  } catch {
    return output;
  }
}

function findPathHandler(value: unknown, path: string): unknown {
  if (Array.isArray(value)) {
    for (const item of value) {
      const handler = findPathHandler(item, path);
      if (handler !== undefined) {
        return handler;
      }
    }
    return undefined;
  }

  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (normalizePath(key) === path) {
        return child;
      }
      const handler = findPathHandler(child, path);
      if (handler !== undefined) {
        return handler;
      }
    }
  }

  return undefined;
}

function proxyTarget(handler: unknown): string | undefined {
  if (!handler || typeof handler !== "object" || Array.isArray(handler)) {
    return undefined;
  }

  const proxy = (handler as Record<string, unknown>).Proxy;
  return typeof proxy === "string" ? proxy : undefined;
}

function normalizePath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}
