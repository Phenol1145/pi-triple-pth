import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  PROVENANCE_REQUIRED_KINDS,
  buildKnowledgeProvenance,
  contentHashOf,
  intakeEvidenceReferencesFromMeta,
  isIntakeEvidenceReferenceShape,
  knowledgeEvidenceRefsFromMeta,
  parseIntakeEvidenceReference,
  validateIntakeEvidenceReference,
  validateIntakeEvidenceReferences,
  validateKnowledgeEvidenceRefs,
  validateKnowledgeProvenance,
} from "@away_from/pth-memory";

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function validMeta(content: string): Record<string, unknown> {
  return buildKnowledgeProvenance({
    content,
    sourceTaskId: "t1",
    producerRole: "developer",
    producerModel: "deepseek-v4-flash",
    sourceRefs: ["task:t1"],
  }) as unknown as Record<string, unknown>;
}

describe("knowledge-provenance", () => {
  it("PROVENANCE_REQUIRED_KINDS = domain-fact / domain-method", () => {
    expect(PROVENANCE_REQUIRED_KINDS).toEqual(new Set(["domain-fact", "domain-method"]));
  });

  it("contentHashOf 返回 node:crypto sha256 hex（64 位）", () => {
    const h = contentHashOf("hello");
    expect(h).toBe(sha256("hello"));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("buildKnowledgeProvenance 六字段齐全 + createdAt 默认", () => {
    const p = buildKnowledgeProvenance({
      content: "x",
      sourceTaskId: "t1",
      producerRole: "developer",
      producerModel: "deepseek-v4-flash",
      sourceRefs: ["task:t1"],
    });
    expect(p).toEqual({
      sourceTaskId: "t1",
      producerRole: "developer",
      producerModel: "deepseek-v4-flash",
      sourceRefs: ["task:t1"],
      contentHash: contentHashOf("x"),
      createdAt: expect.any(Number) as number,
    });
  });

  it("buildKnowledgeProvenance 尊重显式 createdAt", () => {
    const p = buildKnowledgeProvenance({
      content: "x",
      sourceTaskId: "t1",
      producerRole: "developer",
      producerModel: "m",
      sourceRefs: ["a"],
      createdAt: 123,
    });
    expect(p.createdAt).toBe(123);
  });

  it("validate 合法 provenance → ok:true 且返回同值", () => {
    const content = "domain fact";
    const r = validateKnowledgeProvenance(validMeta(content), content);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.provenance.contentHash).toBe(contentHashOf(content));
      expect(r.provenance.sourceRefs).toEqual(["task:t1"]);
    }
  });

  it("validate 拒绝：六字段缺失", () => {
    const content = "x";
    const p = validMeta(content) as Record<string, unknown>;
    for (const key of ["sourceTaskId", "producerRole", "producerModel", "sourceRefs", "contentHash", "createdAt"]) {
      const meta = { ...p };
      delete meta[key];
      const r = validateKnowledgeProvenance(meta, content);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain(key);
    }
  });

  it("validate 拒绝：meta 非对象 / 字段类型错误", () => {
    expect(validateKnowledgeProvenance(null, "x").ok).toBe(false);
    expect(validateKnowledgeProvenance("x", "x").ok).toBe(false);
    const p = validMeta("x") as Record<string, unknown>;
    expect(validateKnowledgeProvenance({ ...p, sourceTaskId: 1 }, "x").ok).toBe(false);
    expect(validateKnowledgeProvenance({ ...p, producerRole: null }, "x").ok).toBe(false);
    expect(validateKnowledgeProvenance({ ...p, producerModel: 3 }, "x").ok).toBe(false);
    expect(validateKnowledgeProvenance({ ...p, createdAt: "now" }, "x").ok).toBe(false);
  });

  it("validate 拒绝：sourceRefs 空数组 / 含空字符串 / 非字符串", () => {
    const p = validMeta("x") as Record<string, unknown>;
    expect(validateKnowledgeProvenance({ ...p, sourceRefs: [] }, "x").ok).toBe(false);
    expect(validateKnowledgeProvenance({ ...p, sourceRefs: [""] }, "x").ok).toBe(false);
    expect(validateKnowledgeProvenance({ ...p, sourceRefs: ["a", 2] }, "x").ok).toBe(false);
    expect(validateKnowledgeProvenance({ ...p, sourceRefs: "a" }, "x").ok).toBe(false);
  });

  it("validate 拒绝：contentHash 非 64 位 hex / 与 content 不一致", () => {
    const p = validMeta("x") as Record<string, unknown>;
    expect(validateKnowledgeProvenance({ ...p, contentHash: "abcd" }, "x").ok).toBe(false);
    expect(validateKnowledgeProvenance({ ...p, contentHash: "z".repeat(64) }, "x").ok).toBe(false);
    expect(validateKnowledgeProvenance({ ...p, contentHash: contentHashOf("other") }, "x").ok).toBe(false);
  });
});

