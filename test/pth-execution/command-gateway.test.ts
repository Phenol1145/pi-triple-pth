import { describe, expect, it } from "vitest";
import { CommandGatewayImpl } from "../../src/pth/execution/command-gateway.js";
import type { ExecutionTargetRegistry, NotebookLanguage } from "@away_from/pth-contracts";

function fakeRegistry(): ExecutionTargetRegistry {
  const targets = new Map<string, import("@away_from/pth-contracts").ExecutionTargetDefinition>([
    ["engine-ts", {
      id: "engine-ts",
      kind: "engine-internal",
      profile: "engine",
      languages: ["ts"],
      modes: { sync: true, stream: false, interactive: false, persistent: false },
      session: { type: "one-shot" },
      capabilities: { richMedia: false, streaming: false, cancel: true, pathMapping: false },
      routing: { defaultFor: ["ts"], userSelectable: false, requiresApproval: false },
      binding: { type: "engine-internal", interpreter: "ts" },
    }],
    ["local-lean", {
      id: "local-lean",
      kind: "command",
      profile: "host",
      languages: ["bash"],
      modes: { sync: true, stream: false, interactive: false, persistent: false },
      session: { type: "one-shot" },
      capabilities: { richMedia: false, streaming: false, cancel: false, pathMapping: true },
      routing: { defaultFor: ["bash"], userSelectable: true, requiresApproval: true },
      binding: { type: "execution-backend", backendId: "local-lean", mode: "sync" },
    }],
  ]);
  return {
    get: (id) => targets.get(id),
    list: () => targets,
    resolve: (language: NotebookLanguage, target?: string | null) => {
      if (target) {
        const t = targets.get(target);
        if (!t) throw new Error(`ExecutionTarget 不存在: ${target}`);
        return t;
      }
      const t = [...targets.values()].find((x) => x.routing.defaultFor.includes(language));
      if (!t) throw new Error(`没有 language ${language} 的默认 ExecutionTarget`);
      return t;
    },
  };
}

const ctx = {
  principalId: "worker:developer",
  tenantId: "tenant-a",
  roleId: "developer",
  taskId: "task-1",
};

describe("CommandGateway", () => {
  it("agent-tool：语言命令解析 target 并 execute", async () => {
    const gw = new CommandGatewayImpl({
      targetRegistry: fakeRegistry(),
      roleCapabilities: () => ["python", "bash"],
    });
    const d = await gw.decide({
      surface: "agent-tool",
      toolCall: { tool: "ts.run", args: { code: "1+1" } },
      ctx,
    });
    expect(d.kind).toBe("execute");
    if (d.kind === "execute") {
      expect(d.command.target).toBe("engine-ts");
      expect(d.command.kind).toBe("language");
    }
  });

  it("agent-tool：EXEC_TOOL_CAP 拒绝（python 无 capability）", async () => {
    const gw = new CommandGatewayImpl({
      targetRegistry: fakeRegistry(),
      roleCapabilities: () => [],
    });
    const d = await gw.decide({
      surface: "agent-tool",
      toolCall: { tool: "python.run", args: { code: "print(1)" } },
      ctx,
    });
    expect(d.kind).toBe("deny");
    if (d.kind === "deny") expect(d.reason).toContain("python");
  });

  it("agent-tool：requiresApproval → await-approval", async () => {
    let requested = "";
    const gw = new CommandGatewayImpl({
      targetRegistry: fakeRegistry(),
      roleCapabilities: () => ["python", "bash"],
      humanApprovalGateway: {
        requestApproval: async ({ command }) => {
          requested = command.tool;
          return { requestId: "req-1" };
        },
        verifyApproval: async () => ({ ok: true }),
      },
    });
    const d = await gw.decide({
      surface: "agent-tool",
      toolCall: { tool: "bash.run", args: { command: "echo hi" }, },
      ctx,
    });
    expect(d.kind).toBe("await-approval");
    if (d.kind === "await-approval") {
      expect(d.requestId).toBe("req-1");
      expect(d.command.target).toBe("local-lean");
      expect(requested).toBe("bash.run");
    }
  });

  it("notebook：人类选择即批准 execute", async () => {
    const gw = new CommandGatewayImpl({ targetRegistry: fakeRegistry() });
    const d = await gw.decide({
      surface: "notebook",
      cell: { language: "ts", code: "1+1" },
      ctx,
    });
    expect(d.kind).toBe("execute");
    if (d.kind === "execute") {
      expect(d.command.security.approval?.decision).toBe("approved");
      expect(d.command.target).toBe("engine-ts");
    }
  });

  it("internal：能力策略表拒绝（dev.write 无写能力）", async () => {
    const gw = new CommandGatewayImpl({
      roleCapabilities: () => [],
    });
    const d = await gw.decide({
      surface: "agent-tool",
      toolCall: { tool: "dev.write", args: { path: "a.c", code: "int main(){}" } },
      ctx,
    });
    expect(d.kind).toBe("deny");
    if (d.kind === "deny") expect(d.reason).toContain("dev.write");
  });

  it("internal：obs.query 免批准且具备 obs 能力 → execute", async () => {
    const gw = new CommandGatewayImpl({
      roleCapabilities: () => ["obs"],
    });
    const d = await gw.decide({
      surface: "agent-tool",
      toolCall: { tool: "obs.query", args: { sql: "select 1" } },
      ctx,
    });
    expect(d.kind).toBe("execute");
    if (d.kind === "execute") expect(d.command.kind).toBe("internal");
  });
});
