import { beforeAll, describe, expect, it } from "vitest";
import { installDefaultRoles } from "../helpers";
import {
  createPenetrationRunner,
  type PenetrationRunChild,
  type PenetrationRunChildRequest,
} from "../../src/pth/tasking/penetration-runner.js";
import { buildPenetrationSkillContent } from "../../src/pth/tasking/penetration-skill.js";
import type { TaskDispatchContext, TenantScope } from "../../src/pth/contracts/index.js";

beforeAll(() => {
  installDefaultRoles();
});

const CALLER: TaskDispatchContext = { taskId: "t-parent", roleId: "developer", tenantId: "default", delivery: null };
const SCOPE: TenantScope = { tenantId: "default", principalId: "worker:developer", roles: ["developer"], traceId: "task:t-parent" };

function devToCoderContent() {
  return buildPenetrationSkillContent({
    parent: "developer",
    child: "coder",
    inputContract: "自包含代码实现任务（标题+描述+上下文快照）",
    outputContract: "{code: string; tests: string[]; verified: boolean}",
    anchor: "developer→coder 的稳定代码编写路径",
    whenToUse: "实现任务稳定命中 coder 特化时",
    effect: "跳过逐级派发往返，直接调用子类型",
    path: ["developer", "coder"],
  });
}

function fakeMemory(entries: Record<string, { kind: string; status?: string; content: string }>) {
  return {
    get: async (id: string) => {
      const e = entries[id];
      return e ? { id, ...e } : undefined;
    },
  };
}

function okRunChild(capture?: { req?: PenetrationRunChildRequest }): PenetrationRunChild {
  return async (req) => {
    if (capture) capture.req = req;
    return { ok: true, value: { code: "fn()", tests: ["t1"], verified: true }, summary: "done", steps: 4, durationMs: 120 };
  };
}

const INPUT = { to: "coder", title: "实现 fizzbuzz", text: "写一个 fizzbuzz 函数并自验" };