describe("IntakeEvidenceReference（N29 Task 5：精确外部信源引用）", () => {
  const valid = {
    sourceSubscriptionId: "sub-1",
    sourceRevisionId: "rev-1",
    representation: "normalized-text" as const,
    locator: { start: 12, end: 40 },
    quoteHash: "a".repeat(64),
    artifactHash: "b".repeat(64),
    policyDecisionDigest: "c".repeat(64),
  };

  it("接受完整合法引用（parse 与 validate 一致）", () => {
    expect(validateIntakeEvidenceReference(valid)).toEqual({ ok: true, ref: valid });
    expect(parseIntakeEvidenceReference(valid)).toEqual(valid);
    expect(isIntakeEvidenceReferenceShape(valid)).toBe(true);
  });

  it("拒绝：非对象 / 数组", () => {
    for (const bad of [null, undefined, "x", 1, [valid]]) {
      expect(validateIntakeEvidenceReference(bad).ok).toBe(false);
      expect(parseIntakeEvidenceReference(bad)).toBeUndefined();
    }
  });

  it("拒绝：缺字段 / 空字符串 id", () => {
    for (const key of ["sourceSubscriptionId", "sourceRevisionId", "representation", "locator", "quoteHash", "artifactHash", "policyDecisionDigest"] as const) {
      const missing: Record<string, unknown> = { ...valid };
      delete missing[key];
      const r = validateIntakeEvidenceReference(missing);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain(key === "locator" ? "locator" : key);
    }
    expect(validateIntakeEvidenceReference({ ...valid, sourceRevisionId: "  " }).ok).toBe(false);
    expect(validateIntakeEvidenceReference({ ...valid, sourceSubscriptionId: 1 }).ok).toBe(false);
  });

  it("拒绝：错误 representation 类型", () => {
    for (const representation of ["raw-bytes", "normalized_text", "", 1, null]) {
      const r = validateIntakeEvidenceReference({ ...valid, representation });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("representation");
    }
  });

  it("拒绝：非法 locator（非对象 / 负数 / 非整数 / end <= start / 越界形状）", () => {
    for (const locator of [
      "0-10",
      [0, 10],
      { start: -1, end: 10 },
      { start: 1.5, end: 10 },
      { start: 10, end: 10 },
      { start: 10, end: 3 },
      { start: 0 },
      { end: 10 },
    ]) {
      const r = validateIntakeEvidenceReference({ ...valid, locator });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("locator");
    }
  });

  it("拒绝：非 64 位小写 hex 摘要", () => {
    for (const key of ["quoteHash", "artifactHash", "policyDecisionDigest"] as const) {
      for (const bad of ["", "abcd", "A".repeat(64), "z".repeat(64), "a".repeat(63), 1]) {
        const r = validateIntakeEvidenceReference({ ...valid, [key]: bad });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toContain(key);
      }
    }
  });

  it("数组校验：空数组与含非法项一律拒绝", () => {
    expect(validateIntakeEvidenceReferences([]).ok).toBe(false);
    expect(validateIntakeEvidenceReferences("x").ok).toBe(false);
    expect(validateIntakeEvidenceReferences([valid, { ...valid, quoteHash: "bad" }]).ok).toBe(false);
    const ok = validateIntakeEvidenceReferences([valid]);
    expect(ok).toEqual({ ok: true, refs: [valid] });
  });

  it("读侧：meta.evidence 中的精确引用可取出；非法项被跳过", () => {
    expect(intakeEvidenceReferencesFromMeta({ evidence: [valid, { sourceId: "x", locator: "y" }] })).toEqual([valid]);
    expect(intakeEvidenceReferencesFromMeta({})).toEqual([]);
    expect(intakeEvidenceReferencesFromMeta(null)).toEqual([]);
  });

  it("旧读侧兼容：validateKnowledgeEvidenceRefs 把精确引用投影为 KnowledgeEvidenceRef", () => {
    const projected = validateKnowledgeEvidenceRefs([valid]);
    expect(projected).toEqual({
      ok: true,
      refs: [{
        sourceId: "rev-1",
        locator: "normalized-text[12,40)",
        sourceVersion: "rev-1",
        artifactHash: "b".repeat(64),
        quoteHash: "a".repeat(64),
      }],
    });
    // Broker/Context 读侧形状不变（旧字符串 locator 引用照旧通过）。
    expect(knowledgeEvidenceRefsFromMeta({ evidence: [{ sourceId: "s", locator: "l" }] }))
      .toEqual([{ sourceId: "s", locator: "l" }]);
  });
});
