import { readFileSync } from "node:fs";

const metadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

export const BRIDGE_VERSION: string = metadata.buildId
  ? `${metadata.version}+${metadata.buildId}`
  : metadata.version;
