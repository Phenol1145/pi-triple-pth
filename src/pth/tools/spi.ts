import type { ToolCallRequest, ToolResult, ToolEvent } from "./types.js";

export interface ToolExecutor {
  readonly type: string;
  execute(request: ToolCallRequest): AsyncIterable<ToolEvent>;
  cancel(toolCallId: string): Promise<void>;
}
