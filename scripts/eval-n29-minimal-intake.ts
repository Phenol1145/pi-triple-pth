/**
 * scripts/eval-n29-minimal-intake.ts —— N29 最小可信摄入内环 provisional evaluator（纯判据）。
 *
 * 定位（计划 §5 Task 7 Step 1/2/5）：
 *  - 本文件**只做判据**：解析 Vitest JSON 报告与聚焦套件写出的分母台账，导出
 *    正向分母核对、负向 sentinel 派生与 skip manifest 生成；不自己下 GO 结论。
 *  - 唯一权威结论由 `scripts/accept-n29-minimal-intake.ts` 给出（它把这里的判据与
 *    typecheck / full regression / lint / build 门禁和 evaluated commit 绑在一个 envelope 里）。
 *  - CLI 模式（`npx tsx scripts/eval-n29-minimal-intake.ts`）跑一次最小内环集成测试并核对
 *    正向分母，用于开发期自查：exit 0 = provisional PASS，exit 1 = FAIL，exit 2 = 环境不可用。
 *
 * 反真空原则：分母不是常量，而是聚焦套件在断言通过后累加、落盘到台账的实测计数；
 * sentinel 也不是自报字段，而是从 JSON 报告里 **确实 passed** 的具体用例标题派生。
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// ─── 台账合同（与 minimal-loop.integration.test.ts 的 LEDGER_VERSION 对齐） ──

export const N29_LEDGER_VERSION = "n29-minimal-intake-ledger/1";

export interface N29IntakeLedger {
  version: string;
  suite: string;
  evaluatedCommit: string | null;
  writtenAt: string;
  tenantId: string;
  space: string;
  domain: string;
  canonicalUri: string;
  policy: {
    policyId: string;
    version: string;
    digest: string;
    keyId: string;
    humanPrincipalId: string;
    issuer: string;
  };
  positives: Readonly<Record<string, number>>;
  negatives: Readonly<Record<string, number>>;
  evidence: {
    subscriptionId: string;
    revisions: ReadonlyArray<{ id: string; disposition: string; rawHash: string }>;
    officials: ReadonlyArray<Record<string, unknown>>;
    verdicts: ReadonlyArray<{ planId: string; kind: string; principalId: string }>;
  };
}

/**
 * 计划 §5 Task 7 Step 1 的「不可真空正向分母」下限。
 * 台账实测值必须是有限数且 >= 下限；缺失 / NaN / 0 一律判失败。
 */
export const N29_REQUIRED_POSITIVES = {
  initialIngestion: 1,
  unchangedRecrawl: 1,
  changedRecrawl: 1,
  staleWithdrawal: 1,
  supersede: 1,
  domainVerdict: 1,
  adversarialVerdict: 1,
  promotion: 2,
  brokerContextRetrieval: 2,
} as const;

/** 集成套件自身必须记录的组合层负向计数（下限均为 1）。 */
export const N29_REQUIRED_LEDGER_NEGATIVES = {
  subscribeOutOfScopeDenied: 1,
  dueScannerIdempotent: 1,
  unchangedNoNewCandidate: 1,
  staleNotAuthoritative: 1,
  policyRevocationStale: 1,
  crossTenantIsolation: 1,
  runCasRejected: 1,
} as const;

// ─── 聚焦套件清单（focused gate 与 sentinel 取证面一致） ─────────────────

/** 内环主体（L2–L6 + L7 集成/故障矩阵）。 */
export const N29_FOCUSED_INTAKE_TESTS = [
  "test/pth-knowledge-intake/trust-policy.test.ts",
  "test/pth-knowledge-intake/knowledge-intake-pg.test.ts",
  "test/pth-knowledge-intake/fetch-broker.test.ts",
  "test/pth-knowledge-intake/knowledge-ingestor.test.ts",
  "test/pth-knowledge-intake/minimal-loop.integration.test.ts",
  "test/pth-runner/intake-processors.test.ts",
  // 再验收 L6/L7：G10 sabotage 敏感度、G8 双进程/SIGKILL、G9 受控 TLS 全组合。
  "test/pth-knowledge-intake/g10-sabotage-sensitivity.test.ts",
  "test/pth-knowledge-intake/g8-dual-process.test.ts",
  "test/pth-knowledge-intake/minimal-loop-tls.integration.test.ts",
] as const;

