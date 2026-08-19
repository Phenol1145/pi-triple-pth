/**
 * test/pth-runner/n29-minimal-intake-acceptance.test.ts —— N29 L7 验收判据的纯单测。
 *
 * 只测 driver/evaluator 的**判定逻辑**（不跑 PG、不跑门禁命令）：
 *  - Vitest JSON 报告解析、skip manifest（repo-relative / POSIX / 排序）；
 *  - 正向分母核对：缺失 / NaN / 0 / 低于下限一律失败；
 *  - 负向 sentinel 派生：只认 passed，failed 与 missing 显式暴露；
 *  - 唯一 envelope 判定优先级：started 门禁失败 > 环境不可用；真实性门禁未执行不得给 GO。
 */

import { describe, expect, it } from "vitest";

import {
  buildSkipManifest,
  checkDenominators,
  collectVitestAssertions,
  deriveNegativeSentinels,
  evaluateN29Ledger,
  N29_ACCEPTED_FULL_SKIPS,
  N29_LEDGER_VERSION,
  N29_REQUIRED_LEDGER_NEGATIVES,
  N29_REQUIRED_POSITIVES,
  summarizeVitest,
  type VitestAssertion,
} from "../../scripts/eval-n29-minimal-intake.js";
import {
  decideN29Acceptance,
  deriveRealismGates,
  N29_DISCLAIMER,
  N29_ENVELOPE_SCHEMA,
  type CommandGateEvidence,
  type N29AcceptanceEnvelope,
  type RealismGateEvidence,
} from "../../scripts/accept-n29-minimal-intake.js";

const REPO_ROOT = "/repo";
const HEAD = "a".repeat(40);
/** 生产 digest 为 base64url canonical digest（非 hex）；判据只要求存在、无空白、足够长。 */
const DIGEST = "g3tsitUoDggL1pgr21SRwdmS8MSX7g_y2a7NcvpCBv4";

function report(rows: Array<{ file: string; tests: Array<{ title: string; status: string }> }>): unknown {
  return {
    testResults: rows.map((row) => ({
      name: `${REPO_ROOT}/${row.file}`,
      assertionResults: row.tests.map((t) => ({
        ancestorTitles: ["suite"],
        fullName: `suite ${t.title}`,
        title: t.title,
        status: t.status,
      })),
    })),
  };
}

function okLedger(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const positives: Record<string, number> = {};
  for (const [key, min] of Object.entries(N29_REQUIRED_POSITIVES)) positives[key] = min;
  const negatives: Record<string, number> = {};
  for (const [key, min] of Object.entries(N29_REQUIRED_LEDGER_NEGATIVES)) negatives[key] = min;
  return {
    version: N29_LEDGER_VERSION,
    suite: "test/pth-knowledge-intake/minimal-loop.integration.test.ts",
    evaluatedCommit: HEAD,
    writtenAt: new Date().toISOString(),
    tenantId: "tenant-a",
    space: "space-a",
    domain: "mathematics",
    canonicalUri: "https://docs.example.org/guide/triangles",
    policy: { policyId: "p", version: "1", digest: DIGEST, keyId: "human-alice", humanPrincipalId: "human-alice", issuer: "ptl-human-interface" },
    positives,
    negatives,
    evidence: { subscriptionId: "sub-1", revisions: [], officials: [], verdicts: [] },
    ...overrides,
  };
}

function gate(overrides: Partial<CommandGateEvidence> = {}): CommandGateEvidence {
  return {
    command: "cmd",
    started: true,
    exitCode: 0,
    durationMs: 1,
    skipped: [],
    environmentStatus: "available",
    ...overrides,
  };
}

const SATISFIED_REALISM: RealismGateEvidence[] = [
  { gate: "G9-a", requirement: "r", status: "satisfied", evidence: "e" },
];

