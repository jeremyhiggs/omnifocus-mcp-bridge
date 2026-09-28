import path from "node:path";
import { fileURLToPath } from "node:url";
import { chmod, mkdir, mkdtemp, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DEFAULT_TOKEN_FILE, loadConfig } from "../src/config.js";
import { filterToolsForPolicy } from "../src/policy.js";
import { startBridge, type BridgeRuntime } from "../src/server.js";
import { connectUpstream, type UpstreamConnection } from "../src/upstream.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fakeUpstreamPath = path.join(__dirname, "fixtures", "fake-upstream.mjs");

let runtime: BridgeRuntime | undefined;
let upstream: UpstreamConnection | undefined;

afterEach(async () => {
  if (runtime) {
    await runtime.close();
    runtime = undefined;
    upstream = undefined;
  } else if (upstream) {
    await upstream.close();
    upstream = undefined;
  }
});

describe("config", () => {
  test("fails closed when the bearer token is missing", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "omnifocus-bridge-"));

    expect(() =>
      loadConfig(
        {
          OMNIFOCUS_MCP_TOKEN: "",
        },
        { cwd: tempDir, homeDir: tempDir },
      ),
    ).toThrow(/OMNIFOCUS_MCP_TOKEN, OMNIFOCUS_MCP_TOKEN_FILE, or .*\/token/);
  });

  test("defaults remote access to read-only mode", () => {
    const config = loadConfig({
      OMNIFOCUS_MCP_TOKEN: "test-token",
    });

    expect(config.readOnly).toBe(true);
    expect(config.tailscaleServe).toBe(false);
  });

  test("uses an args-only override with the default upstream command", () => {
    const config = loadConfig({
      OMNIFOCUS_MCP_TOKEN: "test-token",
      OMNIFOCUS_MCP_UPSTREAM_ARGS: '["/absolute/path/to/custom/server.js"]',
    });

    expect(config.upstreamCommand).toBe(process.execPath);
    expect(config.upstreamArgs).toEqual(["/absolute/path/to/custom/server.js"]);
  });

  test("uses an explicitly empty args override with the default upstream command", () => {
    const config = loadConfig({
      OMNIFOCUS_MCP_TOKEN: "test-token",
      OMNIFOCUS_MCP_UPSTREAM_ARGS: "",
    });

    expect(config.upstreamCommand).toBe(process.execPath);
    expect(config.upstreamArgs).toEqual([]);
  });

  test("enables verbose mode from env or load options", () => {
    expect(
      loadConfig({
        OMNIFOCUS_MCP_TOKEN: "test-token",
        OMNIFOCUS_MCP_VERBOSE: "true",
      }).verbose,
    ).toBe(true);

    expect(
      loadConfig(
        {
          OMNIFOCUS_MCP_TOKEN: "test-token",
          OMNIFOCUS_MCP_VERBOSE: "false",
        },
        {
          verbose: true,
        },
      ).verbose,
    ).toBe(true);
  });

  test("loads bearer token from the default private token file without .env", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "omnifocus-bridge-"));
    const tokenPath = path.join(tempDir, DEFAULT_TOKEN_FILE);
    await mkdir(path.dirname(tokenPath), { recursive: true, mode: 0o700 });
    await writeFile(tokenPath, "default-file-token\n", { mode: 0o600 });

    const config = loadConfig({}, { cwd: tmpdir(), homeDir: tempDir });

    expect(config.token).toBe("default-file-token");
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(3050);
    expect(config.readOnly).toBe(true);
  });

  test("loads non-secret config from .env and bearer token from a private file", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "omnifocus-bridge-"));
    const tokenPath = path.join(tempDir, "token");
    await writeFile(tokenPath, "file-token\n", { mode: 0o600 });
    await writeFile(
      path.join(tempDir, ".env"),
      [
        `OMNIFOCUS_MCP_TOKEN_FILE=${tokenPath}`,
        "OMNIFOCUS_MCP_HOST=100.64.0.10",
        "OMNIFOCUS_MCP_PORT=4444",
        "OMNIFOCUS_MCP_READ_ONLY=false",
      ].join("\n"),
    );

    const config = loadConfig({}, { cwd: tempDir });

    expect(config.token).toBe("file-token");
    expect(config.host).toBe("100.64.0.10");
    expect(config.port).toBe(4444);
    expect(config.readOnly).toBe(false);
  });

  test("environment variables override .env values", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "omnifocus-bridge-"));
    const tokenPath = path.join(tempDir, "token");
    await writeFile(tokenPath, "file-token\n", { mode: 0o600 });
    await writeFile(
      path.join(tempDir, ".env"),
      [`OMNIFOCUS_MCP_TOKEN_FILE=${tokenPath}`, "OMNIFOCUS_MCP_PORT=4444"].join("\n"),
    );

    const config = loadConfig(
      {
        OMNIFOCUS_MCP_TOKEN: "env-token",
        OMNIFOCUS_MCP_PORT: "5555",
      },
      { cwd: tempDir },
    );

    expect(config.token).toBe("env-token");
    expect(config.port).toBe(5555);
  });

  test("loads XDG config before local .env and process environment", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "omnifocus-bridge-"));
    const configDir = path.join(tempDir, "xdg", "omnifocus-mcp-bridge");
    const cwd = path.join(tempDir, "work");
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    await mkdir(cwd);
    await writeFile(path.join(configDir, "token"), "separate-token\n", { mode: 0o600 });
    await writeFile(
      path.join(configDir, "config.env"),
      "OMNIFOCUS_MCP_PORT=4000\nOMNIFOCUS_MCP_READ_ONLY=false\nOMNIFOCUS_MCP_TAILSCALE_SERVE=true\n",
      { mode: 0o600 },
    );
    await writeFile(
      path.join(cwd, ".env"),
      "OMNIFOCUS_MCP_PORT=5000\nOMNIFOCUS_MCP_TAILSCALE_SERVE=false\n",
    );
    const env = { XDG_CONFIG_HOME: path.join(tempDir, "xdg") };
    expect(loadConfig(env, { cwd }).port).toBe(5000);
    expect(loadConfig(env, { cwd }).readOnly).toBe(false);
    expect(loadConfig(env, { cwd }).token).toBe("separate-token");
    expect(loadConfig(env, { cwd }).tailscaleServe).toBe(false);
    expect(loadConfig({ ...env, OMNIFOCUS_MCP_PORT: "6000" }, { cwd }).port).toBe(6000);
    expect(
      loadConfig({ ...env, OMNIFOCUS_MCP_TAILSCALE_SERVE: "true" }, { cwd }).tailscaleServe,
    ).toBe(true);
    await chmod(path.join(configDir, "config.env"), 0o644);
    expect(() => loadConfig(env, { cwd })).toThrow(/config.env must have mode 0600/);
    await chmod(path.join(configDir, "config.env"), 0o600);
    await chmod(configDir, 0o755);
    expect(() => loadConfig(env, { cwd })).toThrow(/mode 0700/);
  });

  test("resolves a relative token file path from an explicit env file directory", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "omnifocus-bridge-"));
    const envPath = path.join(tempDir, "bridge.env");
    const tokenPath = path.join(tempDir, ".secrets", "token");
    await mkdir(path.dirname(tokenPath));
    await writeFile(tokenPath, "relative-file-token\n", { mode: 0o600 });
    await writeFile(envPath, "OMNIFOCUS_MCP_TOKEN_FILE=.secrets/token\n");

    const config = loadConfig(
      {
        OMNIFOCUS_MCP_ENV_FILE: envPath,
      },
      { cwd: tmpdir() },
    );

    expect(config.token).toBe("relative-file-token");
  });

  test("rejects token files that are group or world readable", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "omnifocus-bridge-"));
    const tokenPath = path.join(tempDir, "token");
    await writeFile(tokenPath, "file-token\n");
    await chmod(tokenPath, 0o644);

    expect(() =>
      loadConfig({
        OMNIFOCUS_MCP_TOKEN_FILE: tokenPath,
      }),
    ).toThrow(/mode 0600/);
  });

  test("rejects a non-private default token directory and symbolic link token", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "omnifocus-bridge-"));
    const tokenPath = path.join(homeDir, DEFAULT_TOKEN_FILE);
    await mkdir(path.dirname(tokenPath), { recursive: true, mode: 0o755 });
    await writeFile(tokenPath, "test-token\n", { mode: 0o600 });
    expect(() => loadConfig({}, { cwd: homeDir, homeDir })).toThrow(/mode 0700/);
    await chmod(path.dirname(tokenPath), 0o700);
    const linkPath = path.join(homeDir, "token-link");
    await symlink(tokenPath, linkPath);
    expect(() => loadConfig({ OMNIFOCUS_MCP_TOKEN_FILE: linkPath }, { cwd: homeDir })).toThrow(
      /symbolic link/,
    );
  });
});

