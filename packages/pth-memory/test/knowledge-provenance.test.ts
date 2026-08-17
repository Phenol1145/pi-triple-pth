import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  PROVENANCE_REQUIRED_KINDS,
  buildKnowledgeProvenance,
  contentHashOf,
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
