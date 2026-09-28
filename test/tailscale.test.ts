import { describe, expect, test } from "vitest";
import type { BridgeRuntime } from "../src/server.js";
import {
  assertPersistentTailscalePort,
  assertTailscalePathAvailable,
  buildTailscaleServeArgs,
  TAILSCALE_SERVE_PATH,
} from "../src/tailscale.js";

describe("tailscale serve integration", () => {
  test("requires a fixed local port for a persistent Serve route", () => {
    expect(() => assertPersistentTailscalePort(3050)).not.toThrow();
    expect(() => assertPersistentTailscalePort(0)).toThrow(/requires a fixed/);
  });

  test("builds a persistent background serve command for the fixed OmniFocus path", () => {
    const runtime = {
      url: new URL("http://127.0.0.1:3050/mcp"),
    } as BridgeRuntime;

    expect(buildTailscaleServeArgs(runtime)).toEqual([
      "serve",
      "--bg",
      "--set-path",
      TAILSCALE_SERVE_PATH,
      "http://127.0.0.1:3050/mcp",
    ]);
  });

  test("allows existing serve config on unrelated paths", () => {
    const status = JSON.stringify({
      Web: {
        "example.tailnet.ts.net:443": {
          Handlers: {
            "/grafana": {
              Proxy: "http://127.0.0.1:3000",
            },
          },
        },
      },
    });

    expect(() => assertTailscalePathAvailable(status)).not.toThrow();
  });

  test("allows the expected omnifocus-mcp route on restart", () => {
    const status = JSON.stringify({
      Web: {
        "example.tailnet.ts.net:443": {
          Handlers: {
            "/omnifocus-mcp": {
              Proxy: "http://127.0.0.1:3050/mcp",
            },
          },
        },
      },
    });

    expect(() =>
      assertTailscalePathAvailable(status, TAILSCALE_SERVE_PATH, "http://127.0.0.1:3050/mcp"),
    ).not.toThrow();
  });

  test("rejects an omnifocus-mcp route pointing to another target", () => {
    const status = JSON.stringify({
      Web: {
        "example.tailnet.ts.net:443": {
          Handlers: {
            "/omnifocus-mcp": {
              Proxy: "http://127.0.0.1:9999/mcp",
            },
          },
        },
      },
    });

    expect(() =>
      assertTailscalePathAvailable(status, TAILSCALE_SERVE_PATH, "http://127.0.0.1:3050/mcp"),
    ).toThrow(/path \/omnifocus-mcp is already configured for a different target/);
  });
});
