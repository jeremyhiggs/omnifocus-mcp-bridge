import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export function isBearerAuthorized(req: IncomingMessage, token: string): boolean {
  const value = req.headers.authorization;
  if (typeof value !== "string") {
    return false;
  }

  const prefix = "Bearer ";
  if (!value.startsWith(prefix)) {
    return false;
  }

  const supplied = value.slice(prefix.length);
  const expected = Buffer.from(token);
  const actual = Buffer.from(supplied);

  if (actual.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(actual, expected);
}

export function writeUnauthorized(res: ServerResponse): void {
  res.writeHead(401, {
    "content-type": "application/json",
    "www-authenticate": 'Bearer realm="omnifocus-mcp-bridge"',
  });
  res.end(
    JSON.stringify({
      error: "unauthorized",
    }),
  );
}