/** L1 前置修复与消费面：负向 sentinel 的取证来源。 */
export const N29_FOCUSED_SENTINEL_TESTS = [
  "test/pth-tasking/pg-task-repository.test.ts",
  "test/pth-tasking/side-effect-outbox.test.ts",
  "test/pth-execution/knowledge-promotion.test.ts",
  "test/pth-execution/knowledge-verdicts.test.ts",
  "test/pth-execution/knowledge-broker.test.ts",
  "test/pth-runner/knowledge-context.test.ts",
  "test/pth-kernel-assembly/templates.test.ts",
  "packages/pth-memory/test/memory-policy.test.ts",
  // 再验收 refix 取证面（P0-5 raw store、P1-1 IP 分类、P0-9 模式分离）。
  "packages/pth-memory/test/memory-store-pg.test.ts",
  "test/pth-kernel-interpreter/web-transport-ip.test.ts",
  "test/pth-kernel-assembly/intake-mode-gates.test.ts",
] as const;

/** L7 driver 自身的纯判据测试。 */
export const N29_FOCUSED_DRIVER_TESTS = [
  "test/pth-runner/n29-minimal-intake-acceptance.test.ts",
] as const;

export const N29_FOCUSED_TEST_FILES = [
  ...N29_FOCUSED_INTAKE_TESTS,
  ...N29_FOCUSED_SENTINEL_TESTS,
  ...N29_FOCUSED_DRIVER_TESTS,
] as const;

/** full regression 允许的既有冻结 skip（沙箱安全集成套件）。 */
export const N29_ACCEPTED_FULL_SKIPS = [
  { file: "test/pth-execution/sandbox-security.integration.test.ts", tests: 9 },
] as const;

// ─── 负向 / 故障矩阵：sentinel → 必须 passed 的具体用例 ─────────────────

export interface SentinelMatcher {
  readonly file: string;
  readonly pattern: RegExp;
}

/**
 * 计划 §5 Task 7 Step 2 的负向矩阵。每个 sentinel 至少要在本次 focused 运行里
 * 命中一个 **passed** 用例；命中 0 个即为 NO-GO（不允许"矩阵存在但没跑"）。
 */
