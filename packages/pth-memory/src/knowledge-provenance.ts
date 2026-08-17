import { createHash } from "node:crypto";

/** 官方领域知识强制 provenance 的 kind 白名单（N19 Phase 1b 设计 1.1）。 */
export const PROVENANCE_REQUIRED_KINDS: ReadonlySet<string> = new Set(["domain-fact", "domain-method"]);

/** 知识来源证明（写入 meta.provenance 的六字段契约）。 */
export interface KnowledgeProvenance {
  sourceTaskId: string;
  producerRole: string;
  producerModel: string;
  /** 至少 1 条非空字符串 */
  sourceRefs: string[];
  /** sha256(content) hex（64 位） */
  contentHash: string;
  createdAt: number;
}

/** node:crypto sha256 hex（64 位小写）。 */
export function contentHashOf(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** 构造 provenance（createdAt 缺省 Date.now()）。 */
export function buildKnowledgeProvenance(args: {
  content: string;
  sourceTaskId: string;
  producerRole: string;
  producerModel: string;
  sourceRefs: string[];
  createdAt?: number;
}): KnowledgeProvenance {
  return {
    sourceTaskId: args.sourceTaskId,
    producerRole: args.producerRole,
    producerModel: args.producerModel,
    sourceRefs: args.sourceRefs,
    contentHash: contentHashOf(args.content),
    createdAt: args.createdAt ?? Date.now(),
  };
}

/** 从 meta 读取嵌套 provenance（canonical 位置 = meta.provenance）；缺失/非对象返回 undefined。 */
export function provenanceFromMeta(meta: unknown): KnowledgeProvenance | undefined {
  if (typeof meta !== "object" || meta === null) return undefined;
  const nested = (meta as Record<string, unknown>)["provenance"];
  if (typeof nested !== "object" || nested === null) return undefined;
  const required: Array<keyof KnowledgeProvenance> = [
    "sourceTaskId",
    "producerRole",
    "producerModel",
    "sourceRefs",
    "contentHash",
    "createdAt",
  ];
  const p = nested as Record<string, unknown>;
  for (const key of required) {
    if (p[key] === undefined) return undefined;
  }
  return nested as KnowledgeProvenance;
}

/** 校验 meta 是否为合法 KnowledgeProvenance 且哈希与 content 一致。 */
export function validateKnowledgeProvenance(
  meta: unknown,
  content: string,
): { ok: true; provenance: KnowledgeProvenance } | { ok: false; error: string } {
  if (typeof meta !== "object" || meta === null) {
    return { ok: false, error: "meta must be an object" };
  }
  const m = meta as Record<string, unknown>;

  const required: Array<keyof KnowledgeProvenance> = [
    "sourceTaskId",
    "producerRole",
    "producerModel",
    "sourceRefs",
    "contentHash",
    "createdAt",
  ];
  for (const key of required) {
    if (m[key] === undefined) {
      return { ok: false, error: `provenance.${key} is required` };
    }
  }

  if (typeof m.sourceTaskId !== "string") {
    return { ok: false, error: "provenance.sourceTaskId must be a string" };
  }
  if (typeof m.producerRole !== "string") {
    return { ok: false, error: "provenance.producerRole must be a string" };
  }
  if (typeof m.producerModel !== "string") {
    return { ok: false, error: "provenance.producerModel must be a string" };
  }
  if (typeof m.createdAt !== "number") {
    return { ok: false, error: "provenance.createdAt must be a number" };
  }

  if (!Array.isArray(m.sourceRefs) || m.sourceRefs.length === 0) {
    return { ok: false, error: "provenance.sourceRefs must be a non-empty array of strings" };
  }
  if (!(m.sourceRefs as unknown[]).every((r) => typeof r === "string" && r.length > 0)) {
    return { ok: false, error: "provenance.sourceRefs must contain only non-empty strings" };
  }

  if (typeof m.contentHash !== "string" || !/^[0-9a-f]{64}$/.test(m.contentHash)) {
    return { ok: false, error: "provenance.contentHash must be a 64-char hex sha256" };
  }
  if (m.contentHash !== contentHashOf(content)) {
    return { ok: false, error: "provenance.contentHash does not match content" };
  }

  return {
    ok: true,
    provenance: {
      sourceTaskId: m.sourceTaskId,
      producerRole: m.producerRole,
      producerModel: m.producerModel,
      sourceRefs: m.sourceRefs as string[],
      contentHash: m.contentHash,
      createdAt: m.createdAt,
    },
  };
}
