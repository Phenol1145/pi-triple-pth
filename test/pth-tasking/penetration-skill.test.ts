import { beforeAll, describe, expect, it } from "vitest";
import { installDefaultRoles } from "../helpers";
import {
  buildPenetrationSkillContent,
  buildPenetrationSkillEntry,
  parsePenetrationSkillContent,
  validatePenetrationSkillRegistration,
  PENETRATION_SKILL_ID_PREFIX,
} from "../../src/pth/tasking/penetration-skill.js";
import { parseSkillMarkdown } from "@away_from/pth-memory";

beforeAll(() => {
  installDefaultRoles();
});

function devToCoder() {
  return {
    parent: "developer",
    child: "coder",
    inputContract: "自包含代码实现任务（标题+描述+上下文快照）",
    outputContract: "{code: string; tests: string[]; verified: boolean}",
    anchor: "developer→coder 的稳定代码编写路径",
    whenToUse: "实现任务稳定命中 coder 特化时",
    effect: "跳过逐级派发往返，直接调用子类型",
    path: ["developer", "coder"],
  };
}

describe("W8 P3：skill:penetrate:* 接口位与注册校验", () => {
  it("build/parse roundtrip：标题、三要素、机读边信息完整", () => {
    const content = buildPenetrationSkillContent(devToCoder());
    expect(content).toContain("# skill:penetrate:coder");
    expect(content).toContain("__penetration_edge__");

    const parsed = parsePenetrationSkillContent(content);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.id).toBe(`${PENETRATION_SKILL_ID_PREFIX}coder`);
    expect(parsed.child).toBe("coder");
    expect(parsed.spec).toEqual(devToCoder());

    // 兼容四段式通用解析（pth-memory 接受 penetrate: 命名空间）
    const generic = parseSkillMarkdown(content, "penetrate:coder");
    expect(generic.ok).toBe(true);
    expect(generic.ok && generic.name).toBe("penetrate:coder");
  });

  it("注册校验：组织权矩阵命中才放行（developer→coder ✓）", () => {
    const content = buildPenetrationSkillContent(devToCoder());
    expect(validatePenetrationSkillRegistration(content)).toEqual({
      ok: true,
      id: "skill:penetrate:coder",
      child: "coder",
      parent: "developer",
      content,
    });
  });

  it("注册校验：越权边调用即拒绝", () => {
    const coderToTester = buildPenetrationSkillContent({
      parent: "coder", child: "tester",
      inputContract: "x", outputContract: "y", anchor: "a", whenToUse: "w", effect: "e",
    });
    expect(validatePenetrationSkillRegistration(coderToTester)).toEqual({
      ok: false,
      error: expect.stringMatching(/组织权拒绝：coder 不可投递 tester/),
    });

    const devToScout = buildPenetrationSkillContent({
      parent: "developer", child: "scout",
      inputContract: "x", outputContract: "y", anchor: "a", whenToUse: "w", effect: "e",
    });
    expect(validatePenetrationSkillRegistration(devToScout).ok).toBe(false);
  });

  it("注册校验：未知角色/坏形状/路径不一致拒绝", () => {
    const unknownChild = buildPenetrationSkillContent({
      parent: "developer", child: "no-such-role",
      inputContract: "x", outputContract: "y", anchor: "a", whenToUse: "w", effect: "e",
    });
    expect(validatePenetrationSkillRegistration(unknownChild).ok).toBe(false);
    expect(validatePenetrationSkillRegistration("没有标题").ok).toBe(false);
    expect(validatePenetrationSkillRegistration(devToCoderAndBadPath()).ok).toBe(false);
  });

  it("buildPenetrationSkillEntry：合法内容产出 memory 条目；非法内容抛错", () => {
    const content = buildPenetrationSkillContent(devToCoder());
    const entry = buildPenetrationSkillEntry(content, { status: "official" });
    expect(entry).toMatchObject({
      id: "skill:penetrate:coder",
      kind: "skill",
      status: "official",
      meta: { format: "skill-penetration-v1", child: "coder", parent: "developer" },
    });
    expect(entry.anchors).toContain("penetration");
    expect(() => buildPenetrationSkillEntry("bad")).toThrow(/标题缺失或非法/);
  });
});

function devToCoderAndBadPath() {
  const content = buildPenetrationSkillContent(devToCoder());
  return content.replace('"path":["developer","coder"]', '"path":["developer","scout"]');
}
