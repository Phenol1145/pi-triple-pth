import { createHash } from "node:crypto";

/** 官方领域知识强制 provenance 的 kind 白名单（N19 Phase 1b 设计 1.1）。 */
export const PROVENANCE_REQUIRED_KINDS: ReadonlySet<string> = new Set(["domain-fact", "domain-method"]);

/**
 * N29 再验收 P0-5（feedback §3 P0-5 / §8 条件 6）：受 **official 写授权** 约束的 kind 集合。
 *
 * 背景：报告的 PostgreSQL 探针用 `kind="task-insight" + status="official"` 经 raw
 * `PgMemoryStore.write()` 直接写出了 official 知识——因为 official authority 当时只挂在
 * `PROVENANCE_REQUIRED_KINDS`（domain-fact / domain-method）上。
 *
 * 判据 = "会被当作权威知识消费"的 knowledge 层 kind：
 *  - `domain-fact` / `domain-method`：Broker / KnowledgeContext 的领域知识面；
 *  - `task-insight`：worker capability 的经验/洞察面（`memory.recall` 固定 status=official）；
 *  - `tool-function`：authorized state reads 的工具函数面（同样固定 status=official）。
 *
 * 不在集合内的 knowledge 层 kind（`task-scorecard*` 等度量/日志类）不是权威知识消费面；
 * `skill*` / `role-doc*` / `tool-reg` 属 prompt 层，另有 isSystemDocId + 治理流保护。
 *
 * 集合内的 kind 以 official 落库（write / update / incrementAggregate / markStale）时
 * 必须出示 `KnowledgeOfficialAuthority`；缺省一律 fail closed。
 */
export const OFFICIAL_KNOWLEDGE_GATED_KINDS: ReadonlySet<string> = new Set([
  ...PROVENANCE_REQUIRED_KINDS,
  "task-insight",
  "tool-function",
]);

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

/**
 * 结构化来源工件引用（R5/P1-4）：从 DB meta.evidence → Broker → Context → Candidate →
 * VerificationPlan → promotion 全链保持同一形状。provenance 管来源任务，evidence 管来源工件。
 */
export interface KnowledgeEvidenceRef {
  sourceId: string;
  locator: string;
  sourceVersion?: string;
  artifactHash?: string;
  quoteHash?: string;
}

/**
 * N29 Task 5：外部信源摄入的**精确** Evidence Reference。
 *
 * 与 `KnowledgeEvidenceRef`（K5 内部任务产物引用）的分工：
 *  - `KnowledgeEvidenceRef` 是可读的来源工件引用（locator 为自由字符串）；
 *  - `IntakeEvidenceReference` 是可回放的外部信源引用：representation 固定
 *    `normalized-text`，locator 是归一化表示上的半开区间 `[start,end)`，
 *    quote/artifact/policy 三个摘要都由**服务端**从已落库 SourceRevision 重算得出。
 *
 * 形状与 `src/pth/contracts/knowledge-intake.ts` 的同名类型逐字段一致（结构等价）；
 * 本包不 import PTH core，故在此独立声明（写侧/读侧校验必须能在 memory 包内完成）。
 */
export interface IntakeEvidenceReference {
  sourceSubscriptionId: string;
  sourceRevisionId: string;
  representation: "normalized-text";
  locator: { start: number; end: number };
  /** sha256(normalizedText.slice(start,end)) hex（64 位小写） */
  quoteHash: string;
  /** sha256(raw bytes) hex（64 位小写） */
  artifactHash: string;
  /** sha256(stableJson({fetch,use,artifactHash,normalizedTextHash})) hex（64 位小写） */
  policyDecisionDigest: string;
}

const HEX64 = /^[0-9a-f]{64}$/;

function isHex64(v: unknown): v is string {
  return typeof v === "string" && HEX64.test(v);
}

function isNonEmptyStr(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

/**
 * 严格校验单条 IntakeEvidenceReference（写侧 fail closed）。
 * 缺字段、非 64-hex 摘要、非法 locator、错误 representation 一律拒绝。
 */
export function validateIntakeEvidenceReference(
  value: unknown,
): { ok: true; ref: IntakeEvidenceReference } | { ok: false; error: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: "intake evidence reference must be an object" };
  }
  const r = value as Record<string, unknown>;

  if (!isNonEmptyStr(r["sourceSubscriptionId"])) {
    return { ok: false, error: "intake evidence sourceSubscriptionId must be a non-empty string" };
  }
  if (!isNonEmptyStr(r["sourceRevisionId"])) {
    return { ok: false, error: "intake evidence sourceRevisionId must be a non-empty string" };
  }
  if (r["representation"] !== "normalized-text") {
    return {
      ok: false,
      error: `intake evidence representation must be "normalized-text" (got ${JSON.stringify(r["representation"]) ?? "undefined"})`,
    };
  }

  const locator = r["locator"];
  if (typeof locator !== "object" || locator === null || Array.isArray(locator)) {
    return { ok: false, error: "intake evidence locator must be an object { start, end }" };
  }
  const { start, end } = locator as Record<string, unknown>;
  if (typeof start !== "number" || !Number.isSafeInteger(start) || start < 0) {
    return { ok: false, error: "intake evidence locator.start must be a non-negative safe integer" };
  }
  if (typeof end !== "number" || !Number.isSafeInteger(end)) {
    return { ok: false, error: "intake evidence locator.end must be a safe integer" };
  }
  if (end <= start) {
    return { ok: false, error: `intake evidence locator must be a non-empty half-open range (start=${start}, end=${end})` };
  }

  for (const key of ["quoteHash", "artifactHash", "policyDecisionDigest"] as const) {
    if (!isHex64(r[key])) {
      return { ok: false, error: `intake evidence ${key} must be a 64-char lowercase hex sha256` };
    }
  }

  return {
    ok: true,
    ref: {
      sourceSubscriptionId: r["sourceSubscriptionId"],
      sourceRevisionId: r["sourceRevisionId"],
      representation: "normalized-text",
      locator: { start, end },
      quoteHash: r["quoteHash"] as string,
      artifactHash: r["artifactHash"] as string,
      policyDecisionDigest: r["policyDecisionDigest"] as string,
    },
  };
}

