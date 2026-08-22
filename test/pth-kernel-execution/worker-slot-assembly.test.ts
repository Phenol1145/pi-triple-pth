import { describe, expect, it } from "vitest";
import { assembleWorkerSlotIdentity } from "../../src/pth/bootstrap/worker-slot-assembly.js";
import { roleDefinitionRevision } from "@away_from/pth-kernel-execution";
import type { RoleDefinition } from "@away_from/pth-kernel-execution";

const role: RoleDefinition = { id: "researcher", tags: ["research"], prompt: "p" };

describe("assembleWorkerSlotIdentity（batch-process 与测试共用同一 helper）", () => {
  it("off 分支保留两个 distinct legacy principal 且不创建 replica", () => {
    const identity = assembleWorkerSlotIdentity({ mode: "off", role, batchId: "batch-a" });
    expect(identity.replica).toBeUndefined();
    expect(identity.taskPrincipalId).toBe("researcher");
    expect(identity.sandboxPrincipalId).toBe("worker:researcher");
  });

  it("feasibility 分支两个 principal 统一为 worker:<uuid> 且 replica role ref 来自 canonical 定义", () => {
    const identity = assembleWorkerSlotIdentity({
      mode: "feasibility",
      role,
      batchId: "batch-a",
      idFactory: () => "10000000-0000-4000-8000-000000000021",
    });
    expect(identity.replica?.ref).toEqual({
      workerId: "10000000-0000-4000-8000-000000000021",
      batchId: "batch-a",
      role: { roleId: "researcher", revision: roleDefinitionRevision(role) },
    });
    expect(identity.taskPrincipalId).toBe("worker:10000000-0000-4000-8000-000000000021");
    expect(identity.sandboxPrincipalId).toBe(identity.taskPrincipalId);
  });

  it("role revision 只依赖 canonical Role Definition（字段重排同值，prompt 变化改变 revision）", () => {
    const a = assembleWorkerSlotIdentity({ mode: "feasibility", role, batchId: "b", idFactory: () => "10000000-0000-4000-8000-000000000022" });
    const reordered = assembleWorkerSlotIdentity({
      mode: "feasibility",
      role: { tags: ["research"], prompt: "p", id: "researcher" },
      batchId: "b",
      idFactory: () => "10000000-0000-4000-8000-000000000023",
    });
    expect(a.replica?.ref.role.revision).toBe(reordered.replica?.ref.role.revision);
    const changed = assembleWorkerSlotIdentity({
      mode: "feasibility",
      role: { ...role, prompt: "changed" },
      batchId: "b",
      idFactory: () => "10000000-0000-4000-8000-000000000024",
    });
    expect(changed.replica?.ref.role.revision).not.toBe(a.replica?.ref.role.revision);
  });
});
