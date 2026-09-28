import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import { URL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  SetLevelRequestSchema,
  type ServerCapabilities,
} from "@modelcontextprotocol/sdk/types.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { isBearerAuthorized, writeUnauthorized } from "./auth.js";
import type { BridgeConfig } from "./config.js";
import { canCallTool, filterToolsForPolicy } from "./policy.js";
import type { UpstreamConnection } from "./upstream.js";
import { BRIDGE_VERSION } from "./version.js";

export type BridgeRuntime = {
  httpServer: HttpServer;
  url: URL;
  close: () => Promise<void>;
};

export async function startBridge(
  config: BridgeConfig,
  upstream: UpstreamConnection,
): Promise<BridgeRuntime> {
  const httpServer = createServer(async (req, res) => {
    const requestLog = startRequestLog(config, req, res);
    if (!isBearerAuthorized(req, config.token)) {
      requestLog.authorized = false;
      writeUnauthorized(res);
      return;
    }
    requestLog.authorized = true;

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? config.host}`);
    requestLog.path = url.pathname;
    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }

    try {
      const facade = createFacadeServer(upstream.client, {
        readOnly: config.readOnly,
      });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      await facade.connect(transport);
      try {
        await transport.handleRequest(req, res);
      } finally {
        await transport.close().catch(() => undefined);
        await facade.close().catch(() => undefined);
      }
    } catch (error) {
      requestLog.error = error instanceof Error ? error.message : String(error);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: ErrorCode.InternalError,
              message: "Internal server error",
            },
            id: null,
          }),
        );
      }
      console.error(error instanceof Error ? error.message : String(error));
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      httpServer.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      httpServer.off("error", onError);
      resolve();
    };

    httpServer.once("error", onError);
    httpServer.once("listening", onListening);
    httpServer.listen(config.port, config.host);
  });

  const address = httpServer.address();
  if (address === null || typeof address === "string") {
    throw new Error("HTTP server did not expose a TCP address.");
  }

  const url = new URL(`http://${address.address}:${address.port}/mcp`);

  return {
    httpServer,
    url,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
      await upstream.close();
    },
  };
}

type RequestLogState = {
  authorized: boolean | undefined;
  error: string | undefined;
  path: string;
};

function startRequestLog(
  config: BridgeConfig,
  req: IncomingMessage,
  res: ServerResponse,
): RequestLogState {
  const state: RequestLogState = {
    authorized: undefined,
    error: undefined,
    path: req.url ?? "/",
  };

  if (!config.verbose) {
    return state;
  }

  const startedAt = process.hrtime.bigint();
  const requestId = randomUUID();
  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const fields = {
      requestId,
      method: req.method ?? "UNKNOWN",
      path: state.path,
      statusCode: res.statusCode,
      durationMs: Math.round(durationMs * 100) / 100,
      authorized: state.authorized,
      hasAuthorizationHeader: typeof req.headers.authorization === "string",
      remoteAddress: req.socket.remoteAddress,
      forwardedFor: req.headers["x-forwarded-for"],
      userAgent: req.headers["user-agent"],
      contentType: req.headers["content-type"],
      accept: req.headers.accept,
      error: state.error,
    };

    console.error(`[request] ${JSON.stringify(fields)}`);
  });

  return state;
}

function createFacadeServer(upstream: Client, policy: { readOnly: boolean }): Server {
  const capabilities = upstream.getServerCapabilities() ?? {};
  const server = new Server(
    {
      name: "omnifocus-mcp-bridge",
      version: BRIDGE_VERSION,
    },
    {
      capabilities: capabilities as ServerCapabilities,
      instructions: policy.readOnly
        ? "Remote OmniFocus bridge is running in read-only mode. Mutating tools are not exposed."
        : "Remote OmniFocus bridge is running with mutating tools enabled.",
    },
  );

  if (capabilities.tools) {
    server.setRequestHandler(ListToolsRequestSchema, async (request) => {
      const result = await upstream.listTools(request.params);
      return {
        ...result,
        tools: filterToolsForPolicy(result.tools, policy),
      };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (!canCallTool(request.params.name, request.params.arguments, policy)) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          `Tool "${request.params.name}" is not available while OMNIFOCUS_MCP_READ_ONLY is enabled.`,
        );
      }

      return upstream.callTool(request.params, CallToolResultSchema);
    });
  }

  if (capabilities.resources) {
    server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
      return upstream.listResources(request.params);
    });

    server.setRequestHandler(ListResourceTemplatesRequestSchema, async (request) => {
      return upstream.listResourceTemplates(request.params);
    });

    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      return upstream.readResource(request.params);
    });
  }

  if (capabilities.prompts) {
    server.setRequestHandler(ListPromptsRequestSchema, async (request) => {
      return upstream.listPrompts(request.params);
    });

    server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      return upstream.getPrompt(request.params);
    });
  }

  if (capabilities.logging) {
    server.setRequestHandler(SetLevelRequestSchema, async (request) => {
      return upstream.setLoggingLevel(request.params.level);
    });
  }

  return server;
}
