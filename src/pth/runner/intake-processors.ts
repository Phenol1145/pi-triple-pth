/**
 * runner/intake-processors.ts — N29 Task 5 + Task 6：extract / domain / adversarial processor adapter。
 *
 * 定位：**adapter**，不是 LLM completion 本体。真正的模型调用走既有 `LlmFn`
 * （生产链路由 AgentTaskRunner / batch handler 注入）；本文件负责
 *  1) 组装生产 prompt（plan/revision + candidate + 服务端重算的 evidence quote）；
 *  2) 用生产 result schema 校验模型输出（缺字段 / 枚举越界 / 空 note 一律拒绝）；
 *  3) 把结果映射成绑定 `runId / planId / checkId / candidateId / candidateRevision /
 *     candidateHash / principalId / executionId` 的 verdict outcome。
 *
 * 硬约束：
 *  - producer / domain reviewer / adversarial reviewer / promoter 四个 principal 必须互不相同；
 *    任意两个角色同一 principal → 直接拒绝且**不调用** LLM；
 *  - reviewer principal 必须落在对应 plan check 的 `eligiblePrincipals` 内；
 *  - 绑定字段一律由服务端盖章：模型自报的 candidateHash / principalId 等被忽略；
 *  - extract processor（Task 6）**不信任**模型自报的 locator/hash：模型只被允许回一段
 *    verbatim quote，locator / quoteHash / `IntakeEvidenceReference` 全部由服务端从已落库
 *    admitted revision 的 normalized representation 重算（`intakeEvidenceForClaim`）。
 */

import type { LlmFn, LlmMessage } from "@away_from/pth-kernel-interpreter";
import {
  intakeEvidenceForClaim,
  sha256Hex,
  validateKnowledgeVerdict,
  type KnowledgeVerdict,
  type KnowledgeVerdictKind,
  type VerificationCheckRecord,
  type VerificationPlanRecord,
} from "../execution/index.js";
import type { IntakeClaimInput, SourceRevision } from "@away_from/pth-contracts";

/** 四个职责分离的 principal（与 contracts 的 `IntakeVerificationPrincipals` 结构一致）。 */
export interface IntakeReviewPrincipals {
  readonly producer: string;
  readonly domainReviewer: string;
  readonly adversarialReviewer: string;
  readonly promoter: string;
}

export interface IntakeReviewRequest {
  /** 驱动本次核验的 IntakeRun。 */
  readonly runId: string;
  /** 本次 processor 执行的 execution id（task/run 执行上下文）。 */
  readonly executionId: string;
  readonly plan: VerificationPlanRecord;
  readonly principals: IntakeReviewPrincipals;
  /** candidate 正文（服务端从 admitted revision 重算得出）。 */
  readonly candidateContent: string;
  /** 精确 evidence 引用（只读展示，模型不得改写）。 */
  readonly evidence: readonly unknown[];
  /** 服务端从 normalized representation 重算的 quote（模型只能据此判断）。 */
  readonly evidenceQuotes: readonly string[];
  readonly model?: string;
  readonly provider?: string;
}

/** processor 产出：verdict + 全部绑定字段（recordKnowledgeVerdict 的直接输入）。 */
export interface IntakeReviewOutcome {
  readonly runId: string;
  readonly planId: string;
  readonly checkId: string;
  readonly candidateId: string;
  readonly candidateRevision: number;
  readonly candidateHash: string;
  readonly principalId: string;
  readonly executionId: string;
  readonly reviewerKind: KnowledgeVerdictKind;
  readonly verdict: KnowledgeVerdict;
  /** 模型原始输出（审计用，不参与判定）。 */
  readonly rawModelOutput: string;
  readonly model: string;
}

export type IntakeReviewResult =
  | { readonly ok: true; readonly outcome: IntakeReviewOutcome }
  | { readonly ok: false; readonly error: string };

export interface IntakeReviewProcessor {
  readonly kind: KnowledgeVerdictKind;
  review(request: IntakeReviewRequest): Promise<IntakeReviewResult>;
}

export interface IntakeReviewProcessorDeps {
  readonly llm: LlmFn;
  readonly now?: () => number;
  /** reviewerRole 覆盖（缺省 domain:<domainId> / controller:adversarial）。 */
  readonly reviewerRole?: string;
  readonly model?: string;
  readonly provider?: string;
}

