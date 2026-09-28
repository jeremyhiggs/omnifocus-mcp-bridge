import { existsSync, readFileSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parse as parseDotenv } from "dotenv";
import { resolveDefaultUpstream } from "./upstream.js";

export const DEFAULT_TOKEN_FILE = ".config/omnifocus-mcp-bridge/token";

export function configDirectory(env: NodeJS.ProcessEnv, homeDir: string = homedir()): string {
  const configHome = env.XDG_CONFIG_HOME?.trim() || path.join(homeDir, ".config");
  if (!path.isAbsolute(configHome)) throw new Error("XDG_CONFIG_HOME must be an absolute path.");
  return path.join(configHome, "omnifocus-mcp-bridge");
}

export type BridgeConfig = {
  token: string;
  host: string;
  port: number;
  readOnly: boolean;
  upstreamCommand: string;
  upstreamArgs: string[];
  upstreamBinPath: string;
  verbose: boolean;
  tailscaleServe: boolean;
};

export type ConfigLoadOptions = {
  cwd?: string;
  homeDir?: string;
  verbose?: boolean;
};

type EnvSources = {
  env: NodeJS.ProcessEnv;
  tokenFileBaseDir: string;
  configDir: string;
};

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: ConfigLoadOptions = {},
): BridgeConfig {
  const cwd = options.cwd ?? process.cwd();
  const sources = loadEnvSources(env, cwd, options.homeDir ?? homedir());
  const effectiveEnv = sources.env;
  const token = resolveToken(effectiveEnv, sources.tokenFileBaseDir, sources.configDir);
  if (!token) {
    throw new Error(
      `OMNIFOCUS_MCP_TOKEN, OMNIFOCUS_MCP_TOKEN_FILE, or ${path.join(sources.configDir, "token")} is required; refusing to start without bearer auth.`,
    );
  }

  const resolvedUpstream = resolveDefaultUpstream();
  const upstreamCommand =
    effectiveEnv.OMNIFOCUS_MCP_UPSTREAM_COMMAND?.trim() || resolvedUpstream.command;
  const upstreamArgs =
    effectiveEnv.OMNIFOCUS_MCP_UPSTREAM_ARGS !== undefined
      ? parseArgsEnv(effectiveEnv.OMNIFOCUS_MCP_UPSTREAM_ARGS)
      : effectiveEnv.OMNIFOCUS_MCP_UPSTREAM_COMMAND !== undefined
        ? []
        : resolvedUpstream.args;

  return {
    token,
    host: effectiveEnv.OMNIFOCUS_MCP_HOST?.trim() || "127.0.0.1",
    port: parsePort(effectiveEnv.OMNIFOCUS_MCP_PORT),
    readOnly: parseReadOnly(effectiveEnv.OMNIFOCUS_MCP_READ_ONLY),
    upstreamCommand,
    upstreamArgs,
    upstreamBinPath: resolvedUpstream.binPath,
    verbose: options.verbose ?? parseBoolean(effectiveEnv.OMNIFOCUS_MCP_VERBOSE, false),
    tailscaleServe: parseBoolean(effectiveEnv.OMNIFOCUS_MCP_TAILSCALE_SERVE, false),
  };
}

export function loadEffectiveEnv(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): NodeJS.ProcessEnv {
  return loadEnvSources(env, cwd, homedir()).env;
}

function loadEnvSources(env: NodeJS.ProcessEnv, cwd: string, homeDir: string): EnvSources {
  const configDir = configDirectory(env, homeDir);
  if (lstatSync(configDir, { throwIfNoEntry: false })) assertPrivateDirectory(configDir);
  const configFile = path.join(configDir, "config.env");
  const configEnv = loadConfigFile(configDir, configFile);
  const configuredEnvFile = env.OMNIFOCUS_MCP_ENV_FILE?.trim();
  const envFile = configuredEnvFile || path.join(cwd, ".env");
  const fileEnv = loadEnvFile(envFile, configuredEnvFile !== undefined);

  return {
    env: {
      ...configEnv,
      ...fileEnv,
      ...env,
    },
    tokenFileBaseDir:
      env.OMNIFOCUS_MCP_TOKEN_FILE !== undefined || fileEnv.OMNIFOCUS_MCP_TOKEN_FILE !== undefined
        ? existsSync(envFile)
          ? path.dirname(path.resolve(envFile))
          : cwd
        : configDir,
    configDir,
  };
}

