/**
 * knowledge-verdicts.ts — K4 Phase 4（N22 1）：候选验证 verdict 契约与纯函数。
 *
 * draft 知识候选必须取得领域 verdict + 对抗 verdict 后，由 memory-keeper 受控晋升 official；
 * 生产者不能核验自己的候选；每次晋升留痕可反查。
 */

import { validateKnowledgeProvenance, type MemoryEntry } from "@away_from/pth-memory";

export type KnowledgeVerdictKind = "domain" | "adversarial";

export interface KnowledgeVerdict {
  kind: KnowledgeVerdictKind;
  verdict: "pass" | "reject";
  /** domain:<id> 或 controller:adversarial 或 memory-keeper */
  reviewerRole: string;
  /** 非空 */
  note: string;
  at: number;
  /** F3：签发主体（HTTP 取自 auth，能力面取自 worker 身份；不可伪造） */
  principalId?: string;
  /** F3：执行上下文（task/run id，HTTP 可缺省） */
  executionId?: string;
  /** F3：审核时 entry.meta.version（服务端自动补——调用方不可覆盖） */
  candidateRevision?: number;
  /** F3：domain 类 verdict 必填；adversarial 不填 */
  domainId?: string;
  /** F3：可选证据——字符串数组且元素非空 */
  evidence?: string[];
}

/** verdict 字段校验（纯函数，不依赖 store）。 */
export function validateKnowledgeVerdict(
  v: unknown,
): { ok: true; verdict: KnowledgeVerdict } | { ok: false; error: string } {
  if (typeof v !== "object" || v === null) {
    return { ok: false, error: "verdict must be an object" };
  }
  const o = v as Record<string, unknown>;
  if (o.kind !== "domain" && o.kind !== "adversarial") {
    return { ok: false, error: 'kind must be "domain" | "adversarial"' };
  }
  if (o.verdict !== "pass" && o.verdict !== "reject") {
    return { ok: false, error: 'verdict must be "pass" | "reject"' };
  }
  if (typeof o.reviewerRole !== "string" || o.reviewerRole.trim() === "") {
    return { ok: false, error: "reviewerRole must be a non-empty string" };
  }
  if (typeof o.note !== "string" || o.note.trim() === "") {
    return { ok: false, error: "note must be a non-empty string" };
  }
  if (typeof o.at !== "number" || !Number.isFinite(o.at)) {
    return { ok: false, error: "at must be a finite number" };
  }
  // F3：optional 字段形状校验（缺省合法；提供则必须符合形状）
  if (o.principalId !== undefined && (typeof o.principalId !== "string" || o.principalId.trim() === "")) {
    return { ok: false, error: "principalId must be a non-empty string when provided" };
  }
  if (o.executionId !== undefined && (typeof o.executionId !== "string" || o.executionId.trim() === "")) {
    return { ok: false, error: "executionId must be a non-empty string when provided" };
  }
  if (o.candidateRevision !== undefined && (typeof o.candidateRevision !== "number" || !Number.isFinite(o.candidateRevision))) {
    return { ok: false, error: "candidateRevision must be a finite number when provided" };
  }
  if (o.domainId !== undefined && (typeof o.domainId !== "string" || o.domainId.trim() === "")) {
    return { ok: false, error: "domainId must be a non-empty string when provided" };
  }
  if (o.evidence !== undefined && (!Array.isArray(o.evidence) || o.evidence.some((e) => typeof e !== "string" || e.trim() === ""))) {
    return { ok: false, error: "evidence must be an array of non-empty strings when provided" };
  }
  // F3：domain verdict 必须带 domainId（adversarial 不填 domainId）
  if (o.kind === "domain" && (typeof o.domainId !== "string" || o.domainId.trim() === "")) {
    return { ok: false, error: "domain verdict requires domainId" };
  }
  return {
    ok: true,
    verdict: {
      kind: o.kind,
      verdict: o.verdict,
      reviewerRole: o.reviewerRole,
      note: o.note,
      at: o.at,
      ...(o.principalId !== undefined ? { principalId: o.principalId } : {}),
      ...(o.executionId !== undefined ? { executionId: o.executionId } : {}),
      ...(o.candidateRevision !== undefined ? { candidateRevision: o.candidateRevision } : {}),
      ...(o.domainId !== undefined ? { domainId: o.domainId } : {}),
      ...(o.evidence !== undefined ? { evidence: o.evidence } : {}),
    },
  };
}