describe("upstream child process", () => {
  test("launches a stdio MCP child process", async () => {
    upstream = await connectUpstream(process.execPath, [fakeUpstreamPath]);

    expect(upstream.transport.pid).toEqual(expect.any(Number));
    const tools = await upstream.client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain("dump_database");
  });

  test("notifies when the stdio MCP child process closes", async () => {
    upstream = await connectUpstream(process.execPath, [fakeUpstreamPath]);

    const closed = new Promise<void>((resolve) => {
      upstream?.onClose(resolve);
    });
    await upstream.close();
    upstream = undefined;

    await expect(closed).resolves.toBeUndefined();
  });
});

describe("tool policy", () => {
  test("advertises a narrowed read-only perspective contract", () => {
    const [tool] = filterToolsForPolicy(
      [
        {
          name: "manage_perspectives",
          description: "List, inspect, and update perspectives",
          inputSchema: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["list", "get", "update"] },
              id: { type: "string" },
              name: { type: "string" },
              newName: { type: "string" },
              rules: { type: "object" },
              iconColor: { type: "string" },
              dryRun: { type: "boolean" },
            },
            required: ["action"],
            additionalProperties: false,
          },
          annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
          },
        },
      ],
      { readOnly: true },
    );

    expect(tool).toMatchObject({
      description: expect.stringContaining("Read-only"),
      inputSchema: {
        properties: {
          action: { enum: ["list", "get"] },
        },
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    });
    expect(tool.inputSchema.properties).not.toHaveProperty("newName");
    expect(tool.inputSchema.properties).not.toHaveProperty("rules");
    expect(tool.inputSchema.properties).not.toHaveProperty("iconColor");
    expect(tool.inputSchema.properties).not.toHaveProperty("dryRun");
  });
});