export const N29_NEGATIVE_SENTINEL_MATRIX: Readonly<Record<string, readonly SentinelMatcher[]>> = {
  wrongGeneration: [
    { file: "test/pth-tasking/pg-task-repository.test.ts", pattern: /wrong generation does not enqueue side effects/ },
    { file: "test/pth-tasking/pg-task-repository.test.ts", pattern: /wrong generation 在 retryable/ },
    { file: "test/pth-knowledge-intake/knowledge-intake-pg.test.ts", pattern: /transitionRun：错 token \/ 错 generation/ },
    { file: "test/pth-knowledge-intake/minimal-loop.integration.test.ts", pattern: /run CAS 错 token \/ 错 generation/ },
  ],
  expiredLease: [
    { file: "test/pth-tasking/pg-task-repository.test.ts", pattern: /expired lease cannot commit or enqueue/ },
    { file: "test/pth-tasking/pg-task-repository.test.ts", pattern: /expired lease 在 retryable/ },
    { file: "test/pth-tasking/pg-task-repository.test.ts", pattern: /lease_expires_at IS NULL/ },
    { file: "test/pth-knowledge-intake/knowledge-intake-pg.test.ts", pattern: /lease 过期可由新 claim 回收/ },
  ],
  duplicateHandler: [
    { file: "test/pth-tasking/side-effect-outbox.test.ts", pattern: /two concurrent drainers never claim the same row/ },
    { file: "test/pth-tasking/side-effect-outbox.test.ts", pattern: /stale handler cannot move completed row back to pending/ },
    { file: "test/pth-tasking/side-effect-outbox.test.ts", pattern: /complete with wrong token does nothing/ },
    { file: "test/pth-knowledge-intake/knowledge-intake-pg.test.ts", pattern: /双 scanner 并发/ },
  ],
  leaseRecovery: [
    { file: "test/pth-tasking/side-effect-outbox.test.ts", pattern: /expired processing lease is reclaimed by a later claim/ },
    { file: "test/pth-tasking/pg-task-repository.test.ts", pattern: /recoverExpired 只清过期 claimed 行/ },
    { file: "test/pth-knowledge-intake/knowledge-intake-pg.test.ts", pattern: /lease 过期可由新 claim 回收/ },
  ],
  crossTenant: [
    { file: "test/pth-knowledge-intake/knowledge-intake-pg.test.ts", pattern: /跨 tenant/ },
    { file: "test/pth-knowledge-intake/knowledge-intake-pg.test.ts", pattern: /policy 审计镜像不跨 tenant 授权/ },
    { file: "test/pth-knowledge-intake/knowledge-ingestor.test.ts", pattern: /isolates tenants/ },
    { file: "test/pth-knowledge-intake/minimal-loop.integration.test.ts", pattern: /跨 tenant 零可见/ },
    { file: "test/pth-tasking/pg-task-repository.test.ts", pattern: /跨租户/ },
  ],
  policyExpiryOrRevocation: [
    { file: "test/pth-knowledge-intake/trust-policy.test.ts", pattern: /expired validUntil rejects with expired/ },
    { file: "test/pth-knowledge-intake/trust-policy.test.ts", pattern: /policy expiry at use time and revoked subscription reject/ },
    { file: "test/pth-knowledge-intake/fetch-broker.test.ts", pattern: /fetch 后策略过期 → use 拒绝/ },
    { file: "test/pth-knowledge-intake/fetch-broker.test.ts", pattern: /订阅被撤销\/暂停 → use 拒绝/ },
    { file: "test/pth-knowledge-intake/minimal-loop.integration.test.ts", pattern: /subscription 撤销：依赖项全部 stale/ },
  ],
  redirectScopeEscape: [
    { file: "test/pth-knowledge-intake/fetch-broker.test.ts", pattern: /redirect 到策略外 origin/ },
    { file: "test/pth-knowledge-intake/fetch-broker.test.ts", pattern: /redirect 逃逸到/ },
    { file: "test/pth-knowledge-intake/fetch-broker.test.ts", pattern: /redirect 到授权 origin 但越出 pathPrefix/ },
    { file: "test/pth-knowledge-intake/fetch-broker.test.ts", pattern: /redirect 到 HTTP（非 TLS）在该跳拒绝/ },
  ],
  unknownLicense: [
    { file: "test/pth-knowledge-intake/trust-policy.test.ts", pattern: /unknown sourceType\/contentType\/license\/domain rejects/ },
    { file: "test/pth-knowledge-intake/fetch-broker.test.ts", pattern: /未知\/未批准 content type/ },
    { file: "test/pth-knowledge-intake/fetch-broker.test.ts", pattern: /domain\/sourceType 不匹配 → use 拒绝/ },
  ],
  emptyEvidence: [
    { file: "test/pth-knowledge-intake/knowledge-ingestor.test.ts", pattern: /rejects a claim without evidence/ },
    { file: "test/pth-knowledge-intake/knowledge-ingestor.test.ts", pattern: /refuses to create a VerificationPlan with empty evidence/ },
    { file: "test/pth-execution/knowledge-promotion.test.ts", pattern: /rejects an evidence-free N29 candidate/ },
    { file: "test/pth-execution/knowledge-verdicts.test.ts", pattern: /N29 candidate 拒绝空 evidence/ },
  ],
  staleVerdictOrDependency: [
    { file: "test/pth-knowledge-intake/knowledge-ingestor.test.ts", pattern: /rejects promotion once the source dependency is stale/ },
    { file: "test/pth-execution/knowledge-verdicts.test.ts", pattern: /canPromote rejects verdict with stale candidateRevision/ },
    { file: "test/pth-execution/knowledge-promotion.test.ts", pattern: /rejects stale expectedCandidateRevision/ },
  ],
  sameKeyDifferentPayloadConflict: [
    { file: "test/pth-tasking/side-effect-outbox.test.ts", pattern: /same tenant\/key with a different payload conflicts/ },
    { file: "test/pth-tasking/side-effect-outbox.test.ts", pattern: /same tenant\/key with a different kind conflicts/ },
    { file: "test/pth-knowledge-intake/knowledge-intake-pg.test.ts", pattern: /outbox conflict 回滚整个 transition/ },
  ],
  differentTenantSameKey: [
    { file: "test/pth-tasking/side-effect-outbox.test.ts", pattern: /different tenants may reuse the same outbox key/ },
  ],
  quarantineBeforeUse: [
    { file: "test/pth-knowledge-intake/fetch-broker.test.ts", pattern: /raw 只能是 quarantine/ },
    { file: "test/pth-knowledge-intake/knowledge-ingestor.test.ts", pattern: /rejects a quarantined \(non-admitted\) revision/ },
    { file: "test/pth-knowledge-intake/knowledge-intake-pg.test.ts", pattern: /quarantined 不得原地升为 admitted/ },
  ],
  directOfficialBypass: [
    { file: "packages/pth-memory/test/memory-policy.test.ts", pattern: /knowledge 层任意 kind\/status 一律强制 draft/ },
    { file: "packages/pth-memory/test/memory-policy.test.ts", pattern: /service 与 platform-admin service 无法绕过/ },
    { file: "test/pth-kernel-assembly/templates.test.ts", pattern: /recon-doc 固定 status draft/ },
    { file: "test/pth-kernel-assembly/templates.test.ts", pattern: /memory-maintain 固定 status draft/ },
    { file: "test/pth-kernel-assembly/templates.test.ts", pattern: /所有模板渲染产物都不含 official 直写/ },
  ],
  producerSelfReview: [
    { file: "test/pth-runner/intake-processors.test.ts", pattern: /requires four distinct principals/ },
    { file: "test/pth-runner/intake-processors.test.ts", pattern: /rejects a reviewer principal that is not eligible/ },
    { file: "test/pth-execution/knowledge-verdicts.test.ts", pattern: /producer 不得自审/ },
  ],
  // ── 再验收 refix 逐项旁路 sentinel（P1-3：exact denominator——全部 matcher 必须 passed）──
  crossTenantOutbox: [
    { file: "test/pth-tasking/pg-task-repository.test.ts", pattern: /refix P0-1：tenant-a 的 task 声明 tenantId=tenant-b/ },
    { file: "test/pth-tasking/pg-task-repository.test.ts", pattern: /refix P0-1：retryable \/ rejected 分支的跨 tenant/ },
    { file: "test/pth-knowledge-intake/knowledge-intake-pg.test.ts", pattern: /refix P0-1：tenant-a 的 run 声明 tenantId=tenant-b/ },
  ],
  sideEffectTenantStamping: [
    { file: "test/pth-tasking/pg-task-repository.test.ts", pattern: /refix P0-1：省略 tenantId 的 side effect 由通过 CAS 的 task 行盖章/ },
    { file: "test/pth-knowledge-intake/knowledge-intake-pg.test.ts", pattern: /refix P0-1：省略 tenantId 的 run side effect 由 run 的 tenant_id 盖章/ },
  ],
  wrongFromStage: [
    { file: "test/pth-knowledge-intake/knowledge-intake-pg.test.ts", pattern: /refix P0-2：真实 stage=fetch 时伪报 fromStage=promote→complete/ },
    { file: "test/pth-knowledge-intake/knowledge-intake-pg.test.ts", pattern: /refix P0-2：fromStage 与真实 stage 不符/ },
    { file: "test/pth-knowledge-intake/knowledge-intake-pg.test.ts", pattern: /refix P0-2：跳阶段\/回退\/终态出边等非法边全部零行/ },
    { file: "test/pth-knowledge-intake/knowledge-intake-pg.test.ts", pattern: /refix P0-2：合法边逐条通过/ },
  ],
  fakePolicyInstall: [
    { file: "test/pth-knowledge-intake/knowledge-intake-pg.test.ts", pattern: /P0-3：结构同形但伪造 signature\/digest/ },
    { file: "test/pth-knowledge-intake/knowledge-intake-pg.test.ts", pattern: /P0-3：真实 verifier 产出的 policy 安装成功/ },
    { file: "test/pth-knowledge-intake/knowledge-intake-pg.test.ts", pattern: /P0-3：service 签名的 policy/ },
    { file: "test/pth-knowledge-intake/knowledge-intake-pg.test.ts", pattern: /P0-3：即使手工盖 attestation/ },
    { file: "test/pth-knowledge-intake/knowledge-intake-pg.test.ts", pattern: /P0-3：attestation 与 manifest 身份不一致/ },
    { file: "test/pth-knowledge-intake/knowledge-intake-pg.test.ts", pattern: /P0-3（approach A）：注入 verifier 的仓库自行验签/ },
    { file: "test/pth-knowledge-intake/knowledge-intake-pg.test.ts", pattern: /P0-3（approach A）：注入 verifier 后连手工盖章的伪造 policy/ },
  ],
  invalidAdmittedRevision: [
    { file: "test/pth-knowledge-intake/knowledge-intake-pg.test.ts", pattern: /P0-4：usePolicyDecision=deny 的 admitted revision 零行/ },
    { file: "test/pth-knowledge-intake/knowledge-intake-pg.test.ts", pattern: /P0-4：rawHash 与 rawBytes 不符/ },
    { file: "test/pth-knowledge-intake/knowledge-intake-pg.test.ts", pattern: /P0-4：normalizedTextHash 与 normalizedText 不符/ },
    { file: "test/pth-knowledge-intake/knowledge-intake-pg.test.ts", pattern: /P0-4：admitted 缺少 derivedFromRevisionId/ },
    { file: "test/pth-knowledge-intake/knowledge-intake-pg.test.ts", pattern: /P0-4：derivedFromRevisionId 指向另一 tenant/ },
    { file: "test/pth-knowledge-intake/knowledge-intake-pg.test.ts", pattern: /P0-4：derivedFromRevisionId 指向非 raw-quarantine/ },
    { file: "test/pth-knowledge-intake/knowledge-intake-pg.test.ts", pattern: /P0-4：derivedFromRevisionId 指向另一 subscription/ },
    { file: "test/pth-knowledge-intake/knowledge-intake-pg.test.ts", pattern: /P0-4：use decision 的 policy 绑定与 Subscription 不一致/ },
    { file: "test/pth-knowledge-intake/knowledge-intake-pg.test.ts", pattern: /P0-4：Subscription 不存在（或跨 tenant）/ },
    { file: "test/pth-knowledge-intake/knowledge-intake-pg.test.ts", pattern: /P0-4：recordDependency 不得把依赖边绑到 raw-quarantine/ },
  ],
  rawStoreOfficial: [
    { file: "packages/pth-memory/test/memory-store-pg.test.ts", pattern: /N29 P0-5：task-insight \/ tool-function official 直写被拒/ },
    { file: "packages/pth-memory/test/memory-store-pg.test.ts", pattern: /N29 P0-5：capability facade（withMemoryTenant）不再公开 promoteOfficial/ },
    { file: "packages/pth-memory/test/memory-store-pg.test.ts", pattern: /N29 P0-4：official domain 知识直写被拒/ },
  ],
  promoteOfficialWithoutEvaluator: [
    { file: "packages/pth-memory/test/memory-store-pg.test.ts", pattern: /N29 P0-5：promoteOfficial 不提供 evaluator 时抛错/ },
  ],
  legacyEmptyBindingPromotion: [
    { file: "test/pth-execution/knowledge-promotion.test.ts", pattern: /空 sourceBindingsDigest \+ 空 evidence 的 legacy candidate 一律拒绝/ },
    { file: "test/pth-execution/knowledge-promotion.test.ts", pattern: /空 evidence（digest 为空数组摘要）的 legacy candidate 同样拒绝/ },
    { file: "test/pth-execution/knowledge-promotion.test.ts", pattern: /meta\.evidence 缺失（undefined）的 legacy candidate 拒绝/ },
    { file: "test/pth-execution/knowledge-verdicts.test.ts", pattern: /N29 candidate 不得使用空 sourceBindingsDigest/ },
    { file: "test/pth-execution/knowledge-verdicts.test.ts", pattern: /N29 candidate 拒绝空 evidence/ },
  ],
  unchangedUsePolicyDeny: [
    { file: "test/pth-knowledge-intake/minimal-loop.integration.test.ts", pattern: /unchanged 重爬遇到当前 use-policy deny/ },
  ],
  realByteLengthRecheck: [
    { file: "test/pth-knowledge-intake/knowledge-ingestor.test.ts", pattern: /promotion recheck uses the real artifact byteLength/ },
  ],
  privateIpSpecialRanges: [
    { file: "test/pth-kernel-interpreter/web-transport-ip.test.ts", pattern: /IPv4 组播\/保留\/benchmark\/documentation 拒绝/ },
    { file: "test/pth-kernel-interpreter/web-transport-ip.test.ts", pattern: /IPv6 loopback\/unspecified\/ULA\/link-local\/multicast 拒绝/ },
    { file: "test/pth-kernel-interpreter/web-transport-ip.test.ts", pattern: /IPv4-mapped 全展开形式/ },
    { file: "test/pth-kernel-interpreter/web-transport-ip.test.ts", pattern: /documentation IPv6（2001:db8::\/32）拒绝/ },
  ],
  executionSeparation: [
    { file: "test/pth-execution/knowledge-verdicts.test.ts", pattern: /canPromote requires domain\/adversarial execution separation/ },
  ],
  draftModeNoPromoteHandler: [
    { file: "test/pth-kernel-assembly/intake-mode-gates.test.ts", pattern: /draft 模式剔除 promote handler/ },
    { file: "test/pth-kernel-assembly/intake-mode-gates.test.ts", pattern: /off 模式零 handler/ },
  ],
  fullModeAcceptanceGate: [
    { file: "test/pth-kernel-assembly/intake-mode-gates.test.ts", pattern: /full 启动门：非 MIN_INNER_LOOP_GO/ },
    { file: "test/pth-kernel-assembly/intake-mode-gates.test.ts", pattern: /full 启动门：合法 envelope 通过/ },
  ],
} as const;

