import { describe, expect, it } from "vitest";
import { UnifiedExecutionDispatcherImpl } from "../../src/pth/execution/unified-execution-dispatcher.js";
import { buildExecutionTargetRegistry } from "../../src/pth/execution/execution-target-registry.js";
import { buildExecutionBackendRegistry } from "../../src/pth/execution/backend-registry.js";
import type { ExecutionCommand } from "@away_from/pth-kernel-execution";

const MATRIX = JSON.stringify({
  version: 1,
  targets: [
    {
      id: "sandbox",
      kind: "kernel-pool",
      profile: "sandbox-untrusted",
      languages: ["python", "bash"],
      modes: { sync: true, stream: false, interactive: false, persistent: true },
      session: { type: "persistent-repl", scope: "notebook", ttlMs: 1800000 },
      capabilities: { richMedia: true, streaming: false, cancel: true, pathMapping: false },
      routing: { defaultFor: ["python", "bash"], userSelectable: false, requiresApproval: false },
      binding: { type: "execution-session", backendId: "sandbox" },
    },
    {
      id: "engine-ts",
      kind: "engine-internal",
      profile: "engine",
      languages: ["ts"],
      modes: { sync: true, stream: false, interactive: false, persistent: false },
      session: { type: "one-shot" },
      capabilities: { richMedia: false, streaming: false, cancel: true, pathMapping: false },
      routing: { defaultFor: ["ts"], userSelectable: false, requiresApproval: false },
      binding: { type: "engine-internal", interpreter: "ts" },
    },
  ],
});

function buildRegistry() {
  const backend = buildExecutionBackendRegistry({
    descriptorsJson: JSON.stringify([
      { id: "sandbox", url: "http://sandbox:8080", profile: "sandbox-untrusted" },
      { id: "local-lean", url: "http://host.docker.internal:8787", profile: "host" },
      { id: "tools-compiled", url: "http://host.docker.internal:32773", profile: "dev-container" },
    ]),
    env: { PTH_EXEC_SANDBOX_ALIAS: "off" },
    strict: false,
  }).registry;
  const { registry } = buildExecutionTargetRegistry({
    matrixJson: MATRIX,
    backendRegistry: backend,
    strict: false,
  });
  return { backend, registry };
}

const security = {
  principalId: "test",
  tenantId: "system",
  roleId: "developer",
  approval: { ref: "test", decision: "approved" as const },
};

function baseCommand(over: Partial<Extract<ExecutionCommand, { kind: "language" }>> = {}): ExecutionCommand {
  return {
    id: "cmd-1",
    tool: "ts.run",
    kind: "language",
    language: "ts",
    code: "1 + 1",
    scope: "task",
    security,
    ...over,
  } as ExecutionCommand;
}