const ROLE_KEYS = ["producer", "domainReviewer", "adversarialReviewer", "promoter"] as const;

/**
 * 四个角色 principal 必须互不相同（同一 principal 兼任任意两个角色 → 拒绝）。
 * 与 `assertDistinctIntakePrincipals()`（摄入侧）同一判据，此处返回结果而非抛错。
 */
export function validateIntakeReviewPrincipals(
  principals: IntakeReviewPrincipals,
): { ok: true } | { ok: false; error: string } {
  for (const key of ROLE_KEYS) {
    const value = principals?.[key];
    if (typeof value !== "string" || value.trim() === "") {
      return { ok: false, error: `principals.${key} must be a non-empty principal id` };
    }
  }
  for (let i = 0; i < ROLE_KEYS.length; i += 1) {
    for (let j = i + 1; j < ROLE_KEYS.length; j += 1) {
      const a = ROLE_KEYS[i]!;
      const b = ROLE_KEYS[j]!;
      if (principals[a] === principals[b]) {
        return {
          ok: false,
          error:
            `producer / domain reviewer / adversarial reviewer / promoter must be four distinct principals`
            + `（${a} and ${b} share the same principal ${principals[a]}）`,
        };
      }
    }
  }
  return { ok: true };
}

/** 生产 result schema：模型只被允许返回 verdict + note（其余字段由服务端盖章）。 */
export interface IntakeReviewModelResult {
  readonly verdict: "pass" | "reject";
  readonly note: string;
}

export function parseIntakeReviewModelResult(
  raw: string,
): { ok: true; result: IntakeReviewModelResult } | { ok: false; error: string } {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (text === "") return { ok: false, error: "review result is empty" };
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text);
  const body = fenced?.[1] ?? text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, error: "review result must be a JSON object" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "review result must be a JSON object" };
  }
  const o = parsed as Record<string, unknown>;
  if (o["verdict"] !== "pass" && o["verdict"] !== "reject") {
    return { ok: false, error: 'review result verdict must be "pass" | "reject"' };
  }
  if (typeof o["note"] !== "string" || o["note"].trim() === "") {
    return { ok: false, error: "review result note must be a non-empty string" };
  }
  return { ok: true, result: { verdict: o["verdict"], note: o["note"].trim() } };
}

function findCheck(plan: VerificationPlanRecord, kind: KnowledgeVerdictKind): VerificationCheckRecord | undefined {
  return plan.checks.find((c) => c.kind === kind);
}

function reviewerPrincipalOf(kind: KnowledgeVerdictKind, principals: IntakeReviewPrincipals): string {
  return kind === "domain" ? principals.domainReviewer : principals.adversarialReviewer;
}

function buildMessages(
  kind: KnowledgeVerdictKind,
  request: IntakeReviewRequest,
  check: VerificationCheckRecord,
): LlmMessage[] {
  const instruction = kind === "domain"
    ? "You are the DOMAIN reviewer. Decide whether the candidate statement is exactly supported by the quoted source span, "
      + "and whether it belongs to the declared domain."
    : "You are the ADVERSARIAL reviewer. Actively look for unsupported leaps, overreach, missing preconditions and "
      + "contradictions between the candidate statement and the quoted source span.";
  const quotes = request.evidenceQuotes.map((q, i) => `[quote ${i + 1}] ${q}`).join("\n");
  return [
    {
      role: "system",
      content:
        `${instruction}\n`
        + "Judge only from the server-recomputed quotes below; you cannot fetch anything and you cannot rewrite them.\n"
        + 'Answer with a single JSON object: {"verdict":"pass"|"reject","note":"<why, non-empty>"}.\n'
        + "Do not output any binding field (ids, hashes, principals) — the server stamps those.",
    },
    {
      role: "user",
      content:
        `check: ${check.checkId} (${check.kind}${check.domainId ? `, domain ${check.domainId}` : ""})\n`
        + `required domains: ${request.plan.requiredDomains.join(", ")}\n`
        + `candidate statement:\n${request.candidateContent}\n\n`
        + `source quotes (server-recomputed from the admitted revision):\n${quotes || "(none)"}\n\n`
        + `evidence reference count: ${request.evidence.length}`,
    },
  ];
}

