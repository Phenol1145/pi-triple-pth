import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { validateRoleCardV1, type RoleCardV1 } from "../../src/pth/catalog/role-definition-v1.js";

const here = dirname(fileURLToPath(import.meta.url));
const sampleCard = JSON.parse(
  readFileSync(join(here, "../../src/pth/catalog/data/roles/sensor-worker-opt.json"), "utf-8"),
) as RoleCardV1;

describe("Role Catalog W0 role-definition/v1", () => {
  it("样例卡片校验通过并投影为 RoleDefinition", () => {
    const r = validateRoleCardV1(sampleCard);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.role.id).toBe("sensor:worker-opt");
      expect(r.role.parent).toBe("sensor");
      expect(r.role.produces).toEqual(["observation-report"]);
      expect(r.role.memoryScope).toBe("own");
      expect(r.role.capabilities).toContain("obs");
      expect(r.role.actionTools).toContain("execTs");
    }
  });

  it("未登记词汇拒绝", () => {
    const r = validateRoleCardV1({
      ...sampleCard,
      capabilities: { functions: ["no-such-cap"], actionTools: sampleCard.capabilities.actionTools },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toContain("no-such-cap");
  });

  it("缺 identity.prompt 拒绝", () => {
    const r = validateRoleCardV1({ ...sampleCard, identity: { ...sampleCard.identity, prompt: "" } });
    expect(r.ok).toBe(false);
  });
});
