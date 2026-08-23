import { describe, expect, it } from "vitest";
import {
  isExecutionTargetDefinitionStructurallyValid,
  validateExecutionTargetMatrix,
} from "../../packages/pth-contracts/src/execution-target.js";

const SAMPLE = {
  id: "sandbox",
  kind: "kernel-pool",
  profile: "sandbox-untrusted",
  languages: ["python", "bash"],
  modes: { sync: true, stream: false, interactive: false, persistent: true },
  session: { type: "persistent-repl", scope: "notebook", ttlMs: 1800000 },
  capabilities: { richMedia: true, streaming: false, cancel: true, pathMapping: false },
  routing: { defaultFor: ["python", "bash"], userSelectable: false, requiresApproval: false },
  binding: { type: "execution-session", backendId: "sandbox" },
} as const;

describe("execution-target contracts", () => {
  it("合法 ExecutionTargetDefinition 通过结构校验", () => {
    expect(isExecutionTargetDefinitionStructurallyValid(SAMPLE)).toBe(true);
  });

  it("非法 id / language / binding 拒绝", () => {
    expect(isExecutionTargetDefinitionStructurallyValid({ ...SAMPLE, id: "Bad ID" })).toBe(false);
    expect(isExecutionTargetDefinitionStructurallyValid({ ...SAMPLE, languages: ["java"] })).toBe(false);
    expect(isExecutionTargetDefinitionStructurallyValid({ ...SAMPLE, binding: { type: "execution-backend", backendId: "", mode: "sync" } })).toBe(false);
  });

  it("validateExecutionTargetMatrix 检测重复 id 与未注册 backendId", () => {
    expect(() => validateExecutionTargetMatrix([SAMPLE, { ...SAMPLE, id: "sandbox" }])).toThrow(/重复 id/);
    expect(() => validateExecutionTargetMatrix([SAMPLE], { registeredBackendIds: new Set() })).toThrow(/binding.backendId 未注册/);
    expect(() => validateExecutionTargetMatrix([SAMPLE], { registeredBackendIds: new Set(["sandbox"]) })).not.toThrow();
  });
});
