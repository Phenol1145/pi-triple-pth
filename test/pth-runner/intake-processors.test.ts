/**
 * test/pth-runner/intake-processors.test.ts — N29 Task 5 红/绿测（两个职责分离的 review processor）。
 *
 * 覆盖（plan §5 Task 5 Step 5）：
 *  - producer / domain reviewer / adversarial reviewer / promoter 四个 principal 必须互不相同；
 *    任意两个角色同一 principal → 拒绝（零 LLM 调用）；
 *  - processor outcome 必须绑定 runId / planId / checkId / candidate hash / execution；
 *  - domain 与 adversarial 是两个独立 processor（不同 principal、不同 check、不同 kind）；
 *  - reviewer principal 必须落在 plan check 的 eligiblePrincipals 内；
 *  - LLM 只在 `LlmFn` 后端被替换：processor 仍走生产 prompt 组装 + 结果 schema 校验，
 *    非法/越权的模型输出（缺字段、伪造 hash、伪造 principal）一律拒绝。
 */

import { describe, it, expect } from "vitest";
import {
  createAdversarialReviewProcessor,
  createDomainReviewProcessor,
  validateIntakeReviewPrincipals,
  type IntakeReviewPrincipals,
  type IntakeReviewRequest,
} from "../../src/pth/runner/intake-processors.js";
import { computeCandidateHash, type VerificationPlanRecord } from "../../src/pth/execution/index.js";
import type { LlmFn, LlmResult } from "../../src/pth/kernel/interpreter/llm-fn.js";

const TENANT = "tenant-a";
const DOMAIN = "mathematics";
const CONTENT = "The sum of the interior angles of a triangle equals 180 degrees.";

const PRINCIPALS: IntakeReviewPrincipals = {
  producer: "worker:extractor:producer",
  domainReviewer: "worker:domain:mathematics-reviewer",
  adversarialReviewer: "worker:controller:adversarial",
  promoter: "worker:memory-keeper",
};

const EVIDENCE = [{
  sourceSubscriptionId: "sub-1",
  sourceRevisionId: "rev-1",
  representation: "normalized-text" as const,
  locator: { start: 10, end: 10 + CONTENT.length },
  quoteHash: "a".repeat(64),
  artifactHash: "b".repeat(64),
  policyDecisionDigest: "c".repeat(64),
}];

const CANDIDATE_HASH = computeCandidateHash({ content: CONTENT, domains: [DOMAIN], evidence: EVIDENCE, effect: null });

function plan(over: Partial<VerificationPlanRecord> = {}): VerificationPlanRecord {
  return {
    id: "plan-1",
    tenantId: TENANT,
    candidateId: "cand-1",
    candidateRevision: 1,
    candidateHash: CANDIDATE_HASH,
    requiredDomains: [DOMAIN],
    checks: [
      {
        checkId: `domain:${DOMAIN}`,
        kind: "domain",
        domainId: DOMAIN,
        quorum: 1,
        eligiblePrincipals: [PRINCIPALS.domainReviewer],
        separationFrom: [PRINCIPALS.producer, PRINCIPALS.adversarialReviewer, PRINCIPALS.promoter],
      },
      {
        checkId: "adversarial",
        kind: "adversarial",
        quorum: 1,
        eligiblePrincipals: [PRINCIPALS.adversarialReviewer],
        separationFrom: [PRINCIPALS.producer, PRINCIPALS.domainReviewer, PRINCIPALS.promoter],
      },
    ],
    sourceBindingsDigest: "d".repeat(64),
    status: "open",
    rowVersion: 1,
    createdAt: "2026-08-19T00:00:00.000Z",
    updatedAt: "2026-08-19T00:00:00.000Z",
    ...over,
  };
}

function request(over: Partial<IntakeReviewRequest> = {}): IntakeReviewRequest {
  return {
    runId: "run-1",
    executionId: "exec-1",
    plan: plan(),
    principals: PRINCIPALS,
    candidateContent: CONTENT,
    evidence: EVIDENCE,
    evidenceQuotes: [CONTENT],
    ...over,
  };
}

function llmOf(payload: unknown, capture?: { calls: number }): LlmFn {
  return {
    async complete(): Promise<LlmResult> {
      if (capture) capture.calls += 1;
      return { content: typeof payload === "string" ? payload : JSON.stringify(payload), model: "stub-reviewer" };
    },
  };
}

const PASS = { verdict: "pass", note: "quote matches the admitted source revision verbatim" };