// ─── Vitest JSON 报告解析 ──────────────────────────────────────────────

export interface VitestAssertion {
  readonly file: string;
  readonly fullName: string;
  readonly title: string;
  readonly status: string;
}

const SKIP_STATUSES = new Set(["pending", "skipped", "todo", "disabled"]);

/** 把 Vitest JSON 报告展平成 repo-relative、POSIX 化的 assertion 列表（形状不符即抛错）。 */
export function collectVitestAssertions(json: unknown, repoRoot: string): VitestAssertion[] {
  if (typeof json !== "object" || json === null || !Array.isArray((json as { testResults?: unknown }).testResults)) {
    throw new Error("unknown vitest json shape（缺 testResults 数组）");
  }
  const out: VitestAssertion[] = [];
  for (const result of (json as { testResults: Array<{ name?: unknown; assertionResults?: unknown }> }).testResults) {
    if (typeof result.name !== "string" || !Array.isArray(result.assertionResults)) {
      throw new Error("unknown vitest testResult row shape");
    }
    const file = path.relative(repoRoot, result.name).split(path.sep).join("/");
    for (const raw of result.assertionResults as Array<{ fullName?: unknown; title?: unknown; status?: unknown }>) {
      if (typeof raw.status !== "string") throw new Error(`unknown vitest assertion shape in ${file}`);
      out.push({
        file,
        fullName: typeof raw.fullName === "string" ? raw.fullName : "",
        title: typeof raw.title === "string" ? raw.title : "",
        status: raw.status,
      });
    }
  }
  return out;
}

