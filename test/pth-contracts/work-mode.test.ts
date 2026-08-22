import { describe, expect, it } from "vitest";
import {
  assertWorkModeImmutable,
  createServerWorkEnvelope,
  WORK_MODES,
  type WorkMode,
} from "@away_from/pth-contracts";

describe("work-mode pure contract (M0)", () => {
  it("WORK_MODES 是三值且顺序固定为 intake/optimize/run", () => {
    expect(WORK_MODES).toEqual(["intake", "optimize", "run"]);
  });

  it("createServerWorkEnvelope 服务端构造成功并盖章 mode", () => {
    const envelope = createServerWorkEnvelope({
      workId: "task-1",
      mode: "run",
      objective: "prove theorem",
      authorityPolicyRef: "authority:run-v1",
      budgetPolicyRef: "budget:lean-v1",
      causationId: "turn-1",
    });
    expect(envelope).toEqual({
      workId: "task-1",
      mode: "run",
      objective: "prove theorem",
      authorityPolicyRef: "authority:run-v1",
      budgetPolicyRef: "budget:lean-v1",
      causationId: "turn-1",
    });
    expect(envelope.mode).toBe("run");
  });

  it("createServerWorkEnvelope 拒绝未知 mode", () => {
    expect(() =>
      createServerWorkEnvelope({
        workId: "task-1",
        mode: "unknown" as unknown as WorkMode,
        objective: "prove theorem",
        authorityPolicyRef: "authority:run-v1",
        budgetPolicyRef: "budget:lean-v1",
        causationId: "turn-1",
      }),
    ).toThrow(/unknown work mode/i);
  });

  it("createServerWorkEnvelope 拒绝空 policy 引用", () => {
    expect(() =>
      createServerWorkEnvelope({
        workId: "task-1",
        mode: "run",
        objective: "prove theorem",
        authorityPolicyRef: "  ",
        budgetPolicyRef: "budget:lean-v1",
        causationId: "turn-1",
      }),
    ).toThrow(/authorityPolicyRef/i);
    expect(() =>
      createServerWorkEnvelope({
        workId: "task-1",
        mode: "run",
        objective: "prove theorem",
        authorityPolicyRef: "authority:run-v1",
        budgetPolicyRef: "",
        causationId: "turn-1",
      }),
    ).toThrow(/budgetPolicyRef/i);
  });

  it("createServerWorkEnvelope 拒绝自父引用与缺失 causation", () => {
    expect(() =>
      createServerWorkEnvelope({
        workId: "task-1",
        mode: "intake",
        objective: "collect source",
        authorityPolicyRef: "authority:intake-v1",
        budgetPolicyRef: "budget:intake-v1",
        parentWorkId: "task-1",
        causationId: "turn-1",
      }),
    ).toThrow(/self-parent/i);
    expect(() =>
      createServerWorkEnvelope({
        workId: "task-1",
        mode: "run",
        objective: "prove theorem",
        authorityPolicyRef: "authority:run-v1",
        budgetPolicyRef: "budget:lean-v1",
        causationId: "",
      }),
    ).toThrow(/causationId/i);
  });

  it("assertWorkModeImmutable：同 workId 改 mode 必须拒绝且提示 new work", () => {
    expect(() =>
      assertWorkModeImmutable(
        { workId: "task-1", mode: "run" },
        { workId: "task-1", mode: "intake" },
      ),
    ).toThrow(/new work/i);
  });

  it("assertWorkModeImmutable：同 mode 或不同 workId 允许", () => {
    expect(() =>
      assertWorkModeImmutable(
        { workId: "task-1", mode: "run" },
        { workId: "task-1", mode: "run" },
      ),
    ).not.toThrow();
    expect(() =>
      assertWorkModeImmutable(
        { workId: "task-1", mode: "run" },
        { workId: "task-2", mode: "intake" },
      ),
    ).not.toThrow();
  });
});
