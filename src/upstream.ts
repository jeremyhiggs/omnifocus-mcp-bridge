import { createRequire } from "node:module";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const require = createRequire(import.meta.url);

type PackageJson = {
  name?: string;
  bin?: string | Record<string, string>;
};

export type ResolvedUpstream = {
  command: string;
  args: string[];
  binPath: string;
};

export type UpstreamConnection = {
  client: Client;
  transport: StdioClientTransport;
  onClose: (listener: () => void) => void;
  close: () => Promise<void>;
};

export function resolveDefaultUpstream(): ResolvedUpstream {
  const packageJsonPath = require.resolve("omnifocus-mcp-enhanced/package.json");
  const packageJson = require(packageJsonPath) as PackageJson;
  const packageDir = path.dirname(packageJsonPath);
  const binRelative = resolveBinRelativePath(packageJson);
  const binPath = path.resolve(packageDir, binRelative);

  return {
    command: process.execPath,
    args: [binPath],
    binPath,
  };
}

export async function connectUpstream(
  command: string,
  args: string[],
): Promise<UpstreamConnection> {
  const transport = new StdioClientTransport({
    command,
    args,
    stderr: "ignore",
  });
  const client = new Client(
    {
      name: "omnifocus-mcp-bridge-upstream-client",
      version: "0.1.0",
    },
    {
      capabilities: {},
    },
  );

  await client.connect(transport);

  return {
    client,
    transport,
    onClose: (listener: () => void) => {
      transport.onclose = listener;
    },
    close: async () => {
      await client.close();
    },
  };
}

function resolveBinRelativePath(packageJson: PackageJson): string {
  if (typeof packageJson.bin === "string") {
    return packageJson.bin;
  }

  const packageName = packageJson.name ?? "omnifocus-mcp-enhanced";
  const packageBin = packageJson.bin?.[packageName] ?? packageJson.bin?.["omnifocus-mcp-enhanced"];
  if (!packageBin) {
    throw new Error("omnifocus-mcp-enhanced does not declare an omnifocus-mcp-enhanced bin.");
  }

  return packageBin;
}
