import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, stat, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, test } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));

test("relocated release runs without dependencies and installation cleans old releases", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "omnifocus-release-"));
  const release = path.join(temp, "release & portable");
  const bin = path.join(temp, "bin");
  const automationLog = path.join(temp, "automation.log");
  const launchLog = path.join(temp, "launch.log");
  let child: ChildProcessWithoutNullStreams | undefined;
  let client: Client | undefined;
  try {
    execFileSync(process.execPath, ["scripts/build-release.mjs", release], { cwd: root });
    const metadata = JSON.parse(await readFile(path.join(release, "package.json"), "utf8"));
    const version = `${metadata.version}+${metadata.buildId}`;
    expect(metadata.buildId).toMatch(/^[0-9a-f]{12}$/);
    for (const entry of ["index.js", "tailscale-start.js"]) {
      expect(
        execFileSync(process.execPath, [path.join(release, "dist", entry), "--version"], {
          cwd: temp,
        })
          .toString()
          .trim(),
      ).toBe(version);
    }
    await mkdir(bin);
    expect(await readdir(release)).not.toContain("node_modules");
    expect(await readdir(release)).not.toContain(".secrets");
    expect(await readdir(release)).not.toContain(".env");
    const notices = await readFile(path.join(release, "THIRD_PARTY_NOTICES.txt"), "utf8");
    expect(notices).toContain("@modelcontextprotocol/sdk@");
    expect(notices).toContain("omnifocus-mcp-enhanced@2.1.1");
    expect(notices).not.toContain("undefined@");
    const env = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) =>
            !key.startsWith("OMNIFOCUS_MCP_") && key !== "NODE_PATH" && key !== "NODE_OPTIONS",
        ),
      ),
      PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: path.join(temp, "home & settings"),
      XDG_CONFIG_HOME: path.join(temp, "home & settings", "xdg & config"),
      OMNIFOCUS_MCP_PORT: "0",
    };
    // Fail if any release command attempts to rebuild or install dependencies.
    await writeFile(path.join(bin, "pnpm"), "#!/bin/sh\nexit 97\n", { mode: 0o755 });
    await writeFile(path.join(bin, "tailscale"), "#!/bin/sh\necho '{}'\n", { mode: 0o755 });
    await writeFile(
      path.join(bin, "launchctl"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${launchLog}'\ncase "$1" in\n  print)\n    if [ -f '${path.join(temp, "launch.state")}' ]; then\n      if [ -f '${path.join(temp, "old-release")}' ] && [ -d "$(cat '${path.join(temp, "old-release")}')" ]; then\n        echo 'running-before-cleanup' >> '${launchLog}'\n      fi\n      echo 'state = running'\n    else\n      exit 1\n    fi ;;\n  bootout) rm -f '${path.join(temp, "launch.state")}' ;;\n  bootstrap) touch '${path.join(temp, "launch.state")}' ;;\nesac\n`,
      { mode: 0o755 },
    );
    await writeFile(
      path.join(bin, "osascript"),
      `#!${process.execPath}\n` +
        `const fs = require("node:fs");\n` +
        `const script = fs.readFileSync(process.argv.at(-1), "utf8");\n` +
        `fs.appendFileSync(${JSON.stringify(automationLog)}, script);\n` +
        `console.log(JSON.stringify({ tasks: [], folders: {}, projects: {}, tags: {} }));\n`,
      { mode: 0o755 },
    );

    execFileSync(path.join(release, "scripts/generate-token.sh"), { env, cwd: temp });
    const tokenPath = path.join(env.XDG_CONFIG_HOME, "omnifocus-mcp-bridge/token");
    expect((await stat(tokenPath)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(tokenPath))).mode & 0o777).toBe(0o700);
    child = spawn(path.join(release, "scripts/run-server.sh"), { env, cwd: temp });
    const url = await waitForUrl(child);
    expect((await fetch(url)).status).toBe(401);
    client = new Client({ name: "release-test", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: {
          headers: {
            authorization: `Bearer ${(await readFile(tokenPath, "utf8")).trim()}`,
          },
        },
      }),
    );
    expect(client.getServerVersion()?.version).toBe(version);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("dump_database");
    expect((await client.callTool({ name: "dump_database", arguments: {} })).isError).not.toBe(
      true,
    );
    expect(
      (await client.callTool({ name: "get_tasks", arguments: { source: "inbox" } })).isError,
    ).not.toBe(true);
    const scripts = await readFile(automationLog, "utf8");
    expect(scripts).toContain("Application('OmniFocus')");
    expect(scripts).toContain("omnifocusMcpTaskStatus");
    await expect(client.callTool({ name: "add_omnifocus_task", arguments: {} })).rejects.toThrow(
      /read_only is enabled/i,
    );
    await client.close();
    client = undefined;
    await stop(child);
    child = undefined;

    // Mock launchctl confines installation to a temporary home; plutil still validates real XML.
    await chmod(tokenPath, 0o644);
    expect(() =>
      execFileSync(path.join(release, "scripts/install-launch-agent.sh"), {
        env,
        cwd: temp,
        stdio: "pipe",
      }),
    ).toThrow();
    await expect(stat(launchLog)).rejects.toThrow();
    await chmod(tokenPath, 0o600);
    // Migrate settings from a previous direct-run release without copying .env into launchd.
    await writeFile(path.join(release, ".env"), "OMNIFOCUS_MCP_READ_ONLY=false\n");
    await mkdir(path.join(release, ".secrets"));
    await writeFile(path.join(release, ".secrets", "marker"), "do-not-archive\n");
    execFileSync(process.execPath, ["scripts/build-release.mjs", release], { cwd: root });
    expect(await readFile(path.join(release, ".env"), "utf8")).toContain("READ_ONLY=false");
    const archiveFiles = execFileSync("tar", ["-tzf", `${release}.tar.gz`]).toString();
    expect(archiveFiles).not.toMatch(/(?:^|\/)\.env(?:\n|$)/);
    expect(archiveFiles).not.toContain(".secrets");
    execFileSync(path.join(release, "scripts/install-launch-agent.sh"), { env, cwd: temp });
    const configFile = path.join(env.XDG_CONFIG_HOME, "omnifocus-mcp-bridge/config.env");
    expect(await readFile(configFile, "utf8")).toBe("OMNIFOCUS_MCP_READ_ONLY=false\n");
    expect((await stat(configFile)).mode & 0o777).toBe(0o600);
    const plist = await readFile(
      path.join(env.HOME, "Library/LaunchAgents/local.omnifocus-mcp-bridge.plist"),
      "utf8",
    );
    const installedRelease = execFileSync(
      "plutil",
      [
        "-extract",
        "EnvironmentVariables.OMNIFOCUS_MCP_BRIDGE_ROOT",
        "raw",
        path.join(env.HOME, "Library/LaunchAgents/local.omnifocus-mcp-bridge.plist"),
      ],
      { env },
    )
      .toString()
      .trim();
    expect(installedRelease).toContain(
      path.join(env.HOME, "Library/Application Support/omnifocus-mcp-bridge/releases"),
    );
    expect(await readdir(installedRelease)).not.toContain(".env");
    expect(await readdir(installedRelease)).not.toContain(".secrets");
    expect(plist).toContain(installedRelease.replaceAll("&", "&amp;"));
    expect(plist).toContain(env.XDG_CONFIG_HOME.replaceAll("&", "&amp;"));
    expect(plist).not.toContain(release.replaceAll("&", "&amp;"));
    expect(plist).not.toContain("__REPO_ROOT__");
    expect(await readFile(launchLog, "utf8")).toContain("bootstrap");
    const launcher = path.join(
      env.HOME,
      "Library/Application Support/omnifocus-mcp-bridge/omnifocus-mcp-bridge.sh",
    );
    expect(await readFile(launcher, "utf8")).not.toContain("pnpm");
    const reservation = createServer();
    await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
    const address = reservation.address();
    if (!address || typeof address === "string") throw new Error("No test port assigned");
    const port = address.port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    child = spawn(launcher, {
      env: {
        ...env,
        OMNIFOCUS_MCP_BRIDGE_ROOT: installedRelease,
        OMNIFOCUS_MCP_PORT: String(port),
      },
      cwd: temp,
    });
    const tailscaleUrl = await waitForUrl(child);
    expect((await fetch(tailscaleUrl)).status).toBe(401);
    await stop(child);
    child = undefined;

    await rm(path.join(release, ".env"));
    // A legacy installed release may still hold the live settings in .env.
    await writeFile(path.join(installedRelease, ".env"), "OMNIFOCUS_MCP_READ_ONLY=true\n");
    await rm(configFile);
    execFileSync(process.execPath, ["scripts/build-release.mjs", release], { cwd: root });
    await expect(stat(path.join(release, ".env"))).rejects.toThrow();
    await writeFile(path.join(temp, "old-release"), installedRelease);
    execFileSync(path.join(release, "scripts/install-launch-agent.sh"), { env, cwd: temp });
    const nextRelease = execFileSync(
      "plutil",
      [
        "-extract",
        "EnvironmentVariables.OMNIFOCUS_MCP_BRIDGE_ROOT",
        "raw",
        path.join(env.HOME, "Library/LaunchAgents/local.omnifocus-mcp-bridge.plist"),
      ],
      { env },
    )
      .toString()
      .trim();
    expect(nextRelease).not.toBe(installedRelease);
    expect(await readdir(nextRelease)).not.toContain(".env");
    expect(await readFile(configFile, "utf8")).toBe("OMNIFOCUS_MCP_READ_ONLY=true\n");
    expect(await readFile(launchLog, "utf8")).toContain("running-before-cleanup");
    await expect(stat(installedRelease)).rejects.toThrow();
  } finally {
    await client?.close();
    if (child) await stop(child);
    await rm(temp, { recursive: true, force: true });
  }
}, 30_000);

function waitForUrl(child: ChildProcessWithoutNullStreams): Promise<URL> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Release startup timed out: ${output}`));
    }, 15_000);
    const onExit = () => {
      cleanup();
      reject(new Error(`Release exited: ${output}`));
    };
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      const match = output.match(/(?:listening on |local=)(http:\/\/\S+)/);
      if (match) {
        cleanup();
        resolve(new URL(match[1]));
      }
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("exit", onExit);
      child.stderr.off("data", onData);
    };
    child.once("exit", onExit);
    child.stderr.on("data", onData);
  });
}

async function stop(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill("SIGTERM");
  });
}
