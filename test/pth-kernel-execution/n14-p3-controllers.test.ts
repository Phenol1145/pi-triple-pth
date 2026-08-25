import { beforeAll, describe, expect, it } from "vitest";
import { installDefaultRoles } from "../helpers";

/**
 * N14 P3：controller 三新点位（tool-face / tool-single / rule——0.17.4 四层次调节缺口）。
 * 设计：docs/pth/design/n14-sensor-controller-four-dims.md §2.2/§2.3——
 * 治理族叶子（parent=controller，gen=1——2026-08-24 三源重构顺移 -1），组织权排除自动继承（controller: 前缀），
 * 谱系可见、默认不进 batch、PTH_WORKER_ROLES 显式启用。
 */
beforeAll(() => {
  installDefaultRoles();
});

const NEW_CONTROLLERS = ["controller:tool-face", "controller:tool-single", "controller:rule"] as const;

describe("N14 P3：controller 三新点位注册（builtin-roles）", () => {
  it("三元组与治理族约束（§7-5 验收）", async () => {
    const { GOVERNANCE_ROLES } = await import("../../src/pth/impls/roles/default-roles.js");
    for (const id of NEW_CONTROLLERS) {
      const r = GOVERNANCE_ROLES.find((g) => g.id === id);
      expect(r, `${id} 应在 GOVERNANCE_ROLES`).toBeDefined();
      expect(r!.parent).toBe("controller");
      expect(r!.generation).toBe(1);
      // 调节面：manage（写控制）+ 读 observation-report 走 memory；W2 剔除 obs.*（sensor 独有观测面）
      expect(r!.capabilities).not.toContain("obs");
      expect(r!.capabilities).toContain("manage");
      expect(r!.actionTools).toEqual(["execTs", "execPy", "execBash", "nav", "cache"]);
      expect(r!.acceptanceRole).toBe("read-only");
    }
  });

  it("调节手段与设计 §2.2 一致（manage.tool.* / modification-plan）", async () => {
    const { GOVERNANCE_ROLES } = await import("../../src/pth/impls/roles/default-roles.js");
    const face = GOVERNANCE_ROLES.find((g) => g.id === "controller:tool-face")!;
    expect(face.prompt).toContain("manage.tool.register");
    expect(face.prompt).toContain("PTH_TOOL_FACE_BUDGET");
    const single = GOVERNANCE_ROLES.find((g) => g.id === "controller:tool-single")!;
    expect(single.prompt).toContain("manage.tool.revise");
    expect(single.prompt).toContain("T8 三要素");
    const rule = GOVERNANCE_ROLES.find((g) => g.id === "controller:rule")!;
    expect(rule.prompt).toContain("PTH_GUARD_*");
    expect(rule.prompt).toContain("治理族不豁免");
    expect(rule.prompt).toContain("modification-plan");
    // controller:adversarial 职责扩展：skill + tool 双提案审核（N14 §3.4）
    const adversarial = GOVERNANCE_ROLES.find((g) => g.id === "controller:adversarial")!;
    expect(adversarial.prompt).toContain("工具注册提案");
    expect(adversarial.prompt).toContain("schema 质量");
    // 审核面能力声明与 capability 注入同源（roleFilter 白名单——skills.review / tools.review 不丢）
    expect(adversarial.capabilities).toContain("skills");
    expect(adversarial.capabilities).toContain("tools");
  });

  it("组织权排除自动继承：新 controller 无投递权（W8——controller: 前缀治理面）", async () => {
    const { allowedDelegationTargets } = await import("../../src/pth/tasking/delegation-policy.js");
    for (const id of NEW_CONTROLLERS) {
      expect(allowedDelegationTargets(id)).toEqual([]);
    }
  });

  it("谱系可见 + 显式可派发（parseRoleWeights known 集合含新点位）", async () => {
    const { allLineageRoles, allWorkerRoles, parseRoleWeights } = await import("@away_from/pth-kernel-execution");
    const lineage = allLineageRoles().map((r) => r.id);
    const dispatched = allWorkerRoles().map((r) => r.id);
    for (const id of NEW_CONTROLLERS) {
      expect(lineage).toContain(id);
      expect(dispatched).not.toContain(id);   // 默认不进 batch（池容量安全）
    }
    const w = parseRoleWeights("controller:tool-face:1,controller:tool-single:1,controller:rule:1");
    expect(w.get("controller:tool-face")).toBe(1);
    expect(w.get("controller:tool-single")).toBe(1);
    expect(w.get("controller:rule")).toBe(1);
  });
});
