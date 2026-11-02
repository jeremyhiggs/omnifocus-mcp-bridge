import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const execute = promisify(execFile);

test("restart restores logs and restarts only the installed service", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "bridge-restart-"));
  const bin = path.join(home, "bin");
  const log = path.join(home, "launchctl.log");
  await mkdir(bin);
  await writeFile(
    path.join(bin, "launchctl"),
    `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
if [ "$1" = print ]; then echo 'state = running'; fi
`,
    { mode: 0o755 },
  );
  await execute("sh", [path.join(root, "scripts/restart-launch-agent.sh")], {
    env: { ...process.env, HOME: home, PATH: `${bin}:/usr/bin:/bin` },
  });
  expect(await readFile(log, "utf8")).toContain(
    `kickstart -k gui/${process.getuid?.()}/local.omnifocus-mcp-bridge`,
  );
  expect((await stat(path.join(home, "Library/Logs/omnifocus-mcp-bridge"))).isDirectory()).toBe(
    true,
  );
});

test.each([
  false,
  true,
])("live check detects app errors without printing app data (error=%s)", async (appError) => {
  const requests: string[] = [];
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== "Bearer diagnostic-token") {
      res.writeHead(401).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    requests.push(request.method);
    if (request.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    let result: unknown;
    switch (request.method) {
      case "initialize":
        result = {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "fixture", version: "1.2.3" },
        };
        break;
      case "tools/list":
        result = {
          tools: [{ name: "count_tasks", inputSchema: { type: "object", properties: {} } }],
        };
        break;
      case "tools/call":
        expect(request.params.name).toBe("count_tasks");
        result = {
          isError: appError,
          content: [{ type: "text", text: "private app data diagnostic-token" }],
        };
        break;
      default:
        res.writeHead(400).end();
        return;
    }
    res
      .writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test listener");
  const home = await mkdtemp(path.join(tmpdir(), "bridge-check-"));
  try {
    const invocation = execute(
      process.execPath,
      [
        "--import",
        "tsx",
        path.join(root, "src/check-bridge.ts"),
        `http://127.0.0.1:${address.port}/mcp`,
      ],
      {
        cwd: root,
        env: { ...process.env, XDG_CONFIG_HOME: home, OMNIFOCUS_MCP_TOKEN: "diagnostic-token" },
      },
    );
    if (appError) {
      const failure = await invocation.catch(
        (error: { code: number; stdout: string; stderr: string }) => error,
      );
      expect(failure).toHaveProperty("code", 1);
      expect(failure.stderr).toContain("FAIL");
      expect(failure.stdout + failure.stderr).not.toMatch(/private app data|diagnostic-token/);
    } else {
      const output = await invocation;
      expect(output.stdout).toContain("PASS");
      expect(output.stdout).toContain("1.2.3");
      expect(output.stdout + output.stderr).not.toMatch(/private app data|diagnostic-token/);
    }
    expect(requests).toContain("initialize");
    expect(requests).toContain("tools/list");
    expect(requests).toContain("tools/call");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("restart refuses an unloaded service", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "bridge-unloaded-"));
  const bin = path.join(home, "bin");
  await mkdir(bin);
  await writeFile(path.join(bin, "launchctl"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  await expect(
    execute("sh", [path.join(root, "scripts/restart-launch-agent.sh")], {
      env: { ...process.env, HOME: home, PATH: `${bin}:/usr/bin:/bin` },
    }),
  ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("not loaded") });
});

test.each([
  "http://example.com/mcp",
  "https://user:password@example.com/mcp",
])("live check refuses unsafe endpoint %s", async (url) => {
  const home = await mkdtemp(path.join(tmpdir(), "bridge-unsafe-"));
  const result = await execute(
    process.execPath,
    ["--import", "tsx", path.join(root, "src/check-bridge.ts"), url],
    {
      cwd: root,
      env: { ...process.env, XDG_CONFIG_HOME: home, OMNIFOCUS_MCP_TOKEN: "diagnostic-token" },
    },
  ).catch((error: { code: number; stdout: string; stderr: string }) => error);
  expect(result).toHaveProperty("code", 1);
  expect(result.stderr).toContain("validate endpoint");
  expect(result.stdout + result.stderr).not.toMatch(/diagnostic-token|password/);
});

test("live check stops before sending credentials when unauthenticated access succeeds", async () => {
  let authenticated = false;
  const server = createServer((req, res) => {
    authenticated ||= req.headers.authorization !== undefined;
    res.writeHead(200).end("public endpoint");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test listener");
  const home = await mkdtemp(path.join(tmpdir(), "bridge-auth-check-"));
  try {
    const result = await execute(
      process.execPath,
      [
        "--import",
        "tsx",
        path.join(root, "src/check-bridge.ts"),
        `http://127.0.0.1:${address.port}/mcp`,
      ],
      {
        cwd: root,
        env: { ...process.env, XDG_CONFIG_HOME: home, OMNIFOCUS_MCP_TOKEN: "diagnostic-token" },
      },
    ).catch((error: { code: number; stdout: string; stderr: string }) => error);
    expect(result).toHaveProperty("code", 1);
    expect(result.stderr).toContain("expected HTTP 401, received 200");
    expect(authenticated).toBe(false);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("live check exits when the initialized notification stalls", async () => {
  let initialized = false;
  const server = createServer(async (req, res) => {
    if (!req.headers.authorization) {
      res.writeHead(401).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    if (request.method === "notifications/initialized") {
      initialized = true;
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "stalled-fixture", version: "1.2.3" },
        },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test listener");
  const home = await mkdtemp(path.join(tmpdir(), "bridge-stalled-"));
  try {
    const result = await execute(
      process.execPath,
      [
        "--import",
        "tsx",
        path.join(root, "src/check-bridge.ts"),
        `http://127.0.0.1:${address.port}/mcp`,
      ],
      {
        cwd: root,
        env: { ...process.env, XDG_CONFIG_HOME: home, OMNIFOCUS_MCP_TOKEN: "diagnostic-token" },
        timeout: 22_000,
        killSignal: "SIGKILL",
      },
    ).catch((error: { code: number; signal: string | null; stderr: string }) => error);
    expect(initialized).toBe(true);
    expect(result).toHaveProperty("code", 1);
    expect(result).toHaveProperty("signal", null);
    expect(result.stderr).toContain("FAIL: initialize MCP");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}, 30_000);