function envelope(overrides: Partial<N29AcceptanceEnvelope> = {}): N29AcceptanceEnvelope {
  const evaluator = evaluateN29Ledger({ ledger: okLedger(), expectedCommit: HEAD });
  return {
    schema: N29_ENVELOPE_SCHEMA,
    generatedAt: new Date().toISOString(),
    plan: "docs/pth/n29-minimal-knowledge-intake-loop-feedback-plan.md",
    evaluatedCommit: HEAD,
    implementationTreeClean: true,
    trustPolicy: { policyId: "p", version: "1", digest: DIGEST, keyId: "k", humanPrincipalId: "human-alice", issuer: "ptl-human-interface" },
    evaluator,
    positiveDenominators: checkDenominators(okLedger()["positives"] as Record<string, number>, N29_REQUIRED_POSITIVES),
    ledgerNegatives: checkDenominators(okLedger()["negatives"] as Record<string, number>, N29_REQUIRED_LEDGER_NEGATIVES),
    negativeSentinels: { wrongGeneration: { matchers: 1, passed: 1, failed: 0, missing: [], tests: ["f::t"] } },
    focused: gate(),
    n29Typecheck: gate(),
    rootTypecheck: gate(),
    n28Typecheck: gate(),
    lint: gate(),
    build: gate(),
    fullRegression: gate({ skipped: N29_ACCEPTED_FULL_SKIPS.map((s) => ({ ...s })) }),
    realismGates: SATISFIED_REALISM,
    decision: "EVALUATION-INCOMPLETE",
    reasons: [],
    disclaimer: N29_DISCLAIMER,
    ...overrides,
  };
}

describe("N29 L7 报告解析与 skip manifest", () => {
  it("assertion 展平为 repo-relative POSIX 路径，skip manifest 排序且只含 >0 的文件", () => {
    const assertions = collectVitestAssertions(
      report([
        { file: "test/z/b.test.ts", tests: [{ title: "x", status: "passed" }, { title: "y", status: "skipped" }] },
        { file: "test/a/a.test.ts", tests: [{ title: "p", status: "pending" }, { title: "t", status: "todo" }] },
        { file: "test/m/c.test.ts", tests: [{ title: "ok", status: "passed" }] },
      ]),
      REPO_ROOT,
    );
    expect(assertions.map((a) => a.file)).toContain("test/a/a.test.ts");
    expect(buildSkipManifest(assertions)).toEqual([
      { file: "test/a/a.test.ts", tests: 2 },
      { file: "test/z/b.test.ts", tests: 1 },
    ]);
    expect(summarizeVitest(assertions)).toEqual({ files: 3, tests: 5, passed: 2, failed: 0, skipped: 3 });
  });

  it("形状不符的报告直接抛错（不静默返回空 manifest）", () => {
    expect(() => collectVitestAssertions({}, REPO_ROOT)).toThrow(/testResults/);
    expect(() => collectVitestAssertions({ testResults: [{ name: 1 }] }, REPO_ROOT)).toThrow(/testResult row/);
    expect(() => collectVitestAssertions({ testResults: [{ name: "/repo/a.test.ts", assertionResults: [{}] }] }, REPO_ROOT)).toThrow(/assertion shape/);
  });
});

describe("N29 L7 正向分母", () => {
  it("缺失 / NaN / 0 / 低于下限一律 ok=false", () => {
    const rows = checkDenominators(
      { initialIngestion: 1, unchangedRecrawl: 0, changedRecrawl: Number.NaN, promotion: 1 },
      { initialIngestion: 1, unchangedRecrawl: 1, changedRecrawl: 1, promotion: 2, staleWithdrawal: 1 },
    );
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(byName["initialIngestion"]!.ok).toBe(true);
    expect(byName["unchangedRecrawl"]).toMatchObject({ actual: 0, ok: false });
    expect(byName["changedRecrawl"]).toMatchObject({ actual: null, ok: false });
    expect(byName["promotion"]).toMatchObject({ actual: 1, ok: false });
    expect(byName["staleWithdrawal"]).toMatchObject({ actual: null, ok: false });
  });

  it("台账绑定：commit 不符 / digest 非法 / 版本不符都判 FAIL", () => {
    expect(evaluateN29Ledger({ ledger: okLedger(), expectedCommit: HEAD }).decision).toBe("PASS");
    expect(evaluateN29Ledger({ ledger: okLedger({ evaluatedCommit: "c".repeat(40) }), expectedCommit: HEAD }).reasons.join()).toMatch(/evaluatedCommit/);
    expect(evaluateN29Ledger({ ledger: okLedger({ policy: { digest: "short" } }), expectedCommit: HEAD }).reasons.join()).toMatch(/policy digest/);
    expect(evaluateN29Ledger({ ledger: okLedger({ version: "other" }), expectedCommit: HEAD }).reasons.join()).toMatch(/ledger 不可用/);
    expect(evaluateN29Ledger({ ledger: null, expectedCommit: HEAD }).decision).toBe("FAIL");
  });
});

