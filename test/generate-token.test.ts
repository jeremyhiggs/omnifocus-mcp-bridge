import { chmod, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import { DEFAULT_TOKEN_FILE } from "../src/config.js";
import { generateToken, parseArgs } from "../src/generate-token.js";

describe("token generation", () => {
  test("writes a private token to the default server token file", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "omnifocus-token-"));

    const result = generateToken({ cwd: tempDir });
    const tokenFilePath = path.join(tempDir, DEFAULT_TOKEN_FILE);
    const token = await readFile(tokenFilePath, "utf8");
    const tokenStat = await stat(tokenFilePath);
    const tokenDirStat = await stat(path.dirname(tokenFilePath));

    expect(result.tokenFilePath).toBe(tokenFilePath);
    expect(result.overwritten).toBe(false);
    expect(token.trim()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tokenStat.mode & 0o077).toBe(0);
    expect(tokenDirStat.mode & 0o077).toBe(0);
  });

  test("refuses to overwrite an existing token without force", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "omnifocus-token-"));
    generateToken({ cwd: tempDir });

    expect(() => generateToken({ cwd: tempDir })).toThrow(/already exists/);
  });

  test("rotates an existing token when force is enabled", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "omnifocus-token-"));
    generateToken({ cwd: tempDir });
    const firstToken = await readFile(path.join(tempDir, DEFAULT_TOKEN_FILE), "utf8");

    const result = generateToken({ cwd: tempDir, force: true });
    const secondToken = await readFile(path.join(tempDir, DEFAULT_TOKEN_FILE), "utf8");

    expect(result.overwritten).toBe(true);
    expect(secondToken).not.toBe(firstToken);
  });

  test("tightens permissions when rotating an existing token", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "omnifocus-token-"));
    const tokenFilePath = path.join(tempDir, DEFAULT_TOKEN_FILE);
    await mkdir(path.dirname(tokenFilePath), { recursive: true });
    generateToken({ cwd: tempDir });
    await chmod(path.dirname(tokenFilePath), 0o755);
    await chmod(tokenFilePath, 0o644);

    generateToken({ cwd: tempDir, force: true });
    const tokenDirStat = await stat(path.dirname(tokenFilePath));
    const tokenStat = await stat(tokenFilePath);

    expect(tokenDirStat.mode & 0o077).toBe(0);
    expect(tokenStat.mode & 0o077).toBe(0);
  });

  test("refuses to follow a symbolic link during forced rotation", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "omnifocus-token-"));
    const tokenFilePath = path.join(tempDir, DEFAULT_TOKEN_FILE);
    const targetPath = path.join(tempDir, "unrelated-file");
    await mkdir(path.dirname(tokenFilePath), { recursive: true });
    await writeFile(targetPath, "do not replace\n");
    await symlink(targetPath, tokenFilePath);

    expect(() => generateToken({ cwd: tempDir, force: true })).toThrow(/symbolic link/);
    await expect(readFile(targetPath, "utf8")).resolves.toBe("do not replace\n");
  });

  test("parses the optional force flag", () => {
    expect(parseArgs([])).toEqual({});
    expect(parseArgs(["--force"])).toEqual({ force: true });
    expect(() => parseArgs(["--unknown"])).toThrow(/Usage:/);
  });
});