function createReviewProcessor(
  kind: KnowledgeVerdictKind,
  deps: IntakeReviewProcessorDeps,
): IntakeReviewProcessor {
  const now = deps.now ?? (() => Date.now());
  return {
    kind,
    async review(request: IntakeReviewRequest): Promise<IntakeReviewResult> {
      if (!request || typeof request !== "object") {
        return { ok: false, error: "review request must be an object" };
      }
      if (typeof request.runId !== "string" || request.runId.trim() === "") {
        return { ok: false, error: "review request requires a non-empty runId" };
      }
      if (typeof request.executionId !== "string" || request.executionId.trim() === "") {
        return { ok: false, error: "review request requires a non-empty executionId" };
      }
      const plan = request.plan;
      if (!plan || typeof plan.id !== "string" || plan.id.trim() === "") {
        return { ok: false, error: "review request requires a persistent verification plan" };
      }

      // ① 职责分离先于任何 LLM 调用（零 token 成本地 fail closed）。
      const separation = validateIntakeReviewPrincipals(request.principals);
      if (!separation.ok) return separation;

      // ② plan 必须含对应 check，且 reviewer principal 必须 eligible。
      const check = findCheck(plan, kind);
      if (!check) {
        return { ok: false, error: `verification plan ${plan.id} has no ${kind} check` };
      }
      const principalId = reviewerPrincipalOf(kind, request.principals);
      if (!check.eligiblePrincipals.includes(principalId)) {
        return { ok: false, error: `principal ${principalId} is not eligible for check ${check.checkId}` };
      }
      if (kind === "domain" && (typeof check.domainId !== "string" || check.domainId.trim() === "")) {
        return { ok: false, error: `domain check ${check.checkId} is missing domainId` };
      }

      // ③ 生产 prompt + LLM（唯一被替换的缝）。
      let raw: string;
      let model: string;
      try {
        const completion = await deps.llm.complete(buildMessages(kind, request, check), {
          ...(request.model ?? deps.model ? { model: request.model ?? deps.model! } : {}),
          ...(request.provider ?? deps.provider ? { provider: request.provider ?? deps.provider! } : {}),
        });
        raw = completion.content;
        model = completion.model;
      } catch (e) {
        return { ok: false, error: `review llm call failed: ${e instanceof Error ? e.message : String(e)}` };
      }

      // ④ 生产 result schema（模型自报绑定字段被忽略）。
      const parsed = parseIntakeReviewModelResult(raw);
      if (!parsed.ok) {
        return { ok: false, error: `review result rejected: ${parsed.error}` };
      }

      const reviewerRole = deps.reviewerRole
        ?? (kind === "domain" ? `domain:${check.domainId}` : "controller:adversarial");
      const draft: KnowledgeVerdict = {
        kind,
        verdict: parsed.result.verdict,
        reviewerRole,
        note: parsed.result.note,
        at: now(),
        principalId,
        executionId: request.executionId,
        candidateRevision: plan.candidateRevision,
        ...(kind === "domain" ? { domainId: check.domainId! } : {}),
      };
      const checked = validateKnowledgeVerdict(draft);
      if (!checked.ok) {
        return { ok: false, error: `review verdict rejected: ${checked.error}` };
      }

      return {
        ok: true,
        outcome: {
          runId: request.runId,
          planId: plan.id,
          checkId: check.checkId,
          candidateId: plan.candidateId,
          candidateRevision: plan.candidateRevision,
          candidateHash: plan.candidateHash,
          principalId,
          executionId: request.executionId,
          reviewerKind: kind,
          verdict: checked.verdict,
          rawModelOutput: raw,
          model,
        },
      };
    },
  };
}

/** domain reviewer processor adapter（消费 plan 的 domain check）。 */
export function createDomainReviewProcessor(deps: IntakeReviewProcessorDeps): IntakeReviewProcessor {
  return createReviewProcessor("domain", deps);
}

/** adversarial reviewer processor adapter（消费同一 plan 的 adversarial check，不同 principal）。 */
export function createAdversarialReviewProcessor(deps: IntakeReviewProcessorDeps): IntakeReviewProcessor {
  return createReviewProcessor("adversarial", deps);
}

// ─── N29 Task 6：extract processor adapter ────────────────────────────

