import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

describe("runner scripts", () => {
  test.each([
    "run-server.sh",
    "run-tailscale.sh",
    "generate-token.sh",
    "omnifocus-mcp-bridge.sh",
  ])("%s rebuilds before executing compiled output", async (scriptName) => {
    const script = await readFile(path.join(repoRoot, "scripts", scriptName), "utf8");

    if (scriptName === "run-tailscale.sh") {
      expect(script).toContain('OMNIFOCUS_MCP_BRIDGE_ROOT="$ROOT_DIR"');
      expect(script).toContain("scripts/omnifocus-mcp-bridge.sh");
    } else if (scriptName === "omnifocus-mcp-bridge.sh") {
      expect(script).toContain('pnpm --dir "$ROOT_DIR" run build');
      expect(script).toContain('node "$ROOT_DIR/dist/tailscale-start.js"');
    } else {
      expect(script).toContain("pnpm run build");
    }
    expect(script).not.toMatch(/if \[ ! -f dist\//);
  });

  test("launch agent log script tails stdout and stderr logs", async () => {
    const script = await readFile(
      path.join(repoRoot, "scripts", "tail-launch-agent-logs.sh"),
      "utf8",
    );

    expect(script).toContain("$HOME/Library/Logs/omnifocus-mcp-bridge");
    expect(script).toContain("out.log");
    expect(script).toContain("err.log");
    expect(script).toContain("tail -n 200 -f");
  });

  test("launch agent template uses the local service shape", async () => {
    const template = await readFile(
      path.join(repoRoot, "launchd", "local.omnifocus-mcp-bridge.plist.template"),
      "utf8",
    );

    expect(template).toContain("<string>__LABEL__</string>");
    expect(template).toContain("<string>__WORKING_DIRECTORY__</string>");
    expect(template).toContain("<key>OMNIFOCUS_MCP_BRIDGE_ROOT</key>");
    expect(template).toContain("<string>__REPO_ROOT__</string>");
    expect(template).toContain("<string>__LAUNCHER__</string>");
    expect(template).not.toContain("<string>__PNPM__</string>");
    expect(template).not.toContain("<string>start:tailscale</string>");
    expect(template).toContain("<key>RunAtLoad</key>");
    expect(template).toContain("<key>KeepAlive</key>");
  });

  test("launch agent installer renders and manages a user LaunchAgent", async () => {
    const script = await readFile(
      path.join(repoRoot, "scripts", "install-launch-agent.sh"),
      "utf8",
    );

    expect(script).toContain('LABEL="local.omnifocus-mcp-bridge"');
    expect(script).toContain(
      'SERVICE_DIR="$HOME/Library/Application Support/omnifocus-mcp-bridge"',
    );
    expect(script).toContain('SOURCE_LAUNCHER_PATH="$ROOT_DIR/scripts/omnifocus-mcp-bridge.sh"');
    expect(script).toContain('LAUNCHER_PATH="$SERVICE_DIR/omnifocus-mcp-bridge.sh"');
    expect(script).toContain('cp "$SOURCE_LAUNCHER_PATH" "$LAUNCHER_PATH"');
    expect(script).toContain("$HOME/Library/LaunchAgents/$LABEL.plist");
    expect(script).toContain("wait_for_service_removal");
    expect(script).toContain('launchctl print "$GUI_DOMAIN/$LABEL"');
    expect(script).toContain("bootstrap_launch_agent");
    expect(script).toContain('launchctl bootstrap "$GUI_DOMAIN" "$PLIST"');
    expect(script).toContain("launchctl bootstrap");
    expect(script).toContain("launchctl kickstart -k");
  });
});