/** repo-relative、POSIX、按文件名排序的 skip manifest（不解析面向人的 stdout）。 */
export function buildSkipManifest(assertions: readonly VitestAssertion[]): Array<{ file: string; tests: number }> {
  const byFile = new Map<string, number>();
  for (const a of assertions) {
    if (!SKIP_STATUSES.has(a.status)) continue;
    byFile.set(a.file, (byFile.get(a.file) ?? 0) + 1);
  }
  return [...byFile.entries()]
    .filter(([, tests]) => tests > 0)
    .map(([file, tests]) => ({ file, tests }))
    .sort((a, b) => a.file.localeCompare(b.file));
}

export function summarizeVitest(assertions: readonly VitestAssertion[]): {
  files: number;
  tests: number;
  passed: number;
  failed: number;
  skipped: number;
} {
  const files = new Set(assertions.map((a) => a.file));
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const a of assertions) {
    if (a.status === "passed") passed += 1;
    else if (a.status === "failed") failed += 1;
    else if (SKIP_STATUSES.has(a.status)) skipped += 1;
  }
  return { files: files.size, tests: assertions.length, passed, failed, skipped };
}

// ─── 负向 sentinel 派生 ────────────────────────────────────────────────

export interface SentinelEvidence {
  readonly matchers: number;
  readonly passed: number;
  readonly failed: number;
  readonly missing: readonly string[];
  readonly tests: readonly string[];
}