export interface IntakeExtractRequest {
  readonly runId: string;
  readonly executionId: string;
  readonly tenantId: string;
  readonly space: string;
  readonly domainId: string;
  /** 已落库的 admitted SourceRevision——processor 只能从它的 normalized representation 取证。 */
  readonly revision: SourceRevision;
  readonly model?: string;
  readonly provider?: string;
}

export interface IntakeExtractOutcome {
  readonly runId: string;
  readonly sourceRevisionId: string;
  /** 服务端重算后的原子 claim（含 locator / quoteHash / IntakeEvidenceReference）。 */
  readonly claims: readonly IntakeClaimInput[];
  readonly rawModelOutput: string;
  readonly model: string;
}

export type IntakeExtractResult =
  | { readonly ok: true; readonly outcome: IntakeExtractOutcome }
  | { readonly ok: false; readonly error: string };

export interface IntakeExtractProcessor {
  extract(request: IntakeExtractRequest): Promise<IntakeExtractResult>;
}

export interface IntakeExtractProcessorDeps {
  readonly llm: LlmFn;
  /**
   * 单次抽取允许的最大 claim 数。N29 首轮约束：每个 admitted revision 最多一条原子 claim
   * （plan §2 Global Constraints）。
   */
  readonly maxClaims?: number;
  /** normalized representation 送进 prompt 的最大字符数（超出截断——不影响服务端重算）。 */
  readonly maxPromptChars?: number;
  readonly model?: string;
  readonly provider?: string;
}

/** 生产 result schema：模型只被允许返回 verbatim quote，其余一律服务端重算。 */
export interface IntakeExtractModelResult {
  readonly claims: readonly { readonly quote: string }[];
}

export function parseIntakeExtractModelResult(
  raw: string,
): { ok: true; result: IntakeExtractModelResult } | { ok: false; error: string } {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (text === "") return { ok: false, error: "extract result is empty" };
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fenced?.[1] ?? text);
  } catch {
    return { ok: false, error: "extract result must be a JSON object" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "extract result must be a JSON object" };
  }
  const rawClaims = (parsed as Record<string, unknown>)["claims"];
  if (!Array.isArray(rawClaims)) {
    return { ok: false, error: "extract result requires a claims array" };
  }
  const claims: Array<{ quote: string }> = [];
  for (const [index, entry] of rawClaims.entries()) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return { ok: false, error: `claims[${index}] must be an object` };
    }
    const quote = (entry as Record<string, unknown>)["quote"];
    if (typeof quote !== "string" || quote.trim() === "") {
      return { ok: false, error: `claims[${index}].quote must be a non-empty verbatim string` };
    }
    claims.push({ quote });
  }
  return { ok: true, result: { claims } };
}

const DEFAULT_MAX_CLAIMS = 1;
const DEFAULT_MAX_PROMPT_CHARS = 8_000;

function buildExtractMessages(request: IntakeExtractRequest, representation: string, maxClaims: number): LlmMessage[] {
  return [
    {
      role: "system",
      content:
        "You are the EXTRACTOR. Extract at most "
        + `${maxClaims} atomic factual claim(s) that the source text below states explicitly.\n`
        + "You may only quote the source VERBATIM — copy an exact contiguous substring, character for character.\n"
        + 'Answer with a single JSON object: {"claims":[{"quote":"<exact substring of the source>"}]}.\n'
        + "Do not paraphrase, do not add offsets or hashes, do not output any other field — "
        + "the server recomputes the locator, the quote hash and the evidence reference itself.",
    },
    {
      role: "user",
      content:
        `domain: ${request.domainId}\nspace: ${request.space}\n`
        + `source revision: ${request.revision.id}\nfinal uri: ${request.revision.finalUri}\n\n`
        + `normalized source text:\n${representation}`,
    },
  ];
}

/**
 * extract processor adapter（N29 Task 6）。
 *
 * 服务端重算链（模型自报值只作 tripwire，永不作为真相）：
 *  1. 模型回一段 quote → `indexOf` 定位到已落库 `normalizedText`（找不到 → 拒绝）；
 *  2. quote 必须唯一定位（出现多次 → 拒绝，避免 locator 歧义）；
 *  3. `locator` / `quoteHash` 用重算结果；`evidence` 由生产 `intakeEvidenceForClaim()` 生成
 *     （它自己会校验 revision 必须 admitted 且带 allow use decision）。
 * 因此 `KnowledgeIngestor` 收到的 claim 与它自己的复算结果逐字节一致。
 */
