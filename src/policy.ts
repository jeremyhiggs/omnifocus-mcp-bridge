import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export const READ_ONLY_TOOL_NAMES = new Set([
  "dump_database",
  "get_task_by_id",
  "read_task_attachment",
  "get_tasks",
  "filter_tasks",
  "get_projects",
  "manage_perspectives",
  "count_tasks",
]);

export type ToolPolicy = {
  readOnly: boolean;
};

export function canExposeTool(toolName: string, policy: ToolPolicy): boolean {
  if (!policy.readOnly) {
    return true;
  }

  return READ_ONLY_TOOL_NAMES.has(toolName);
}

export function canCallTool(
  toolName: string,
  args: Record<string, unknown> | undefined,
  policy: ToolPolicy,
): boolean {
  if (!canExposeTool(toolName, policy)) {
    return false;
  }

  if (!policy.readOnly || toolName !== "manage_perspectives") {
    return true;
  }

  return args?.action === "list" || args?.action === "get";
}

export function filterToolsForPolicy(tools: Tool[], policy: ToolPolicy): Tool[] {
  return tools.flatMap((tool) => {
    if (!canExposeTool(tool.name, policy)) {
      return [];
    }

    if (policy.readOnly && tool.name === "manage_perspectives") {
      return [asReadOnlyPerspectiveTool(tool)];
    }

    return [tool];
  });
}

function asReadOnlyPerspectiveTool(tool: Tool): Tool {
  const {
    newName: _newName,
    rules: _rules,
    iconColor: _iconColor,
    dryRun: _dryRun,
    ...readOnlyProperties
  } = tool.inputSchema.properties ?? {};
  const actionSchema = readOnlyProperties.action ?? {};

  return {
    ...tool,
    description:
      "List custom perspectives or inspect one perspective and its filter rules. Read-only: updates are not available through this bridge.",
    inputSchema: {
      ...tool.inputSchema,
      properties: {
        ...readOnlyProperties,
        action: {
          ...actionSchema,
          enum: ["list", "get"],
          description:
            "list: every custom perspective. get: one perspective with its rules explained.",
        },
      },
    },
    annotations: {
      ...tool.annotations,
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
  };
}