/**
 * 每个 sentinel 的证据只来自本次报告里 status=passed 的用例；
 * 未跑到（missing）与 failed 都会被显式列出。
 */
export function deriveNegativeSentinels(
  assertions: readonly VitestAssertion[],
  matrix: Readonly<Record<string, readonly SentinelMatcher[]>> = N29_NEGATIVE_SENTINEL_MATRIX,
): Record<string, SentinelEvidence> {
  const out: Record<string, SentinelEvidence> = {};
  for (const [sentinel, matchers] of Object.entries(matrix)) {
    const tests: string[] = [];
    const missing: string[] = [];
    let passed = 0;
    let failed = 0;
    for (const matcher of matchers) {
      const hits = assertions.filter((a) => a.file === matcher.file && matcher.pattern.test(a.fullName));
      // P1-3 exact denominator：matcher 零命中、或命中但没有一条 passed，都按未覆盖计。
      const passingHits = hits.filter((h) => h.status === "passed");
      if (hits.length === 0 || passingHits.length === 0) {
        missing.push(`${matcher.file}::${String(matcher.pattern)}`);
      }
      for (const hit of hits) {
        if (hit.status === "passed") {
          passed += 1;
          tests.push(`${hit.file}::${hit.title}`);
        } else if (hit.status === "failed") {
          failed += 1;
        }
      }
    }
    out[sentinel] = { matchers: matchers.length, passed, failed, missing, tests: tests.sort() };
  }
  return out;
}

