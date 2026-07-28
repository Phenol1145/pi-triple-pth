export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  version: number;
  idempotent: boolean;
  requiresApproval?: boolean;
  executor: "local" | "container" | "remote" | "mcp";
}

export interface ToolCallRequest {
  tenantId: string;
  invocationContextId: string;
  toolCallId: string;
  name: string;
  arguments: Record<string, unknown>;
  executionContext?: {
    cwd?: string;
    env?: Record<string, string>;
  };
  timeout?: number;
}

export interface ToolResult {
  toolCallId: string;
  output: string;
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string }>;
  isError: boolean;
  timeout?: boolean;
  durationMs: number;
  details?: Record<string, unknown>;
}

export interface ToolEvent {
  type: "output_delta" | "result" | "error";
  data: string;
  result?: ToolResult;
}