describe("N29 Task 5 intake review processors（职责分离 + outcome 绑定）", () => {
  it("domain processor binds runId/planId/checkId/candidateHash/execution", async () => {
    const processor = createDomainReviewProcessor({ llm: llmOf(PASS), now: () => 1_700_000_000_000 });
    const result = await processor.review(request());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.outcome).toMatchObject({
      runId: "run-1",
      planId: "plan-1",
      checkId: `domain:${DOMAIN}`,
      candidateId: "cand-1",
      candidateRevision: 1,
      candidateHash: CANDIDATE_HASH,
      principalId: PRINCIPALS.domainReviewer,
      executionId: "exec-1",
    });
    expect(result.outcome.verdict).toMatchObject({
      kind: "domain",
      verdict: "pass",
      domainId: DOMAIN,
      at: 1_700_000_000_000,
    });
  });

  it("adversarial processor is a separate role with a different principal and check", async () => {
    const domain = createDomainReviewProcessor({ llm: llmOf(PASS) });
    const adversarial = createAdversarialReviewProcessor({ llm: llmOf(PASS) });
    expect(domain.kind).toBe("domain");
    expect(adversarial.kind).toBe("adversarial");

    const d = await domain.review(request());
    const a = await adversarial.review(request());
    expect(d.ok && a.ok).toBe(true);
    if (!d.ok || !a.ok) return;

    expect(a.outcome.principalId).not.toBe(d.outcome.principalId);
    expect(a.outcome.checkId).not.toBe(d.outcome.checkId);
    expect(a.outcome.verdict.kind).toBe("adversarial");
    expect(a.outcome.verdict.domainId).toBeUndefined();
    // 两个 outcome 都绑定同一 plan + 同一 candidate hash（exact-hash 晋升前提）。
    expect(a.outcome.planId).toBe(d.outcome.planId);
    expect(a.outcome.candidateHash).toBe(d.outcome.candidateHash);
  });

  it("requires four distinct principals; any two roles sharing one principal is rejected", () => {
    expect(validateIntakeReviewPrincipals(PRINCIPALS)).toEqual({ ok: true });

    const pairs: Array<[keyof IntakeReviewPrincipals, keyof IntakeReviewPrincipals]> = [
      ["producer", "domainReviewer"],
      ["producer", "adversarialReviewer"],
      ["producer", "promoter"],
      ["domainReviewer", "adversarialReviewer"],
      ["domainReviewer", "promoter"],
      ["adversarialReviewer", "promoter"],
    ];
    for (const [a, b] of pairs) {
      const clash = validateIntakeReviewPrincipals({ ...PRINCIPALS, [b]: PRINCIPALS[a] });
      expect(clash).toMatchObject({ ok: false, error: expect.stringMatching(/distinct|same principal/i) });
    }
  });

  it("rejects a shared principal before calling the LLM", async () => {
    const capture = { calls: 0 };
    const processor = createDomainReviewProcessor({ llm: llmOf(PASS, capture) });
    const result = await processor.review(request({
      principals: { ...PRINCIPALS, adversarialReviewer: PRINCIPALS.domainReviewer },
    }));
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/distinct|same principal/i) });
    expect(capture.calls).toBe(0);
  });

  it("rejects a reviewer principal that is not eligible for the plan check", async () => {
    const p = plan({
      checks: [
        { checkId: `domain:${DOMAIN}`, kind: "domain", domainId: DOMAIN, quorum: 1, eligiblePrincipals: ["worker:someone-else"], separationFrom: [] },
        { checkId: "adversarial", kind: "adversarial", quorum: 1, eligiblePrincipals: [PRINCIPALS.adversarialReviewer], separationFrom: [] },
      ],
    });
    const processor = createDomainReviewProcessor({ llm: llmOf(PASS) });
    const result = await processor.review(request({ plan: p }));
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/eligible/i) });
  });

  it("rejects a plan that lacks the matching check", async () => {
    const p = plan({
      checks: [{ checkId: `domain:${DOMAIN}`, kind: "domain", domainId: DOMAIN, quorum: 1, eligiblePrincipals: [PRINCIPALS.domainReviewer], separationFrom: [] }],
    });
    const processor = createAdversarialReviewProcessor({ llm: llmOf(PASS) });
    expect(await processor.review(request({ plan: p }))).toMatchObject({
      ok: false,
      error: expect.stringMatching(/adversarial/i),
    });
  });

  it("rejects malformed LLM output through the production result schema", async () => {
    const cases: unknown[] = [
      "not json at all",
      { note: "missing verdict" },
      { verdict: "maybe", note: "bad enum" },
      { verdict: "pass", note: "" },
      // 模型不得自报绑定字段（服务端盖章）：伪造 candidateHash 一律忽略/拒绝
      { verdict: "pass", note: "ok", candidateHash: "f".repeat(64) },
    ];
    const processor = createDomainReviewProcessor({ llm: llmOf(cases[0]) });
    expect(await processor.review(request())).toMatchObject({ ok: false });

    for (const bad of cases.slice(1, 4)) {
      const p = createDomainReviewProcessor({ llm: llmOf(bad) });
      expect(await p.review(request())).toMatchObject({ ok: false, error: expect.any(String) });
    }

    // 伪造的 candidateHash 不得覆盖服务端绑定。
    const forged = createDomainReviewProcessor({ llm: llmOf(cases[4]) });
    const r = await forged.review(request());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.outcome.candidateHash).toBe(CANDIDATE_HASH);
  });

  it("maps a reject verdict without inventing a pass", async () => {
    const processor = createAdversarialReviewProcessor({
      llm: llmOf({ verdict: "reject", note: "quote does not support the claim" }),
    });
    const result = await processor.review(request());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome.verdict.verdict).toBe("reject");
    expect(result.outcome.verdict.note).toContain("does not support");
  });
});