describe("N29 L7 负向 sentinel 派生", () => {
  const matrix = {
    wrongGeneration: [{ file: "test/a.test.ts", pattern: /wrong generation/ }],
    expiredLease: [{ file: "test/a.test.ts", pattern: /expired lease/ }],
    crossTenant: [{ file: "test/b.test.ts", pattern: /cross tenant/ }],
  } as const;

  const assertions = collectVitestAssertions(
    report([
      {
        file: "test/a.test.ts",
        tests: [
          { title: "wrong generation does not enqueue", status: "passed" },
          { title: "expired lease cannot commit", status: "failed" },
        ],
      },
      { file: "test/b.test.ts", tests: [{ title: "unrelated", status: "passed" }] },
    ]),
    REPO_ROOT,
  );

  it("只有 passed 计入 sentinel；failed 与 missing 显式暴露", () => {
    const sentinels = deriveNegativeSentinels(assertions, matrix);
    expect(sentinels["wrongGeneration"]).toMatchObject({ passed: 1, failed: 0, missing: [] });
    expect(sentinels["expiredLease"]).toMatchObject({ passed: 0, failed: 1 });
    expect(sentinels["crossTenant"]!.passed).toBe(0);
    expect(sentinels["crossTenant"]!.missing).toHaveLength(1);
  });

  it("sentinel 命中 0 → NO-GO（不允许矩阵存在但没跑）", () => {
    const outcome = decideN29Acceptance(
      envelope({ negativeSentinels: deriveNegativeSentinels(assertions, matrix) }),
      { currentHead: HEAD },
    );
    expect(outcome.decision).toBe("NO-GO");
    // P1-3：exact denominator——0 passed 不再是唯一形态；missing 与 denominator 不符必须逐条暴露。
    expect(outcome.reasons.join("\n")).toMatch(/negative sentinel crossTenant: 1 matcher 未执行/);
    expect(outcome.reasons.join("\n")).toMatch(/negative sentinel crossTenant: exact denominator 不符 passed=0 required=1/);
    expect(outcome.reasons.join("\n")).toMatch(/negative sentinel expiredLease: 1 failing test/);
    expect(outcome.reasons.join("\n")).toMatch(/negative sentinel expiredLease: exact denominator 不符 passed=0 required=1/);
  });
});

describe("N29 L7 唯一 envelope 判定", () => {
  it("全绿 + 真实性门禁全部 satisfied → MIN_INNER_LOOP_GO", () => {
    expect(decideN29Acceptance(envelope(), { currentHead: HEAD })).toEqual({ decision: "MIN_INNER_LOOP_GO", reasons: [] });
  });

  it("真实性门禁未执行 → EVALUATION-INCOMPLETE（不得给 GO）", () => {
    const outcome = decideN29Acceptance(
      envelope({
        realismGates: [
          { gate: "G9-c release canary", requirement: "r", status: "not-executed", evidence: "no network" },
          { gate: "G9-a controlled TLS", requirement: "r", status: "partial", evidence: "layer only" },
        ],
      }),
      { currentHead: HEAD },
    );
    expect(outcome.decision).toBe("EVALUATION-INCOMPLETE");
    expect(outcome.reasons.join("\n")).toMatch(/release canary/);
    expect(outcome.reasons.join("\n")).toMatch(/controlled TLS/);
  });

  it("已启动门禁非零退出 → NO-GO，且不被后续环境不可用覆盖", () => {
    const outcome = decideN29Acceptance(
      envelope({
        lint: gate({ exitCode: 1 }),
        fullRegression: gate({ started: false, exitCode: null, environmentStatus: "unavailable", unavailableReason: "postgres" }),
      }),
      { currentHead: HEAD },
    );
    expect(outcome.decision).toBe("NO-GO");
    expect(outcome.reasons.join("\n")).toMatch(/lint: exit=1/);
    expect(outcome.reasons.join("\n")).toMatch(/fullRegression: not started/);
  });

  it("focused 未启动（环境不可用）→ EVALUATION-INCOMPLETE，缺台账不当作 NO-GO", () => {
    const outcome = decideN29Acceptance(
      envelope({
        focused: gate({ started: false, exitCode: null, environmentStatus: "unavailable", unavailableReason: "postgres" }),
        evaluator: evaluateN29Ledger({ ledger: null, expectedCommit: HEAD }),
        positiveDenominators: checkDenominators(undefined, N29_REQUIRED_POSITIVES),
        negativeSentinels: {},
      }),
      { currentHead: HEAD },
    );
    expect(outcome.decision).toBe("EVALUATION-INCOMPLETE");
    expect(outcome.reasons.join("\n")).toMatch(/focused: not started（postgres）/);
  });

  it("focused 出现 skip / full skip manifest 漂移 / 工作树脏 / commit 不符 → NO-GO", () => {
    expect(decideN29Acceptance(envelope({ focused: gate({ skipped: [{ file: "test/x.test.ts", tests: 1 }] }) }), { currentHead: HEAD }).decision).toBe("NO-GO");
    expect(decideN29Acceptance(envelope({ fullRegression: gate({ skipped: [{ file: "test/y.test.ts", tests: 3 }] }) }), { currentHead: HEAD }).reasons.join()).toMatch(/skip manifest changed/);
    expect(decideN29Acceptance(envelope({ implementationTreeClean: false }), { currentHead: HEAD }).reasons.join()).toMatch(/not clean/);
    expect(decideN29Acceptance(envelope(), { currentHead: "d".repeat(40) }).reasons.join()).toMatch(/evaluatedCommit/);
  });

  it("分母为零 → NO-GO（evaluator 与 envelope 双路都要报）", () => {
    const zero = okLedger({ positives: { ...(okLedger()["positives"] as Record<string, number>), promotion: 0 } });
    const outcome = decideN29Acceptance(
      envelope({
        evaluator: evaluateN29Ledger({ ledger: zero, expectedCommit: HEAD }),
        positiveDenominators: checkDenominators(zero["positives"] as Record<string, number>, N29_REQUIRED_POSITIVES),
      }),
      { currentHead: HEAD },
    );
    expect(outcome.decision).toBe("NO-GO");
    expect(outcome.reasons.join("\n")).toMatch(/positive denominator promotion: actual=0/);
  });
});

