import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.resolve(process.argv[2] ?? path.join(root, "release", "omnifocus-mcp-bridge"));
const require = createRequire(import.meta.url);
const upstreamRoot = path.dirname(require.resolve("omnifocus-mcp-enhanced/package.json"));
const metadata = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const options = {
  absWorkingDir: root,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  minify: true,
  metafile: true,
  legalComments: "eof",
  // Bundled CommonJS dependencies still require Node builtins from ESM.
  banner: {
    js: 'import { createRequire as __bundleCreateRequire } from "node:module"; const require = __bundleCreateRequire(import.meta.url);',
  },
};

await mkdir(output, { recursive: true });
// Keep local .env, but replace every generated directory before archiving it.
for (const directory of ["dist", "upstream", "scripts", "launchd"]) {
  await rm(path.join(output, directory), { recursive: true, force: true });
}
const bridge = await build({
  ...options,
  entryPoints: ["src/index.ts", "src/tailscale-start.ts", "src/generate-token.ts"],
  outdir: path.join(output, "dist"),
});
const upstream = await build({
  ...options,
  entryPoints: [path.join(upstreamRoot, "dist", "server.js")],
  outfile: path.join(output, "upstream", "dist", "server.js"),
});

// Upstream reads scripts and version metadata relative to import.meta.url.
await cp(
  path.join(upstreamRoot, "dist", "utils", "omnifocusScripts"),
  path.join(output, "upstream", "utils", "omnifocusScripts"),
  { recursive: true },
);
await cp(path.join(upstreamRoot, "package.json"), path.join(output, "upstream", "package.json"));
await cp(path.join(root, "launchd"), path.join(output, "launchd"), { recursive: true });
await mkdir(path.join(output, "scripts"), { recursive: true });
for (const name of await readdir(path.join(root, "scripts"))) {
  if (!name.endsWith(".sh")) continue;
  const script = await readFile(path.join(root, "scripts", name), "utf8");
  await writeFile(
    path.join(output, "scripts", name),
    script.replace(/^pnpm(?: --dir "\$ROOT_DIR")? run build\n\n/gm, ""),
    { mode: 0o755 },
  );
}
await cp(path.join(root, ".env.example"), path.join(output, ".env.example"));
await cp(path.join(root, "README.md"), path.join(output, "README.md"));

// Preserve the full license notices of packages included in either bundle.
const packages = new Set();
for (const input of [
  ...Object.keys(bridge.metafile.inputs),
  ...Object.keys(upstream.metafile.inputs),
]) {
  if (!input.includes("node_modules/")) continue;
  let directory = path.dirname(path.resolve(root, input));
  while (directory !== path.dirname(directory)) {
    try {
      const pkg = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
      if (pkg.name) {
        packages.add(directory);
        break;
      }
    } catch {
      /* Not a package root. */
    }
    directory = path.dirname(directory);
  }
}
const notices = [];
for (const directory of [...packages].sort()) {
  const pkg = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
  const licenses = (await readdir(directory)).filter((name) =>
    /^(licen[cs]e|copying|notice)([._-]|$)/i.test(name),
  );
  notices.push(`${pkg.name}@${pkg.version} (${pkg.license ?? "see notices"})`);
  for (const name of licenses) notices.push(await readFile(path.join(directory, name), "utf8"));
}
await writeFile(path.join(output, "THIRD_PARTY_NOTICES.txt"), notices.join("\n\n"));
const hash = createHash("sha256").update(metadata.version);
for (const file of [
  "dist/index.js",
  "dist/tailscale-start.js",
  "dist/generate-token.js",
  "upstream/dist/server.js",
]) {
  hash.update(await readFile(path.join(output, file)));
}
for (const directory of ["scripts", "launchd"]) {
  for (const name of (await readdir(path.join(output, directory))).sort()) {
    hash.update(`${directory}/${name}`).update(await readFile(path.join(output, directory, name)));
  }
}
await writeFile(
  path.join(output, "package.json"),
  `${JSON.stringify(
    {
      name: metadata.name,
      version: metadata.version,
      buildId: hash.digest("hex").slice(0, 12),
      private: true,
      type: "module",
      engines: metadata.engines,
    },
    null,
    2,
  )}\n`,
);
const archive = `${output}.tar.gz`;
execFileSync("tar", [
  "-czf",
  archive,
  "-C",
  path.dirname(output),
  ...[
    "dist",
    "upstream",
    "scripts",
    "launchd",
    "README.md",
    ".env.example",
    "package.json",
    "THIRD_PARTY_NOTICES.txt",
  ].map((name) => `${path.basename(output)}/${name}`),
]);
console.log(
  `Release ready: ${path.relative(root, output)} and ${path.relative(root, archive)} (Node.js 24+; no node_modules or pnpm)`,
);
