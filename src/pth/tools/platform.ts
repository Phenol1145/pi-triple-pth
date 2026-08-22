import type { ToolRegistry } from "./registry.js";
import type { AuditWriter } from "../observability/index.js";
import type { Metrics } from "../observability/index.js";
import type { Logger } from "@away_from/infra";
import type { ToolCallRequest, ToolResult } from "./types.js";

export class ToolPlatform {
  constructor(
    private registry: ToolRegistry,
    private audit: AuditWriter,
    private metrics: Metrics,
    private logger: Logger,
  ) {}

  getAllowedTools(tenantId: string): string[] {
    return this.registry.getAllowedTools(tenantId);
  }

  /**
   * Get effective tools for a program run: program.tools ∩ tenant allowed tools.
   * Returns tenant-allowed tools when program defines none (full allowlist).
   */
  getEffectiveTools(tenantId: string, programTools?: string[]): string[] {
    const tenantAllowed = this.registry.getAllowedTools(tenantId);
    if (!programTools || programTools.length === 0) return tenantAllowed;
    return programTools.filter((t) => tenantAllowed.includes(t));
  }

  /** Return SDK-level ToolDefinition[] for createAgentSession({ customTools }) */
  getSdkToolDefinitions(tenantId: string): any[] {
    return this.registry.getSdkToolDefinitions(tenantId);
  }

  /** C8: Record tool execution start — audit + logger */
  recordToolStart(tenantId: string, toolName: string, toolCallId: string): void {
    this.logger.info({
      tenantId,
      tool: toolName,
      toolCallId,
      event: "tool_execution_start",
    });
    // Fire-and-forget audit write (non-blocking)
    this.audit.queryToolCall(tenantId, toolName, "start").catch(() => {});
  }

  /** C8: Record tool execution end — audit + metrics */
  recordToolEnd(tenantId: string, toolName: string, toolCallId: string, durationMs: number, isError: boolean): void {
    this.logger.info({
      tenantId,
      tool: toolName,
      toolCallId,
      durationMs,
      isError,
      event: "tool_execution_end",
    });
    this.metrics.toolCallsTotal.inc({ tool: toolName, tenant: tenantId });
    this.audit.queryToolCall(tenantId, toolName, isError ? "error" : "success").catch(() => {});
  }

  async governExecution(
    request: ToolCallRequest,
    executeFn: () => Promise<ToolResult>,
  ): Promise<ToolResult> {
    const allowed = this.registry.getAllowedTools(request.tenantId);
    if (!allowed.includes(request.name)) {
      const denied: ToolResult = {
        toolCallId: request.toolCallId,
        output: `Tool "${request.name}" not allowed for tenant`,
        content: [{ type: "text", text: `Tool "${request.name}" not allowed` }],
        isError: true,
        durationMs: 0,
      };
      await this.audit.queryToolCall(request.tenantId, request.name, "denied");
      return denied;
    }

    const start = Date.now();
    this.logger.info({
      tenantId: request.tenantId,
      tool: request.name,
      toolCallId: request.toolCallId,
      event: "tool_call_start",
    });

    try {
      const result = await executeFn();
      const durationMs = Date.now() - start;
      this.metrics.toolCallsTotal.inc({ tool: request.name, tenant: request.tenantId });
      await this.audit.queryToolCall(request.tenantId, request.name, result.isError ? "error" : "success");
      return { ...result, durationMs };
    } catch (err) {
      const durationMs = Date.now() - start;
      await this.audit.queryToolCall(request.tenantId, request.name, "exception");
      return {
        toolCallId: request.toolCallId,
        output: String(err),
        content: [{ type: "text", text: String(err) }],
        isError: true,
        durationMs,
      };
    }
  }
}