/** 读侧宽松解析：非法/缺失返回 undefined（不伪装成合法引用）。 */
export function parseIntakeEvidenceReference(value: unknown): IntakeEvidenceReference | undefined {
  const checked = validateIntakeEvidenceReference(value);
  return checked.ok ? checked.ref : undefined;
}

/** 严格校验 IntakeEvidenceReference 数组；空数组即拒绝（N29 official 必须有非空 evidence）。 */
export function validateIntakeEvidenceReferences(
  value: unknown,
): { ok: true; refs: IntakeEvidenceReference[] } | { ok: false; error: string } {
  if (!Array.isArray(value)) {
    return { ok: false, error: "intake evidence must be an array" };
  }
  if (value.length === 0) {
    return { ok: false, error: "intake evidence must contain at least one reference" };
  }
  const refs: IntakeEvidenceReference[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const checked = validateIntakeEvidenceReference(value[i]);
    if (!checked.ok) return { ok: false, error: `evidence[${i}]: ${checked.error}` };
    refs.push(checked.ref);
  }
  return { ok: true, refs };
}

/** 结构判别（不判授权）：该值是否为合法 N29 IntakeEvidenceReference。 */
export function isIntakeEvidenceReferenceShape(value: unknown): boolean {
  return validateIntakeEvidenceReference(value).ok;
}

/** 读侧：从 meta.evidence 取 N29 精确引用；缺失/非法项被跳过。 */
export function intakeEvidenceReferencesFromMeta(meta: unknown): IntakeEvidenceReference[] {
  if (typeof meta !== "object" || meta === null) return [];
  const raw = (meta as Record<string, unknown>)["evidence"];
  if (!Array.isArray(raw)) return [];
  const out: IntakeEvidenceReference[] = [];
  for (const item of raw) {
    const ref = parseIntakeEvidenceReference(item);
    if (ref) out.push(ref);
  }
  return out;
}

/** N29 精确引用 → 旧 KnowledgeEvidenceRef 投影（Broker/Context 读侧形状不变）。 */
export function intakeEvidenceRefToKnowledgeEvidenceRef(ref: IntakeEvidenceReference): KnowledgeEvidenceRef {
  return {
    sourceId: ref.sourceRevisionId,
    locator: `${ref.representation}[${ref.locator.start},${ref.locator.end})`,
    sourceVersion: ref.sourceRevisionId,
    artifactHash: ref.artifactHash,
    quoteHash: ref.quoteHash,
  };
}

/**
 * 校验 meta.evidence 是否为合法 KnowledgeEvidenceRef 数组（写侧 seed/refiner draft 共用）。
 * N29：元素也可以是 `IntakeEvidenceReference`——此时投影为等价 KnowledgeEvidenceRef
 * （读侧 Broker/Context 形状不变；精确引用请用 `validateIntakeEvidenceReferences`）。
 */
export function validateKnowledgeEvidenceRefs(
  value: unknown,
): { ok: true; refs: KnowledgeEvidenceRef[] } | { ok: false; error: string } {
  if (!Array.isArray(value)) {
    return { ok: false, error: "evidence must be an array" };
  }
  const refs: KnowledgeEvidenceRef[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const item = value[i];
    if (typeof item !== "object" || item === null) {
      return { ok: false, error: `evidence[${i}] must be an object` };
    }
    const intake = parseIntakeEvidenceReference(item);
    if (intake) {
      refs.push(intakeEvidenceRefToKnowledgeEvidenceRef(intake));
      continue;
    }
    const r = item as Record<string, unknown>;
    if (typeof r["sourceId"] !== "string" || r["sourceId"].trim() === "") {
      return { ok: false, error: `evidence[${i}].sourceId must be a non-empty string` };
    }
    if (typeof r["locator"] !== "string" || r["locator"].trim() === "") {
      return { ok: false, error: `evidence[${i}].locator must be a non-empty string` };
    }
    const optionalStrings: Array<keyof KnowledgeEvidenceRef> = ["sourceVersion", "artifactHash", "quoteHash"];
    for (const key of optionalStrings) {
      if (r[key] !== undefined && (typeof r[key] !== "string" || r[key].trim() === "")) {
        return { ok: false, error: `evidence[${i}].${key} must be a non-empty string when provided` };
      }
    }
    const sourceVersion = r["sourceVersion"] as string | undefined;
    const artifactHash = r["artifactHash"] as string | undefined;
    const quoteHash = r["quoteHash"] as string | undefined;
    refs.push({
      sourceId: r["sourceId"] as string,
      locator: r["locator"] as string,
      ...(sourceVersion !== undefined ? { sourceVersion } : {}),
      ...(artifactHash !== undefined ? { artifactHash } : {}),
      ...(quoteHash !== undefined ? { quoteHash } : {}),
    });
  }
  return { ok: true, refs };
}

/** 读侧（Context/Broker）：从 meta 读取结构化 evidence；缺失/非法一律空数组（不伪装 provenance）。 */
export function knowledgeEvidenceRefsFromMeta(meta: unknown): KnowledgeEvidenceRef[] {
  if (typeof meta !== "object" || meta === null) return [];
  const checked = validateKnowledgeEvidenceRefs((meta as Record<string, unknown>)["evidence"]);
  return checked.ok ? checked.refs : [];
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