describe("bridge server", () => {
  test("starts on the configured host and port", async () => {
    runtime = await startTestBridge();

    expect(runtime.url.hostname).toBe("127.0.0.1");
    expect(Number(runtime.url.port)).toBeGreaterThan(0);
  });

  test("rejects requests without valid bearer auth", async () => {
    runtime = await startTestBridge();

    const response = await fetch(runtime.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: {
            name: "smoke",
            version: "0.0.0",
          },
        },
      }),
    });

    expect(response.status).toBe(401);
  });

  test("accepts valid bearer auth and exposes read-only tools only", async () => {
    runtime = await startTestBridge();
    const client = new Client({
      name: "bridge-smoke",
      version: "0.0.0",
    });
    const transport = new StreamableHTTPClientTransport(runtime.url, {
      requestInit: {
        headers: {
          authorization: "Bearer test-token",
        },
      },
    });

    await client.connect(transport);
    const tools = await client.listTools();
    await client.close();

    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "dump_database",
      "get_tasks",
      "manage_perspectives",
    ]);
    const perspectiveTool = tools.tools.find((tool) => tool.name === "manage_perspectives");
    expect(perspectiveTool).toMatchObject({
      description: expect.stringContaining("Read-only"),
      inputSchema: {
        properties: {
          action: { enum: ["list", "get"] },
        },
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    });
    expect(perspectiveTool?.inputSchema.properties).not.toHaveProperty("newName");
    expect(perspectiveTool?.inputSchema.properties).not.toHaveProperty("rules");
    expect(perspectiveTool?.inputSchema.properties).not.toHaveProperty("iconColor");
    expect(perspectiveTool?.inputSchema.properties).not.toHaveProperty("dryRun");
  });

  test("forwards task IDs from the consolidated custom-perspective tool", async () => {
    runtime = await startTestBridge();
    const client = new Client({
      name: "bridge-smoke",
      version: "0.0.0",
    });
    const transport = new StreamableHTTPClientTransport(runtime.url, {
      requestInit: {
        headers: {
          authorization: "Bearer test-token",
        },
      },
    });

    await client.connect(transport);
    const result = await client.callTool({
      name: "get_tasks",
      arguments: {
        source: "custom",
        perspectiveName: "Fake perspective",
      },
    });
    await client.close();

    expect(result.structuredContent).toMatchObject({
      source: "custom",
      count: 1,
      tasks: [{ id: "fake-task-id" }],
    });
  });

  test("rejects mutating tool calls while read-only mode is enabled", async () => {
    runtime = await startTestBridge();
    const client = new Client({
      name: "bridge-smoke",
      version: "0.0.0",
    });
    const transport = new StreamableHTTPClientTransport(runtime.url, {
      requestInit: {
        headers: {
          authorization: "Bearer test-token",
        },
      },
    });

    await client.connect(transport);
    await expect(client.callTool({ name: "add_omnifocus_task", arguments: {} })).rejects.toThrow(
      /not available while OMNIFOCUS_MCP_READ_ONLY is enabled/,
    );
    await client.close();
  });

  test("allows perspective discovery but rejects perspective updates in read-only mode", async () => {
    runtime = await startTestBridge();
    const client = new Client({
      name: "bridge-smoke",
      version: "0.0.0",
    });
    const transport = new StreamableHTTPClientTransport(runtime.url, {
      requestInit: {
        headers: {
          authorization: "Bearer test-token",
        },
      },
    });

    await client.connect(transport);
    const result = await client.callTool({
      name: "manage_perspectives",
      arguments: { action: "list" },
    });
    expect(result.isError).not.toBe(true);
    await expect(
      client.callTool({
        name: "manage_perspectives",
        arguments: { action: "update", name: "Fake perspective", newName: "Renamed" },
      }),
    ).rejects.toThrow(/not available while OMNIFOCUS_MCP_READ_ONLY is enabled/);
    await client.close();
  });

  test("verbose mode logs redacted request metadata", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    runtime = await startTestBridge({
      verbose: true,
    });

    const response = await fetch(runtime.url, {
      method: "POST",
      headers: {
        authorization: "Bearer wrong-secret-value",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });

    expect(response.status).toBe(401);
    const logOutput = consoleError.mock.calls.map((call) => call.join(" ")).join("\n");
    consoleError.mockRestore();

    expect(logOutput).toContain("[request]");
    expect(logOutput).toContain('"method":"POST"');
    expect(logOutput).toContain('"path":"/mcp"');
    expect(logOutput).toContain('"statusCode":401');
    expect(logOutput).toContain('"authorized":false');
    expect(logOutput).toContain('"hasAuthorizationHeader":true');
    expect(logOutput).not.toContain("wrong-secret-value");
  });
});

async function startTestBridge(options: { verbose?: boolean } = {}): Promise<BridgeRuntime> {
  upstream = await connectUpstream(process.execPath, [fakeUpstreamPath]);
  return startBridge(
    {
      token: "test-token",
      host: "127.0.0.1",
      port: 0,
      readOnly: true,
      upstreamCommand: process.execPath,
      upstreamArgs: [fakeUpstreamPath],
      upstreamBinPath: fakeUpstreamPath,
      verbose: options.verbose ?? false,
      tailscaleServe: false,
    },
    upstream,
  );
}