describe("UnifiedExecutionDispatcher", () => {
  it("language ts → engine-ts 走 engineTsExecutor", async () => {
    const { registry } = buildRegistry();
    let seen: unknown;
    const dispatcher = new UnifiedExecutionDispatcherImpl({
      targetRegistry: registry,
      engineTsExecutor: async (req) => {
        seen = req;
        return { ok: true, value: 2, stdout: "2", durationMs: 1 };
      },
    });
    const r = await dispatcher.execute(baseCommand({ target: "engine-ts" }));
    expect(r.ok).toBe(true);
    expect(r.target).toBe("engine-ts");
    expect(r.value).toBe(2);
    expect(seen).toMatchObject({ code: "1 + 1" });
  });

  it("language python → sandbox 走 sessionExecutor", async () => {
    const { registry } = buildRegistry();
    let seen: unknown;
    const dispatcher = new UnifiedExecutionDispatcherImpl({
      targetRegistry: registry,
      sessionExecutor: async (req) => {
        seen = req;
        return { ok: true, value: 42, stdout: "42", durationMs: 1 };
      },
    });
    const r = await dispatcher.execute(baseCommand({ tool: "python.run", language: "python", code: "40+2", target: "sandbox" }));
    expect(r.ok).toBe(true);
    expect(r.target).toBe("sandbox");
    expect(r.value).toBe(42);
    expect(seen).toMatchObject({ language: "python", code: "40+2" });
  });

  it("language bash → local-lean 转成 bash -lc 走 commandExecutor", async () => {
    const { registry } = buildRegistry();
    let seen: { argv?: readonly string[] } | undefined;
    const dispatcher = new UnifiedExecutionDispatcherImpl({
      targetRegistry: registry,
      commandExecutor: async (_target, req) => {
        seen = req;
        return { ok: true, stdout: "ok", durationMs: 1 };
      },
    });
    const r = await dispatcher.execute(baseCommand({
      tool: "bash.run",
      language: "bash",
      code: "echo hi",
      target: "local-lean",
    }));
    expect(r.ok).toBe(true);
    expect(r.target).toBe("local-lean");
    expect(seen?.argv).toEqual(["bash", "-lc", "echo hi"]);
  });

  it("language bash → tool-container 拒绝（必须 external）", async () => {
    const { registry } = buildRegistry();
    const dispatcher = new UnifiedExecutionDispatcherImpl({
      targetRegistry: registry,
      commandExecutor: async () => ({ ok: true, stdout: "should not run", durationMs: 1 }),
    });
    const r = await dispatcher.execute(baseCommand({
      tool: "bash.run",
      language: "bash",
      code: "echo hi",
      target: "tools-compiled",
    }));
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain("tool-container");
  });

  it("external 命令 → tool-container 走 commandExecutor（argv 白名单）", async () => {
    const { registry } = buildRegistry();
    let seen: { argv?: readonly string[] } | undefined;
    const dispatcher = new UnifiedExecutionDispatcherImpl({
      targetRegistry: registry,
      commandExecutor: async (_target, req) => {
        seen = req;
        return { ok: true, stdout: "ok", durationMs: 1 };
      },
    });
    const r = await dispatcher.execute({
      id: "cmd-2",
      tool: "bf.run",
      kind: "external",
      argv: ["bf", "--help"],
      target: "tools-compiled",
      scope: "task",
      security,
    });
    expect(r.ok).toBe(true);
    expect(r.target).toBe("tools-compiled");
    expect(seen?.argv).toEqual(["bf", "--help"]);
  });

  it("requiresApproval 且无 approval → Execute 层拒绝（defense-in-depth）", async () => {
    const { registry } = buildRegistry();
    const dispatcher = new UnifiedExecutionDispatcherImpl({
      targetRegistry: registry,
      commandExecutor: async () => ({ ok: true, stdout: "should not run", durationMs: 1 }),
    });
    const r = await dispatcher.execute({
      id: "cmd-x",
      tool: "bash.run",
      kind: "language",
      language: "bash",
      code: "echo hi",
      target: "local-lean",
      scope: "task",
      security: { principalId: "test", tenantId: "system", roleId: "developer" },
    });
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain("需要批准");
  });

  it("internal 命令走 internalExecutor", async () => {
    const dispatcher = new UnifiedExecutionDispatcherImpl({
      internalExecutor: async (capability, args) => ({
        ok: true,
        value: { capability, args },
        durationMs: 1,
      }),
    });
    const r = await dispatcher.execute({
      id: "cmd-3",
      tool: "memory.query",
      kind: "internal",
      capability: "memory.query",
      args: { sql: "select 1" },
      scope: "task",
      security,
    });
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ capability: "memory.query", args: { sql: "select 1" } });
  });

  it("缺少执行器时返回结构化错误而不是抛异常", async () => {
    const { registry } = buildRegistry();
    const dispatcher = new UnifiedExecutionDispatcherImpl({ targetRegistry: registry });
    const r = await dispatcher.execute(baseCommand({ target: "engine-ts" }));
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain("engineTsExecutor");
  });
});
