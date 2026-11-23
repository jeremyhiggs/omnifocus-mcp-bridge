#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "fake-omnifocus-upstream", version: "0.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "dump_database",
      description: "Read fake OmniFocus data",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "get_tasks",
      description: "Read fake OmniFocus tasks",
      inputSchema: {
        type: "object",
        properties: {
          source: { type: "string", enum: ["custom"] },
          perspectiveName: { type: "string" },
        },
        required: ["source", "perspectiveName"],
      },
    },
    {
      name: "manage_perspectives",
      description: "List, inspect, and update perspectives",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "get", "update"] },
          id: { type: "string" },
          name: { type: "string" },
          newName: { type: "string" },
          rules: { type: "object" },
          iconColor: { type: "string" },
          dryRun: { type: "boolean" },
        },
        required: ["action"],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    {
      name: "add_omnifocus_task",
      description: "Mutate fake OmniFocus data",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  switch (params.name) {
    case "dump_database":
      return textResult("fake database");
    case "get_tasks": {
      const { source, perspectiveName } = params.arguments ?? {};
      if (source !== "custom" || perspectiveName !== "Fake perspective") {
        return {
          ...textResult('Expected source "custom" and perspectiveName "Fake perspective"'),
          isError: true,
        };
      }
      return {
        ...textResult("fake custom perspective task"),
        structuredContent: {
          source,
          count: 1,
          tasks: [{ id: "fake-task-id", name: "Fake task" }],
        },
      };
    }
    case "manage_perspectives":
      return textResult("fake perspectives");
    case "add_omnifocus_task":
      return textResult("created");
    default:
      throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${params.name}`);
  }
});

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

await server.connect(new StdioServerTransport());
