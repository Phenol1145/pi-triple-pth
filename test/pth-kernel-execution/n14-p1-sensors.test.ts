import { beforeAll, describe, expect, it } from "vitest";
import { installDefaultRoles } from "../helpers";

/**
 * N14 P1：sensor 三新点位（tool-face / tool-single / rule——0.17.4 四层次观测缺口）。
 * 设计：docs/pth/design/n14-sensor-controller-four-dims.md §2.1/§2.3——
 * 治理族叶子（parent=sensor，gen=1——2026-08-24 三源重构顺移 -1），组织权排除自动继承（sensor: 前缀），
 * 谱系可见、默认不进 batch、PTH_WORKER_ROLES 显式启用。
 */
beforeAll(() => {
  installDefaultRoles();
});

const NEW_SENSORS = ["sensor:tool-face", "sensor:tool-single", "sensor:rule"] as const;

describe("N14 P1：sensor 三新点位注册（builtin-roles）", () => {
  it("三元组与治理族约束（§7-5 验收）", async () => {
    const { GOVERNANCE_ROLES } = await import("../../src/pth/impls/roles/default-roles.js");
    for (const id of NEW_SENSORS) {
      const r = GOVERNANCE_ROLES.find((g) => g.id === id);
      expect(r, `${id} 应在 GOVERNANCE_ROLES`).toBeDefined();
      // 谱系：gen=1 挂 sensor（2026-08-24 三源重构顺移 -1）
      expect(r!.parent).toBe("sensor");
      expect(r!.generation).toBe(1);
      // 治理族约束：观测面 capabilities（obs 无 manage——只观测不调节）
      expect(r!.capabilities).toContain("obs");
      expect(r!.capabilities).not.toContain("manage");
      // actionTools 与既有 sensor 同构（执行核+导航+缓存，无生产核/治理面）
      expect(r!.actionTools).toEqual(["execTs", "execPy", "execBash", "nav", "cache"]);
      expect(r!.acceptanceRole).toBe("read-only");
      expect(r!.output).toBe("observation");
      // prompt 承诺任务类型与产物契约（observation-report——三源重构 W1）
      expect(r!.prompt).toContain("observation-report");
      expect(r!.prompt).toContain("draft");
    }
  });

  it("数据源与 prompt 真实性：sensor:rule 指向 obs.guards（N12 二期观测面消费位）", async () => {
    const { GOVERNANCE_ROLES } = await import("../../src/pth/impls/roles/default-roles.js");
    const rule = GOVERNANCE_ROLES.find((g) => g.id === "sensor:rule")!;
    expect(rule.prompt).toContain("obs.guards");
    expect(rule.prompt).toContain("killRatio");
    const single = GOVERNANCE_ROLES.find((g) => g.id === "sensor:tool-single")!;
    expect(single.prompt).toContain("unknown-tool");
    const face = GOVERNANCE_ROLES.find((g) => g.id === "sensor:tool-face")!;
    expect(face.prompt).toContain("组合链");
  });

  it("组织权排除自动继承：新 sensor 无投递权（W8——sensor: 前缀治理面）", async () => {
    const { allowedDelegationTargets } = await import("../../src/pth/tasking/delegation-policy.js");
    for (const id of NEW_SENSORS) {
      expect(allowedDelegationTargets(id)).toEqual([]);
    }
  });

  it("谱系可见 + 显式可派发（parseRoleWeights known 集合含新点位）", async () => {
    const { allLineageRoles, allWorkerRoles, parseRoleWeights } = await import("@away_from/pth-kernel-execution");
    const lineage = allLineageRoles().map((r) => r.id);
    const dispatched = allWorkerRoles().map((r) => r.id);
    for (const id of NEW_SENSORS) {
      expect(lineage).toContain(id);
      expect(dispatched).not.toContain(id);   // 默认不进 batch（池容量安全）
    }
    const w = parseRoleWeights("sensor:tool-face:1,sensor:tool-single:1,sensor:rule:1");
    expect(w.get("sensor:tool-face")).toBe(1);
    expect(w.get("sensor:rule")).toBe(1);
  });
});
