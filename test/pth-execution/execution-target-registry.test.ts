import { describe, expect, it } from "vitest";
import {
  buildExecutionTargetRegistry,
} from "../../src/pth/execution/execution-target-registry.js";
import {
  buildExecutionBackendRegistry,
} from "../../src/pth/execution/backend-registry.js";

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

describe("ExecutionTarget registry", () => {
  it("从静态矩阵 + backend registry 装配全部 target", () => {
    const backend = buildExecutionBackendRegistry({
      descriptorsJson: JSON.stringify([
        { id: "sandbox", url: "http://sandbox:8080", profile: "sandbox-untrusted" },
        { id: "local-lean", url: "http://host.docker.internal:8787", profile: "host" },
      ]),
      env: { PTH_EXEC_SANDBOX_ALIAS: "off" },
      strict: false,
    }).registry;
    const { registry, warnings } = buildExecutionTargetRegistry({
      matrixJson: MATRIX,
      backendRegistry: backend,
      strict: false,
    });
    const ids = [...registry.list().keys()];
    expect(ids).toContain("sandbox");
    expect(ids).toContain("engine-ts");
    expect(ids).toContain("local-lean");
    // 静态 sandbox 与 backend 冲突只告警不覆盖
    expect(warnings.some((w) => w.includes("sandbox"))).toBe(true);
  });

  it("默认路由：python→sandbox，ts→engine-ts", () => {
    const backend = buildExecutionBackendRegistry({
      descriptorsJson: JSON.stringify([
        { id: "sandbox", url: "http://sandbox:8080", profile: "sandbox-untrusted" },
      ]),
      env: { PTH_EXEC_SANDBOX_ALIAS: "off" },
      strict: false,
    }).registry;
    const { registry } = buildExecutionTargetRegistry({
      matrixJson: MATRIX,
      backendRegistry: backend,
      strict: false,
    });
    expect(registry.resolve("python").id).toBe("sandbox");
    expect(registry.resolve("bash").id).toBe("sandbox");
    expect(registry.resolve("ts").id).toBe("engine-ts");
  });

  it("显式 target：纯解析——不抛 userSelectable/requiresApproval；未注册仍拒绝", () => {
    const backend = buildExecutionBackendRegistry({
      descriptorsJson: JSON.stringify([
        { id: "sandbox", url: "http://sandbox:8080", profile: "sandbox-untrusted" },
        { id: "local-lean", url: "http://host.docker.internal:8787", profile: "host" },
      ]),
      env: { PTH_EXEC_SANDBOX_ALIAS: "off" },
      strict: false,
    }).registry;
    const { registry } = buildExecutionTargetRegistry({
      matrixJson: MATRIX,
      backendRegistry: backend,
      strict: false,
    });
    // Phase 2：userSelectable/requiresApproval 是 Command 层策略，resolve 只做纯解析。
    expect(registry.resolve("python", "sandbox").id).toBe("sandbox");
    expect(registry.resolve("bash", "local-lean").id).toBe("local-lean");
    expect(() => registry.resolve("python", "ghost")).toThrow(/不存在/);
  });
});
