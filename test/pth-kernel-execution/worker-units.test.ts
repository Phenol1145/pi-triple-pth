import { describe, it, expect } from "vitest";
import { isWorkerKind, WORKER_KINDS, type TaskTemplateHandoff } from "@away_from/pth-contracts";
import { WorkerRegistry, resolveAdvisoryWorkerKind, type WorkerUnitSpec } from "@away_from/pth-kernel-execution";

describe("WorkerRegistry / WorkerKind", () => {
  it("区分 llm/code/hybrid", () => {
    const reg = new WorkerRegistry();
    reg.register({ id: "w:llm", kind: "llm", name: "llm worker" });
    reg.register({ id: "w:code", kind: "code", name: "code worker" });
    reg.register({ id: "w:hybrid", kind: "hybrid", name: "hybrid worker" });
    expect(reg.listByKind("llm").map((w) => w.spec.id)).toEqual(["w:llm"]);
    expect(reg.listByKind("code").map((w) => w.spec.id)).toEqual(["w:code"]);
    expect(reg.listByKind("hybrid").map((w) => w.spec.id)).toEqual(["w:hybrid"]);
  });

  it("WORKER_KINDS / isWorkerKind", () => {
    expect(WORKER_KINDS).toEqual(["llm", "code", "hybrid"]);
    expect(isWorkerKind("llm")).toBe(true);
    expect(isWorkerKind("agent")).toBe(false);
  });

  it("重复注册拒绝", () => {
    const reg = new WorkerRegistry();
    reg.register({ id: "w:x", kind: "code", name: "x" });
    expect(() => reg.register({ id: "w:x", kind: "llm", name: "y" })).toThrow(/already registered/);
  });
});

describe("resolveAdvisoryWorkerKind（模板 handoff 只作建议）", () => {
  const spec: Pick<WorkerUnitSpec, "id" | "kind"> = { id: "w:executor", kind: "llm" };

  it("无建议 → accepted", () => {
    expect(resolveAdvisoryWorkerKind(spec, undefined)).toEqual({ accepted: true });
  });

  it("合法建议 accepted", () => {
    const handoff: TaskTemplateHandoff = { nextRoleId: "developer", nextWorkerKind: "llm" };
    expect(resolveAdvisoryWorkerKind(spec, handoff)).toEqual({ accepted: true });
  });

  it("非法 nextWorkerKind 拒绝", () => {
    expect(resolveAdvisoryWorkerKind(spec, { nextWorkerKind: "agent" as never })).toMatchObject({ accepted: false });
  });

  it("模板不能降低审批要求", () => {
    expect(resolveAdvisoryWorkerKind({ id: "w:executor", kind: "llm" }, { nextWorkerKind: "code", requiresApproval: false }))
      .toMatchObject({ accepted: false, reason: expect.stringContaining("loosen") });
  });
});