describe("N29 L7 真实性门禁派生", () => {
  it("TLS 用例通过 → satisfied；缺失 → not-executed；G8/G9-b/G10 按取证升级，canary 恒 not-executed", () => {
    const withTls = deriveRealismGates(
      collectVitestAssertions(
        report([
          {
            file: "test/pth-knowledge-intake/fetch-broker.test.ts",
            tests: [{ title: "defaultWebRequest 走真实 TLS：redirect/hash/条件请求全链路", status: "passed" }],
          },
          {
            file: "test/pth-knowledge-intake/minimal-loop-tls.integration.test.ts",
            tests: [{ title: "initial crawl 经真实 TLS → official；unchanged 304 重爬；changed 重爬 stale+supersede", status: "passed" }],
          },
          {
            file: "test/pth-knowledge-intake/g8-dual-process.test.ts",
            tests: [
              { title: "dual OS-process drainers：同一 outbox 两行并发消费，恰好各处理一次", status: "passed" },
              { title: "SIGKILL 恢复：handler 中途强杀 → lease 过期 → 新进程回收并完成，恰好一次", status: "passed" },
            ],
          },
          {
            file: "test/pth-knowledge-intake/g10-sabotage-sensitivity.test.ts",
            tests: [
              { title: "trust-policy-attestation-bypass：仓库未注入 verifier 时…", status: "passed" },
              { title: "digest-binding-skip：naive evaluator…", status: "passed" },
              { title: "stale-gate-skip（use-policy 恒 allow）…", status: "passed" },
            ],
          },
        ]),
        REPO_ROOT,
      ),
    );
    expect(withTls.find((g) => g.gate.startsWith("G9-a"))!.status).toBe("satisfied");
    expect(withTls.find((g) => g.gate.startsWith("G9-b"))!.status).toBe("satisfied");
    expect(withTls.find((g) => g.gate.startsWith("G8-a"))!.status).toBe("satisfied");
    expect(withTls.find((g) => g.gate.startsWith("G8-b"))!.status).toBe("partial");
    expect(withTls.find((g) => g.gate.startsWith("G10"))!.status).toBe("partial");
    // canary 恒 not-executed（用户裁决：本轮不做真实公网 canary）。
    expect(withTls.find((g) => g.gate.startsWith("G9-c"))!.status).toBe("not-executed");

    const withoutTls = deriveRealismGates([] as VitestAssertion[]);
    expect(withoutTls.find((g) => g.gate.startsWith("G9-a"))!.status).toBe("not-executed");
    expect(withoutTls.every((g) => g.status !== "satisfied")).toBe(true);
  });
});