export function createIntakeExtractProcessor(deps: IntakeExtractProcessorDeps): IntakeExtractProcessor {
  const maxClaims = deps.maxClaims ?? DEFAULT_MAX_CLAIMS;
  const maxPromptChars = deps.maxPromptChars ?? DEFAULT_MAX_PROMPT_CHARS;

  return {
    async extract(request: IntakeExtractRequest): Promise<IntakeExtractResult> {
      if (!request || typeof request !== "object") {
        return { ok: false, error: "extract request must be an object" };
      }
      for (const key of ["runId", "executionId", "tenantId", "space", "domainId"] as const) {
        if (typeof request[key] !== "string" || request[key].trim() === "") {
          return { ok: false, error: `extract request requires a non-empty ${key}` };
        }
      }
      const revision = request.revision;
      if (!revision || typeof revision.normalizedText !== "string" || revision.normalizedText.trim() === "") {
        return { ok: false, error: "extract request requires an admitted revision with a normalized representation" };
      }
      if (revision.disposition !== "admitted") {
        return { ok: false, error: `extract requires an admitted source revision (got "${revision.disposition}")` };
      }
      if (revision.tenantId !== request.tenantId) {
        return { ok: false, error: `revision tenant ${revision.tenantId} does not match request tenant ${request.tenantId}` };
      }
      // 服务端自检：正文与自身 hash 必须一致（被篡改的 representation 不得进入 extractor）。
      if (sha256Hex(revision.normalizedText) !== revision.normalizedTextHash) {
        return { ok: false, error: `source revision ${revision.id} normalized text hash does not match its text` };
      }

      let raw: string;
      let model: string;
      try {
        const completion = await deps.llm.complete(
          buildExtractMessages(request, revision.normalizedText.slice(0, maxPromptChars), maxClaims),
          {
            ...(request.model ?? deps.model ? { model: request.model ?? deps.model! } : {}),
            ...(request.provider ?? deps.provider ? { provider: request.provider ?? deps.provider! } : {}),
          },
        );
        raw = completion.content;
        model = completion.model;
      } catch (e) {
        return { ok: false, error: `extract llm call failed: ${e instanceof Error ? e.message : String(e)}` };
      }

      const parsed = parseIntakeExtractModelResult(raw);
      if (!parsed.ok) return { ok: false, error: `extract result rejected: ${parsed.error}` };
      if (parsed.result.claims.length === 0) {
        return { ok: false, error: "extract result rejected: no claim was produced" };
      }
      if (parsed.result.claims.length > maxClaims) {
        return { ok: false, error: `extract result rejected: at most ${maxClaims} claim(s) allowed per admitted revision` };
      }

      const claims: IntakeClaimInput[] = [];
      for (const [index, claim] of parsed.result.claims.entries()) {
        const start = revision.normalizedText.indexOf(claim.quote);
        if (start < 0) {
          return {
            ok: false,
            error: `extract result rejected: claims[${index}].quote is not a verbatim substring of the normalized representation`,
          };
        }
        if (revision.normalizedText.indexOf(claim.quote, start + 1) >= 0) {
          return {
            ok: false,
            error: `extract result rejected: claims[${index}].quote occurs more than once（ambiguous locator）`,
          };
        }
        const locator = { start, end: start + claim.quote.length };
        let evidence;
        try {
          evidence = intakeEvidenceForClaim(revision, locator);
        } catch (e) {
          return { ok: false, error: `extract could not build an evidence reference: ${e instanceof Error ? e.message : String(e)}` };
        }
        claims.push({
          // text/quoteHash 均为服务端重算值 —— ingestor 的 tripwire 必然一致。
          text: revision.normalizedText.slice(locator.start, locator.end),
          locator,
          quoteHash: evidence.quoteHash,
          evidence: [evidence],
        });
      }

      return {
        ok: true,
        outcome: {
          runId: request.runId,
          sourceRevisionId: revision.id,
          claims,
          rawModelOutput: raw,
          model,
        },
      };
    },
  };
}