function loadConfigFile(configDir: string, filePath: string): Record<string, string> {
  const file = lstatSync(filePath, { throwIfNoEntry: false });
  if (!file) return {};
  assertPrivateDirectory(configDir);
  assertPrivateFile(filePath, "config.env");
  return parseDotenv(readFileSync(filePath));
}

function loadEnvFile(filePath: string, required: boolean): Record<string, string> {
  if (!existsSync(filePath)) {
    if (required) {
      throw new Error(`OMNIFOCUS_MCP_ENV_FILE does not exist: ${filePath}`);
    }
    return {};
  }

  return parseDotenv(readFileSync(filePath));
}

function resolveToken(
  env: NodeJS.ProcessEnv,
  tokenFileBaseDir: string,
  configDir: string,
): string | undefined {
  const directToken = env.OMNIFOCUS_MCP_TOKEN?.trim();
  if (directToken) {
    return directToken;
  }

  const tokenFile = env.OMNIFOCUS_MCP_TOKEN_FILE?.trim();
  if (!tokenFile) {
    const defaultTokenFilePath = path.join(configDir, "token");
    if (!lstatSync(defaultTokenFilePath, { throwIfNoEntry: false })) {
      return undefined;
    }

    assertPrivateDirectory(configDir);
    return readTokenFile(defaultTokenFilePath);
  }

  const tokenFilePath = path.isAbsolute(tokenFile)
    ? tokenFile
    : path.resolve(tokenFileBaseDir, tokenFile);
  return readTokenFile(tokenFilePath);
}

function readTokenFile(tokenFilePath: string): string | undefined {
  assertPrivateFile(tokenFilePath, "OMNIFOCUS_MCP_TOKEN_FILE");
  const token = readFileSync(tokenFilePath, "utf8").trim();
  return token.length > 0 ? token : undefined;
}

function assertPrivateDirectory(directoryPath: string): void {
  const stat = lstatSync(directoryPath);
  if (
    !stat.isDirectory() ||
    (stat.mode & 0o777) !== 0o700 ||
    (process.getuid && stat.uid !== process.getuid())
  ) {
    throw new Error(
      "Config directory must be owned by the current user, not a symbolic link, and have mode 0700.",
    );
  }
}

function assertPrivateFile(filePath: string, name: string): void {
  const stat = lstatSync(filePath);

  if (!stat.isFile()) {
    throw new Error(`${name} must be a regular file, not a symbolic link: ${filePath}`);
  }

  if (process.getuid && stat.uid !== process.getuid()) {
    throw new Error(`${name} must be owned by the current user.`);
  }

  if ((stat.mode & 0o777) !== 0o600) {
    throw new Error(`${name} must have mode 0600: ${filePath}`);
  }
}

export function parseReadOnly(value: string | undefined): boolean {
  return parseBoolean(value, true, "OMNIFOCUS_MCP_READ_ONLY");
}

function parseBoolean(
  value: string | undefined,
  defaultValue: boolean,
  name: string = "boolean value",
): boolean {
  if (value === undefined || value.trim() === "") {
    return defaultValue;
  }

  switch (value.trim().toLowerCase()) {
    case "0":
    case "false":
    case "no":
    case "off":
      return false;
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    default:
      throw new Error(`${name} must be true or false.`);
  }
}

export function parseArgsEnv(value: string | undefined): string[] {
  if (value === undefined || value.trim() === "") {
    return [];
  }

  const trimmed = value.trim();
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
      throw new Error("OMNIFOCUS_MCP_UPSTREAM_ARGS JSON must be an array of strings.");
    }
    return parsed;
  }

  return splitShellLike(trimmed);
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value.trim() === "") {
    return 3050;
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("OMNIFOCUS_MCP_PORT must be an integer between 0 and 65535.");
  }

  return port;
}

function splitShellLike(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaping = false;

  for (const char of input) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\") {
      escaping = true;
      continue;
    }

    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (escaping) {
    current += "\\";
  }

  if (quote !== undefined) {
    throw new Error("OMNIFOCUS_MCP_UPSTREAM_ARGS contains an unterminated quote.");
  }

  if (current.length > 0) {
    args.push(current);
  }

  return args;
}
