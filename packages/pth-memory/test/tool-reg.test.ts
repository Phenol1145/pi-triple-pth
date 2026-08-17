import { describe, it, expect } from "vitest";
import {
  TOOL_REG_KIND,
  TOOL_REG_ID_PREFIX,
  TOOL_SPEC_MARKER,
  buildToolRegContent,
  buildToolRegEntry,
  parseToolRegContent,
  validateToolRegSpec,
  layerOfKind,
  checkWrite,
  checkUpdate,
  type ToolRegSpec,
} from "@away_from/pth-memory";

function demoSpec(overrides: Partial<ToolRegSpec> = {}): ToolRegSpec {
  return {
    name: "util_parse_log",
    version: 1,
    description: { anchor: "日志时间戳抽取", whenToUse: "解析杂乱日志首列时间戳", effect: "ISO 时间数组" },
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    executor: { type: "program", source: "const m = text.match(/\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}/g); return m ?? [];" },
    visibility: { roles: ["developer", "coder"], pack: "util" },
    promotedFrom: "tool-function:parseLogTimestamp",
    ...overrides,
  };
}

describe("N14 P0：tool-reg 条目格式 + __tool_spec__ 校验", () => {
  it("build/parse roundtrip：标题、三要素、机读 spec 完整", () => {
    const spec = demoSpec();
    const content = buildToolRegContent(spec);
    expect(content).toContain("# tool:util_parse_log");
    expect(content).toContain(TOOL_SPEC_MARKER);
    expect(content).toContain("【场景锚点】日志时间戳抽取");

    const parsed = parseToolRegContent(content);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.id).toBe(`${TOOL_REG_ID_PREFIX}util_parse_log`);
    expect(parsed.spec).toEqual(spec);
  });

  it("幂等：同一 spec 产出同一文本", () => {
    expect(buildToolRegContent(demoSpec())).toBe(buildToolRegContent(demoSpec()));
  });

  it("校验拒绝：name 非法 / version 非法 / 三要素缺失", () => {
    expect(validateToolRegSpec(demoSpec({ name: "Bad Name" })).ok).toBe(false);
    expect(validateToolRegSpec(demoSpec({ name: "" })).ok).toBe(false);
    expect(validateToolRegSpec(demoSpec({ version: 0 })).ok).toBe(false);
    expect(validateToolRegSpec(demoSpec({ version: 1.5 })).ok).toBe(false);
    expect(validateToolRegSpec(demoSpec({ description: { anchor: "", whenToUse: "w", effect: "e" } })).ok).toBe(false);
    expect(validateToolRegSpec(demoSpec({ description: { anchor: "a", whenToUse: "", effect: "e" } })).ok).toBe(false);
    expect(validateToolRegSpec(demoSpec({ description: { anchor: "a", whenToUse: "w", effect: "" } })).ok).toBe(false);
  });

  it("校验拒绝：schema 非法（required 不在 properties / 形状缺失）", () => {
    const bad = demoSpec();
    bad.parameters = { type: "object", properties: { text: { type: "string" } }, required: ["missing"] };
    const r = validateToolRegSpec(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("required");
    expect(validateToolRegSpec(demoSpec({ parameters: {} as ToolRegSpec["parameters"] })).ok).toBe(false);
  });

  it("校验拒绝：执行体三态各缺关键字段（§7-1）", () => {
    expect(validateToolRegSpec(demoSpec({ executor: { type: "program", source: "" } })).ok).toBe(false);
    expect(validateToolRegSpec(demoSpec({ executor: { type: "builtin", ref: "" } })).ok).toBe(false);
    expect(validateToolRegSpec(demoSpec({ executor: { type: "agent", role: "" } })).ok).toBe(false);
    expect(validateToolRegSpec(demoSpec({ executor: { type: "alien" } as unknown as ToolRegSpec["executor"] })).ok).toBe(false);
  });

  it("校验拒绝：visibility 空 / pack 空（§7-1 命题 3 防线）", () => {
    expect(validateToolRegSpec(demoSpec({ visibility: { roles: [], pack: "util" } })).ok).toBe(false);
    expect(validateToolRegSpec(demoSpec({ visibility: { roles: ["developer"], pack: "" } })).ok).toBe(false);
    expect(validateToolRegSpec(demoSpec({ visibility: { roles: [""], pack: "util" } })).ok).toBe(false);
  });

  it("执行体三态合法样例均通过", () => {
    expect(validateToolRegSpec(demoSpec()).ok).toBe(true);   // program
    expect(validateToolRegSpec(demoSpec({ executor: { type: "builtin", ref: "ts.run" } })).ok).toBe(true);
    expect(validateToolRegSpec(demoSpec({ executor: { type: "agent", role: "coder", input: "代码任务", output: "{code}" } })).ok).toBe(true);
  });

  it("漂移防护：标题/spec.name 不一致、文本三要素与机读行不一致 → 拒绝", () => {
    const content = buildToolRegContent(demoSpec());
    // 篡改标题
    const badTitle = content.replace("# tool:util_parse_log", "# tool:util_other");
    const r1 = parseToolRegContent(badTitle);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error).toContain("标题");
    // 篡改文本三要素（机读行不动）
    const badText = content.replace("【效果】ISO 时间数组", "【效果】篡改后的效果");
    const r2 = parseToolRegContent(badText);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error).toContain("漂移");
    // 缺机读行
    const noMarker = content.split("\n").filter((l) => !l.includes(TOOL_SPEC_MARKER)).join("\n");
    expect(parseToolRegContent(noMarker).ok).toBe(false);
  });

  it("buildToolRegEntry：id=tool:<name>、kind=tool-reg、meta 含版本/包/执行体态", () => {
    const entry = buildToolRegEntry(demoSpec(), { status: "official" });
    expect(entry.id).toBe("tool:util_parse_log");
    expect(entry.kind).toBe(TOOL_REG_KIND);
    expect(entry.status).toBe("official");
    expect(entry.anchors).toContain("tool-reg");
    expect(entry.anchors).toContain("util_parse_log");
    expect(entry.anchors).toContain("util");
    expect(entry.meta).toMatchObject({ format: "tool-reg-v1", version: 1, pack: "util", executorType: "program", promotedFrom: "tool-function:parseLogTimestamp" });
    // 非法 spec → 抛错（登记器/治理流入口防线）
    expect(() => buildToolRegEntry(demoSpec({ visibility: { roles: [], pack: "util" } }))).toThrow();
  });
});

describe("N14 P0：memory-policy——tool-reg 入 prompt 层（worker 只读防伪造注册）", () => {
  it("layerOfKind(tool-reg) = prompt", () => {
    expect(layerOfKind("tool-reg")).toBe("prompt");
  });
  it("worker write/update 均拒绝", () => {
    const w = checkWrite("tool-reg", "official");
    expect(w.ok).toBe(false);
    expect(w.reason).toContain("prompt 层");
    const u = checkUpdate("tool-reg");
    expect(u.ok).toBe(false);
    expect(u.reason).toContain("prompt 层");
  });
});