describe("0.16.3 穿透执行面：PenetrationRunner（用户裁决——显式原语/深度限1/报错父决策/执行面only）", () => {
  it("成功路径：official 穿透边 + 组织权 + 边归属一致 → runChild 执行并映射结果", async () => {
    const capture: { req?: PenetrationRunChildRequest } = {};
    const runner = createPenetrationRunner({
      memory: fakeMemory({ "skill:penetrate:coder": { kind: "skill", status: "official", content: devToCoderContent() } }),
      runChild: okRunChild(capture),
    });
    const r = await runner.penetrate(INPUT, CALLER, SCOPE);
    expect(r.ok).toBe(true);
    expect(r.childRole).toBe("coder");
    expect(r.value).toEqual({ code: "fn()", tests: ["t1"], verified: true });
    expect(r.steps).toBe(4);
    // 合成文本：契约前置 + 调用方自包含描述
    expect(capture.req!.text).toContain("【输入契约】自包含代码实现任务");
    expect(capture.req!.text).toContain("【产物契约】{code: string; tests: string[]; verified: boolean}");
    expect(capture.req!.text).toContain("写一个 fizzbuzz 函数并自验");
    expect(capture.req!.skillId).toBe("skill:penetrate:coder");
    expect(capture.req!.caller.taskId).toBe("t-parent");
  });

  it("context 快照随任务文本传递（【附加上下文】块）", async () => {
    const capture: { req?: PenetrationRunChildRequest } = {};
    const runner = createPenetrationRunner({
      memory: fakeMemory({ "skill:penetrate:coder": { kind: "skill", status: "official", content: devToCoderContent() } }),
      runChild: okRunChild(capture),
    });
    await runner.penetrate({ ...INPUT, context: { spec: "v2", n: 100 } }, CALLER, SCOPE);
    expect(capture.req!.text).toContain("【附加上下文】");
    expect(capture.req!.text).toContain('"n": 100');
  });

  it("调用者上下文未就绪 → 拒绝（不可自报身份）", async () => {
    const runner = createPenetrationRunner({ memory: fakeMemory({}), runChild: okRunChild() });
    await expect(runner.penetrate(INPUT, { taskId: "", roleId: "", tenantId: "default", delivery: null }, SCOPE))
      .rejects.toThrow("任务上下文未就绪");
  });

  it("目标角色未注册 → 拒绝", async () => {
    const runner = createPenetrationRunner({ memory: fakeMemory({}), runChild: okRunChild() });
    await expect(runner.penetrate({ ...INPUT, to: "nonexistent-role" }, CALLER, SCOPE))
      .rejects.toThrow("穿透目标角色未注册");
  });

  it("组织权实时重验：sensor 系无投递权 → 拒绝（注册时合法不等于执行时合法）", async () => {
    const runner = createPenetrationRunner({ memory: fakeMemory({}), runChild: okRunChild() });
    const sensorCaller: TaskDispatchContext = { taskId: "t-s", roleId: "sensor:worker-opt", tenantId: "default", delivery: null };
    await expect(runner.penetrate(INPUT, sensorCaller, SCOPE)).rejects.toThrow("组织权拒绝");
  });

  it("穿透边未注册（无 skill 条目）→ 拒绝并指引回退 delegate", async () => {
    const runner = createPenetrationRunner({ memory: fakeMemory({}), runChild: okRunChild() });
    await expect(runner.penetrate(INPUT, CALLER, SCOPE))
      .rejects.toThrow("穿透边未注册");
    await expect(runner.penetrate(INPUT, CALLER, SCOPE))
      .rejects.toThrow("tasks.delegate");
  });

  it("draft 穿透边不可执行（审批后才生效）", async () => {
    const runner = createPenetrationRunner({
      memory: fakeMemory({ "skill:penetrate:coder": { kind: "skill", status: "draft", content: devToCoderContent() } }),
      runChild: okRunChild(),
    });
    await expect(runner.penetrate(INPUT, CALLER, SCOPE)).rejects.toThrow("穿透边未生效");
    await expect(runner.penetrate(INPUT, CALLER, SCOPE)).rejects.toThrow("draft");
  });

  it("边归属不符：skill 注册边 parent=analyst，调用方 developer → 拒绝（冒用防护）", async () => {
    const otherEdge = buildPenetrationSkillContent({
      parent: "analyst", child: "solver",
      inputContract: "in", outputContract: "out",
      anchor: "a", whenToUse: "w", effect: "e",
    });
    const runner = createPenetrationRunner({
      memory: fakeMemory({ "skill:penetrate:solver": { kind: "skill", status: "official", content: otherEdge } }),
      runChild: okRunChild(),
    });
    // analyst→solver 合法边，但调用方 origin（全树投递权——组织权放行）→ 边归属拒绝
    const originCaller: TaskDispatchContext = { taskId: "t-o", roleId: "origin", tenantId: "default", delivery: null };
    await expect(runner.penetrate({ ...INPUT, to: "solver" }, originCaller, SCOPE))
      .rejects.toThrow("穿透边归属不符");
  });

  it("skill 内容非法（缺机读边）→ 拒绝", async () => {
    const runner = createPenetrationRunner({
      memory: fakeMemory({ "skill:penetrate:coder": { kind: "skill", status: "official", content: "# skill:penetrate:coder\n坏内容" } }),
      runChild: okRunChild(),
    });
    await expect(runner.penetrate(INPUT, CALLER, SCOPE)).rejects.toThrow("穿透 skill 内容非法");
  });

  it("子 agent 执行失败 → 报错由父决策（不自动回退 delegate）", async () => {
    const runner = createPenetrationRunner({
      memory: fakeMemory({ "skill:penetrate:coder": { kind: "skill", status: "official", content: devToCoderContent() } }),
      runChild: async () => ({ ok: false, steps: 7, error: "llm-timeout", durationMs: 3000 }),
    });
    await expect(runner.penetrate(INPUT, CALLER, SCOPE)).rejects.toThrow("穿透执行失败");
    await expect(runner.penetrate(INPUT, CALLER, SCOPE)).rejects.toThrow("llm-timeout");
  });
});