// ─── 台账校验与正向分母核对 ────────────────────────────────────────────

export function parseLedger(raw: unknown): N29IntakeLedger {
  if (typeof raw !== "object" || raw === null) throw new Error("ledger 不是对象");
  const l = raw as Record<string, unknown>;
  if (l["version"] !== N29_LEDGER_VERSION) throw new Error(`ledger version 不符：${String(l["version"])}`);
  if (typeof l["positives"] !== "object" || l["positives"] === null) throw new Error("ledger 缺 positives");
  if (typeof l["negatives"] !== "object" || l["negatives"] === null) throw new Error("ledger 缺 negatives");
  if (typeof l["policy"] !== "object" || l["policy"] === null) throw new Error("ledger 缺 policy");
  if (typeof l["writtenAt"] !== "string" || l["writtenAt"] === "") throw new Error("ledger 缺 writtenAt");
  return raw as N29IntakeLedger;
}

export interface DenominatorRow {
  readonly name: string;
  readonly required: number;
  readonly actual: number | null;
  readonly ok: boolean;
}

/** 缺失 / 非有限数 / 0 / 低于下限一律 ok=false（计划 §5 Step 5 的"零分母即 NO-GO"）。 */
export function checkDenominators(
  observed: Readonly<Record<string, number>> | undefined,
  required: Readonly<Record<string, number>>,
): DenominatorRow[] {
  return Object.entries(required)
    .map(([name, min]) => {
      const raw = observed?.[name];
      const actual = typeof raw === "number" && Number.isFinite(raw) ? raw : null;
      return { name, required: min, actual, ok: actual !== null && actual > 0 && actual >= min };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface N29EvaluatorResult {
  readonly decision: "PASS" | "FAIL";
  readonly evaluatedCommit: string | null;
  readonly ledgerBoundToCommit: boolean;
  readonly policyDigest: string;
  readonly positives: readonly DenominatorRow[];
  readonly ledgerNegatives: readonly DenominatorRow[];
  readonly reasons: readonly string[];
}

/**
 * provisional 判据：台账绑定 + 正向分母 + 集成套件自身的组合层负向计数。
 * 不含跨套件 sentinel 矩阵与其它门禁——那些由 acceptance driver 汇总。
 */
export function evaluateN29Ledger(input: {
  ledger: unknown;
  expectedCommit?: string | null;
}): N29EvaluatorResult {
  const reasons: string[] = [];
  let ledger: N29IntakeLedger | null = null;
  try {
    ledger = parseLedger(input.ledger);
  } catch (error) {
    reasons.push(`ledger 不可用：${error instanceof Error ? error.message : String(error)}`);
  }
  const positives = checkDenominators(ledger?.positives, N29_REQUIRED_POSITIVES);
  const ledgerNegatives = checkDenominators(ledger?.negatives, N29_REQUIRED_LEDGER_NEGATIVES);
  for (const row of positives) if (!row.ok) reasons.push(`positive denominator ${row.name}: actual=${String(row.actual)} required>=${row.required}`);
  for (const row of ledgerNegatives) if (!row.ok) reasons.push(`ledger negative ${row.name}: actual=${String(row.actual)} required>=${row.required}`);

  const expected = input.expectedCommit ?? null;
  const ledgerBoundToCommit = expected === null ? ledger !== null : ledger?.evaluatedCommit === expected;
  if (!ledgerBoundToCommit) {
    reasons.push(`ledger evaluatedCommit=${String(ledger?.evaluatedCommit)} != expected=${String(expected)}`);
  }
  const policyDigest = ledger?.policy?.digest ?? "";
  // digest 由生产 `computePolicyDigest` 产出（base64url canonical digest）；
  // 这里只要求"存在、无空白、足够长"，不锁死编码形态。
  if (!/^[A-Za-z0-9_\-+=/]{32,}$/.test(policyDigest)) reasons.push(`ledger policy digest 非法：${policyDigest || "(空)"}`);

  return {
    decision: reasons.length === 0 ? "PASS" : "FAIL",
    evaluatedCommit: ledger?.evaluatedCommit ?? null,
    ledgerBoundToCommit,
    policyDigest,
    positives,
    ledgerNegatives,
    reasons,
  };
}

// ─── CLI（开发期自查；不产生权威结论） ─────────────────────────────────

function dockerAvailable(): boolean {
  const docker = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8", timeout: 15_000 });
  return docker.status === 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repoRoot = process.cwd();
  if (!dockerAvailable()) {
    process.stdout.write(`${JSON.stringify({ decision: "ENVIRONMENT-UNAVAILABLE", reason: "docker/postgres 不可用" }, null, 2)}\n`);
    process.exitCode = 2;
  } else {
    const dir = mkdtempSync(path.join(tmpdir(), "n29-eval-"));
    const ledgerPath = path.join(dir, "ledger.json");
    const reportPath = path.join(dir, "focused.json");
    const suite = "test/pth-knowledge-intake/minimal-loop.integration.test.ts";
    const run = spawnSync(
      `npx vitest run ${suite} --reporter=json --outputFile ${reportPath}`,
      {
        shell: true,
        encoding: "utf8",
        cwd: repoRoot,
        timeout: 1_800_000,
        env: { ...process.env, N29_INTAKE_LEDGER: ledgerPath, N29_ACCEPT_COMMIT: "" },
      },
    );
    let ledger: unknown = null;
    let skipped: Array<{ file: string; tests: number }> = [];
    let totals: ReturnType<typeof summarizeVitest> | null = null;
    try {
      ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
    } catch { /* 台账缺失 → evaluateN29Ledger 会给出 FAIL 原因 */ }
    try {
      const assertions = collectVitestAssertions(JSON.parse(readFileSync(reportPath, "utf8")), repoRoot);
      skipped = buildSkipManifest(assertions);
      totals = summarizeVitest(assertions);
    } catch { /* 报告缺失 → 下面按 exitCode 记录 */ }
    const result = evaluateN29Ledger({ ledger, expectedCommit: null });
    const out = { suite, exitCode: run.status, totals, skipped, ...result };
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    rmSync(dir, { recursive: true, force: true });
    process.exitCode = run.status === 0 && result.decision === "PASS" && skipped.length === 0 ? 0 : 1;
  }
}