/**
 * 晋升门禁（fail-closed）：
 * - status === draft；
 * - meta.provenance 存在且 validateKnowledgeProvenance(meta.provenance, content) ok；
 * - meta.verdicts 含至少一条 domain pass 与一条 adversarial pass，且无 reject；
 * - pass domain verdict 必须有 principalId 与 domainId；adversarial 必须有 principalId；
 * - 任一 pass principalId === provenance.producerRole → 拒；
 * - domain/adversarial principal 相同 → 拒；
 * - 每条 pass 必须携带 candidateRevision，且不得晚于 entry.meta.version。
 */
export function canPromote(entry: MemoryEntry): { ok: true } | { ok: false; reason: string } {
  if (entry.status !== "draft") {
    return { ok: false, reason: "status must be draft" };
  }

  const meta = entry.meta;
  if (typeof meta !== "object" || meta === null) {
    return { ok: false, reason: "meta must be an object" };
  }

  const provenance = validateKnowledgeProvenance(meta["provenance"], entry.content);
  if (!provenance.ok) {
    return { ok: false, reason: `provenance invalid: ${provenance.error}` };
  }

  const verdicts = meta["verdicts"];
  if (!Array.isArray(verdicts)) {
    return { ok: false, reason: "meta.verdicts must be an array" };
  }

  const passVerdicts: KnowledgeVerdict[] = [];
  for (const raw of verdicts) {
    const checked = validateKnowledgeVerdict(raw);
    if (!checked.ok) {
      return { ok: false, reason: `invalid verdict: ${checked.error}` };
    }
    if (checked.verdict.verdict === "reject") {
      return { ok: false, reason: "verdicts must not contain reject" };
    }
    passVerdicts.push(checked.verdict);
  }

  const domainPasses = passVerdicts.filter((v) => v.kind === "domain");
  const adversarialPasses = passVerdicts.filter((v) => v.kind === "adversarial");

  if (domainPasses.length === 0) {
    return { ok: false, reason: "missing domain pass verdict" };
  }
  if (adversarialPasses.length === 0) {
    return { ok: false, reason: "missing adversarial pass verdict" };
  }

  // F3：签发主体必填（validate 已保证 domain pass 有 domainId，但 principalId 仍是 optional）
  for (const pass of domainPasses) {
    if (typeof pass.principalId !== "string" || pass.principalId.trim() === "") {
      return { ok: false, reason: "domain pass verdict requires principalId" };
    }
  }
  for (const pass of adversarialPasses) {
    if (typeof pass.principalId !== "string" || pass.principalId.trim() === "") {
      return { ok: false, reason: "adversarial pass verdict requires principalId" };
    }
  }

  const producerRole = provenance.provenance.producerRole;
  for (const pass of passVerdicts) {
    if (pass.principalId === producerRole) {
      return { ok: false, reason: "producer cannot review own knowledge" };
    }
  }

  const domainPrincipals = new Set(domainPasses.map((v) => v.principalId as string));
  const adversarialPrincipals = new Set(adversarialPasses.map((v) => v.principalId as string));
  for (const domainPrincipal of domainPrincipals) {
    if (adversarialPrincipals.has(domainPrincipal)) {
      return { ok: false, reason: "domain and adversarial principals must differ" };
    }
  }

  // F3：每条 pass 必须携带 candidateRevision，且不得晚于当前 entry.meta.version。
  // 说明：recordKnowledgeVerdict 在写入时已把 candidateRevision 盖成当时的 entry.meta.version；
  // PgMemoryStore.update 每追加一条 verdict 会 version+1（F1 revision 语义），因此多条 verdict
  // 的 candidateRevision 可能小于晋升时的当前 version——纯函数这里只能 fail-closed 拒绝
  // “未来版本/缺失值”，相等性由 service 盖章保证。
  const version = meta["version"];
  if (typeof version !== "number" || !Number.isFinite(version)) {
    return { ok: false, reason: "meta.version must be a finite number" };
  }
  for (const pass of passVerdicts) {
    if (typeof pass.candidateRevision !== "number" || !Number.isFinite(pass.candidateRevision)) {
      return { ok: false, reason: "pass verdict requires candidateRevision" };
    }
    if (pass.candidateRevision > version) {
      return { ok: false, reason: "candidateRevision must not exceed entry.meta.version" };
    }
  }

  return { ok: true };
}
