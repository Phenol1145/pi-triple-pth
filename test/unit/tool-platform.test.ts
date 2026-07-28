import { describe, it, expect, vi } from "vitest";
import { ToolPlatform } from "../../src/pth/tools/platform.js";
import { ToolRegistry } from "../../src/pth/tools/registry.js";

function mockDeps() {
  const registry = new ToolRegistry();
  return {
    registry,
    audit: { write: vi.fn(), queryToolCall: vi.fn().mockResolvedValue(undefined), querySelfModify: vi.fn() } as any,
    metrics: { toolCallsTotal: { inc: vi.fn() } } as any,
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } as any,
  };
}

describe("ToolPlatform", () => {
  it("getAllowedTools returns default allowlist", () => {
    const deps = mockDeps();
    const platform = new ToolPlatform(deps.registry, deps.audit, deps.metrics, deps.logger);
    const tools = platform.getAllowedTools("tenant-a");
    expect(tools).toContain("read");
    expect(tools).toContain("bash");
    expect(tools).toContain("edit");
    expect(tools).toContain("write");
  });

  it("recordToolStart writes audit entry", () => {
    const deps = mockDeps();
    const platform = new ToolPlatform(deps.registry, deps.audit, deps.metrics, deps.logger);
    platform.recordToolStart("tenant-a", "read", "call-1");
    expect(deps.audit.queryToolCall).toHaveBeenCalledWith("tenant-a", "read", "start");
    expect(deps.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "tenant-a", tool: "read", toolCallId: "call-1", event: "tool_execution_start" })
    );
  });

  it("recordToolEnd increments metrics and writes audit", () => {
    const deps = mockDeps();
    const platform = new ToolPlatform(deps.registry, deps.audit, deps.metrics, deps.logger);
    platform.recordToolEnd("tenant-b", "bash", "call-2", 150, false);
    expect(deps.metrics.toolCallsTotal.inc).toHaveBeenCalledWith({ tool: "bash", tenant: "tenant-b" });
    expect(deps.audit.queryToolCall).toHaveBeenCalledWith("tenant-b", "bash", "success");
  });

  it("recordToolEnd audits errors as 'error'", () => {
    const deps = mockDeps();
    const platform = new ToolPlatform(deps.registry, deps.audit, deps.metrics, deps.logger);
    platform.recordToolEnd("tenant-c", "write", "call-3", 50, true);
    expect(deps.metrics.toolCallsTotal.inc).toHaveBeenCalledWith({ tool: "write", tenant: "tenant-c" });
    expect(deps.audit.queryToolCall).toHaveBeenCalledWith("tenant-c", "write", "error");
  });

  it("governExecution allows registered tools", async () => {
    const deps = mockDeps();
    const platform = new ToolPlatform(deps.registry, deps.audit, deps.metrics, deps.logger);

    const result = await platform.governExecution(
      { tenantId: "t1", invocationContextId: "ctx", toolCallId: "c1", name: "read", arguments: {} },
      async () => ({ toolCallId: "c1", output: "ok", content: [{ type: "text", text: "ok" }], isError: false, durationMs: 10 }),
    );
    expect(result.isError).toBe(false);
    expect(deps.audit.queryToolCall).toHaveBeenCalledWith("t1", "read", "success");
    expect(deps.metrics.toolCallsTotal.inc).toHaveBeenCalledWith({ tool: "read", tenant: "t1" });
  });

  it("governExecution denies unregistered tools", async () => {
    const deps = mockDeps();
    deps.registry.setTenantAllowlist("t2", ["read"]);
    const platform = new ToolPlatform(deps.registry, deps.audit, deps.metrics, deps.logger);

    const execFn = vi.fn();
    const result = await platform.governExecution(
      { tenantId: "t2", invocationContextId: "ctx", toolCallId: "c2", name: "sudo", arguments: {} },
      execFn as any,
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("not allowed");
    expect(execFn).not.toHaveBeenCalled();
    expect(deps.audit.queryToolCall).toHaveBeenCalledWith("t2", "sudo", "denied");
  });
});
