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
  proposeToolRegistration,
  reviewToolProposal,
  approveToolProposal,
  executeApprovedToolProposal,
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

describe("N14 P3：tool-reg 治理流（提案 → 对抗性审核 → 批准 → 注册生效）", () => {
  type Row = { id: string; kind: string; status: string; content: string; meta: Record<string, unknown> };
  function makeStore(seed: Row[] = []) {
    const rows = new Map<string, Row>(seed.map((r) => [r.id, r]));
    return {
      rows,
      get: async (id: string) => rows.get(id),
      write: async (entry: Row, opts?: { force?: boolean }) => {
        const id = String(entry.id);
        if (rows.has(id) && !opts?.force) throw new Error("entry exists");
        rows.set(id, { ...entry, status: entry.status ?? "draft", meta: entry.meta ?? {} });
      },
      update: async (id: string, patch: Partial<Row>) => {
        const old = rows.get(id);
        if (!old) throw new Error("entry not found");
        rows.set(id, { ...old, ...patch, meta: { ...(old.meta ?? {}), ...((patch.meta ?? {}) as Record<string, unknown>) } });
      },
    };
  }

  function regRow(spec: ToolRegSpec, status = "official"): Row {
    const entry = buildToolRegEntry(spec, { status: status === "draft" ? "draft" : "official" });
    return { id: entry.id, kind: entry.kind, status: entry.status, content: entry.content, meta: entry.meta };
  }

  async function fullPassChain(store: ReturnType<typeof makeStore>, input: { action: "register" | "revise"; spec: ToolRegSpec; rationale?: string }) {
    const proposal = await proposeToolRegistration(store as never, { action: input.action, name: input.spec.name, spec: input.spec, rationale: input.rationale });
    if (!proposal.ok) return proposal;
    const review = await reviewToolProposal(store as never, proposal.id!, "pass", "schema 完整 / 执行体安全 / 无作弊捷径");
    if (!review.ok) return review;
    const approved = await approveToolProposal(store as never, proposal.id!);
    if (!approved.ok) return approved;
    const executed = await executeApprovedToolProposal(store as never, proposal.id!);
    return { ...executed, proposalId: proposal.id };
  }

  it("提案落 draft：kind/anchors/meta + 事件关联 id 可用", async () => {
    const store = makeStore();
    const r = await proposeToolRegistration(store as never, { action: "register", name: demoSpec().name, spec: demoSpec(), rationale: "tool-function 晋升" });
    expect(r.ok).toBe(true);
    const p = store.rows.get(r.id!)!;
    expect(p.kind).toBe("tool-proposal");
    expect(p.status).toBe("draft");
    expect(p.anchors).toContain("tool-reg");
    expect(p.meta).toMatchObject({ action: "register", toolName: "util_parse_log", stage: "proposed" });
  });

  it("调用即拒绝：非法名/非法动作/spec 漂移/register 版本≠1/重复注册", async () => {
    const store = makeStore();
    const s = demoSpec();
    expect((await proposeToolRegistration(store as never, { action: "register", name: "Bad Name", spec: s })).ok).toBe(false);
    expect((await proposeToolRegistration(store as never, { action: "delete" as never, name: s.name, spec: s })).ok).toBe(false);
    expect((await proposeToolRegistration(store as never, { action: "register", name: "util_other", spec: s })).ok).toBe(false);
    expect((await proposeToolRegistration(store as never, { action: "register", name: s.name, spec: { ...s, version: 2 } })).ok).toBe(false);
    store.rows.set(`tool:${s.name}`, regRow(s));
    const dup = await proposeToolRegistration(store as never, { action: "register", name: s.name, spec: { ...s, version: 1 } });
    expect(dup.ok).toBe(false);
    expect(dup.error).toContain("已存在");
  });

  it("全链 register pass：review → approve → execute → official 条目 + 提案 stage=executed", async () => {
    const store = makeStore();
    const r = await fullPassChain(store, { action: "register", spec: demoSpec(), rationale: "tool-function 晋升" });
    expect(r.ok).toBe(true);
    const entry = store.rows.get(`tool:util_parse_log`)!;
    expect(entry.status).toBe("official");
    expect(entry.meta).toMatchObject({ registeredBy: "controller:tool-face", promotedFrom: "tool-function:parseLogTimestamp" });
    expect(entry.meta.proposalId).toBe(r.proposalId);
    expect(store.rows.get(r.proposalId!)!.meta.stage).toBe("executed");
  });

  it("revise 必须版本递增 + promotedFrom 链自动承继（不可变语义）", async () => {
    const store = makeStore([regRow(demoSpec())]);
    // version 不递增 → 提案阶段即拒
    const bad = await proposeToolRegistration(store as never, { action: "revise", name: demoSpec().name, spec: demoSpec() });
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain("递增");
    const v2 = { ...demoSpec(), version: 2, description: { ...demoSpec().description, effect: "修订后的效果" } };
    const r = await fullPassChain(store, { action: "revise", spec: v2, rationale: "描述修订" });
    expect(r.ok).toBe(true);
    const entry = store.rows.get(`tool:util_parse_log`)!;
    expect(entry.meta.version).toBe(2);
    expect(entry.meta.promotedFrom).toBe("tool-function:parseLogTimestamp");   // 未显式携带时从现条目承继
    expect(entry.content).toContain("修订后的效果");
  });

  it("对抗性审核：reject 后监督不可批准；未经 pass 审核也不可批准", async () => {
    const store = makeStore();
    const p = await proposeToolRegistration(store as never, { action: "register", name: demoSpec().name, spec: demoSpec() });
    const reject = await reviewToolProposal(store as never, p.id!, "reject", "执行体可绕过预算守卫");
    expect(reject.ok).toBe(false);
    expect((await approveToolProposal(store as never, p.id!)).ok).toBe(false);
    // 未审核直接批准 → 拒绝
    const p2 = await proposeToolRegistration(store as never, { action: "register", name: "util_other_tool", spec: demoSpec({ name: "util_other_tool", promotedFrom: "tool-function:x" }) });
    expect((await approveToolProposal(store as never, p2.id!)).ok).toBe(false);
    // 状态越位：已 official 的提案不可再次审核
    const p3 = await proposeToolRegistration(store as never, { action: "register", name: "util_third", spec: demoSpec({ name: "util_third", promotedFrom: "tool-function:y" }) });
    await reviewToolProposal(store as never, p3.id!, "pass");
    await approveToolProposal(store as never, p3.id!);
    expect((await reviewToolProposal(store as never, p3.id!, "pass")).ok).toBe(false);
  });

  it("execute 防线：未批准/非法 spec 不落库", async () => {
    const store = makeStore();
    const p = await proposeToolRegistration(store as never, { action: "register", name: demoSpec().name, spec: demoSpec() });
    expect((await executeApprovedToolProposal(store as never, p.id!)).ok).toBe(false);   // 未批准
    // 篡改提案 spec（模拟绕过）→ 执行阶段拒绝
    await reviewToolProposal(store as never, p.id!, "pass");
    await approveToolProposal(store as never, p.id!);
    const row = store.rows.get(p.id!)!;
    row.content = JSON.stringify({ action: "register", name: "util_parse_log", spec: demoSpec({ visibility: { roles: [], pack: "util" } }) });
    const r = await executeApprovedToolProposal(store as never, p.id!);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("spec 非法");
    // 篡改 action（register/revise 之外的越位值）→ 执行阶段拒绝
    row.content = JSON.stringify({ action: "delete", name: "util_parse_log", spec: demoSpec() });
    const r2 = await executeApprovedToolProposal(store as never, p.id!);
    expect(r2.ok).toBe(false);
    expect(r2.error).toContain("暂不支持");
  });
});
