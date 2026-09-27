#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { DEFAULT_TOKEN_FILE, loadConfig } from "./config.js";

export type GenerateTokenOptions = {
  homeDir?: string;
  force?: boolean;
};

export type GenerateTokenResult = {
  tokenFilePath: string;
  overwritten: boolean;
};

export function generateToken(options: GenerateTokenOptions = {}): GenerateTokenResult {
  const tokenFilePath = path.resolve(options.homeDir ?? homedir(), DEFAULT_TOKEN_FILE);
  const tokenDir = path.dirname(tokenFilePath);
  const token = `${randomBytes(32).toString("base64url")}\n`;
  const tokenStat = lstatSync(tokenFilePath, { throwIfNoEntry: false });
  const exists = tokenStat !== undefined;

  if (exists) {
    if (
      tokenStat.isSymbolicLink() ||
      !tokenStat.isFile() ||
      (process.getuid && tokenStat.uid !== process.getuid())
    ) {
      throw new Error(`${DEFAULT_TOKEN_FILE} must be a regular file and not a symbolic link.`);
    }
  }

  if (exists && !options.force) {
    throw new Error(
      `${DEFAULT_TOKEN_FILE} already exists. Use pnpm token:generate -- --force to rotate it.`,
    );
  }

  mkdirSync(tokenDir, {
    recursive: true,
    mode: 0o700,
  });
  const directory = lstatSync(tokenDir);
  if (!directory.isDirectory() || (process.getuid && directory.uid !== process.getuid())) {
    throw new Error("Token directory must be owned by the current user and not a symbolic link.");
  }
  chmodSync(tokenDir, 0o700);

  const temporaryPath = `${tokenFilePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(temporaryPath, "wx", 0o600);
  try {
    writeFileSync(fd, token);
  } finally {
    closeSync(fd);
  }

  try {
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, tokenFilePath);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The rename may already have consumed the temporary file.
    }
    throw error;
  }

  return {
    tokenFilePath,
    overwritten: exists,
  };
}

export function parseArgs(args: string[]): GenerateTokenOptions {
  if (args.length === 0) {
    return {};
  }

  if (args.length === 1 && args[0] === "--force") {
    return {
      force: true,
    };
  }

  throw new Error("Usage: pnpm token:generate [-- --force]");
}

export function run(args: string[] = process.argv.slice(2)): void {
  if (args.length === 1 && args[0] === "--check") {
    loadConfig();
    console.error("MCP bearer token configuration and permissions validated.");
    return;
  }
  const result = generateToken(parseArgs(args));
  const action = result.overwritten ? "Rotated" : "Generated";
  console.error(`${action} MCP bearer token at ${result.tokenFilePath}`);
  console.error("Keep this file private; the token value was not printed.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    run();
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
