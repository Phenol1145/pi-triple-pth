/**
 * test/pth-knowledge-intake/minimal-loop.integration.test.ts — N29 Task 6（L6）内环状态机红/绿测。
 *
 * 覆盖 plan §2.1 的一条完整内环 + §5 Task 6 Step 1/5 的三次 acquisition：
 *   a) 初次摄入：policy → subscription → due run → fetch → admit → extract → verify → promote
 *      → official 通过**生产 Broker / KnowledgeContextProvider** 可见；
 *   b) 内容不变重爬：第二次抓取（条件请求命中 304）→ 只落一条 `unchanged` revision，
 *      不产生新 candidate、不晋升、run 正常 complete、nextCrawlAt 推进；
 *   c) 内容变化重爬：第三次抓取（新字节 + 新 ETag）→ 旧 official 先被标 `stale`
 *      （默认 authoritative 检索命中 0，但 asOf / history 仍可读）→ 新 candidate → 双核验
 *      → 晋升出 superseding official（明确 supersedes 旧条目）。
 *
 * 真实性边界（plan §2 Global Constraints / §2.4 G9）：
 *  - 真实 Testcontainers PostgreSQL、真实 schema、真实 PG repository 与事务；
 *  - 真实 Ed25519 签名 Trust Policy（生产 loadVerifiedTrustPolicy 验签）；
 *  - 真实 SourceFetchBroker（逐跳授权 / DNS 防线 / 字节预算 / 归一化）；
 *  - 真实 KnowledgeIngestor、真实 VerificationPlan、真实 Promotion、真实 side-effect outbox
 *    与生产 drainer（`createSideEffectDrainer` + service 注册的 intake stage handlers）；
 *  - **只替换** 两条外部缝：HTTP transport（`WebRequest`）与 `LlmFn` 后端。
 *    extractor / domain / adversarial 三个 processor 均为生产实现，evidence 由服务端重算。
 *
 * L7（Task 7 Step 1/2）追加：
 *  - **正向分母台账**：本套件把 initial / unchanged / changed / stale / supersede / domain verdict /
 *    adversarial verdict / promotion / Broker+Context retrieval 的**实测**计数写入
 *    `process.env.N29_INTAKE_LEDGER` 指向的 JSON（未设置该 env 时不落盘，行为不变）。
 *    计数只在对应断言通过之后累加，因此台账不能在断言失败时被填满。
 *  - **负向/故障矩阵**（§5 Task 7 Step 2 的组合层部分）：越权 subscribe、due 幂等、
 *    unchanged 零 candidate、stale 退出 authoritative、撤销传播 stale、跨 tenant 零可见、
 *    run CAS（错 token / 错 generation / 错 rowVersion / 跨 tenant）零写零 outbox。
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { createHash, generateKeyPairSync, randomUUID, sign as edSign } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { isVisible, PgMemoryStore } from "@away_from/pth-memory";

import { createPgPool } from "../../src/pth/kernel/storage/pg.js";
import { applySchema } from "../../src/pth/kernel/storage/schema.js";
import { createKnowledgeIntakeRepository } from "../../src/pth/kernel/storage/knowledge-intake-pg.js";
import {
  canonicalPolicySigningBytes,
  computePolicyDigest,
  createKnowledgeIngestor,
  createKnowledgeIntakeDueScanner,
  createKnowledgeIntakeService,
  createKnowledgeIntakeSubscriptionService,
  createPolicyBoundSourceFetchBroker,
  INTAKE_STAGE_OUTBOX_KINDS,
  loadVerifiedTrustPolicy,
} from "../../src/pth/execution/knowledge-intake/index.js";
import {
  createAdversarialReviewProcessor,
  createDomainReviewProcessor,
  createIntakeExtractProcessor,
  createKnowledgeContextProvider,
} from "../../src/pth/runner/index.js";
import {
  createKnowledgeBroker,
  createExecutionGrantService,
  createHmacGrantKeyProvider,
  createPgKnowledgeVerificationRepo,
} from "../../src/pth/execution/index.js";
import { createSideEffectDrainer, PgSideEffectOutbox } from "../../src/pth/tasking/index.js";
import type { ResolvedAddress, WebResponse } from "../../src/pth/impls/kernels/web-transport.js";
import type { LlmFn, LlmMessage, LlmResult } from "../../src/pth/kernel/interpreter/llm-fn.js";
import type {
  ExecutionGrant,
  SourceSubscription,
  TrustPolicyManifest,
  VerifiedTrustPolicy,
} from "../../src/pth/contracts/index.js";

/** 测试内 SQL 行形状（`src/types/pg.d.ts` 的 QueryResult 行默认 unknown；这里显式给出行形状以纳入 N29 typecheck 门禁）。 */
type SqlRow = Record<string, any>;

// ─── 固定域参数 ───────────────────────────────────────────────────────

const TENANT = "tenant-n29-l6";
const TENANT_B = "tenant-n29-l6-other";
const SPACE = "space-a";
const DOMAIN = "mathematics";
const ORIGIN = "https://docs.example.org";
const URI = `${ORIGIN}/guide/triangles`;
const RECRAWL_MS = 3_600_000;

const PRODUCER = "worker:extractor:producer";
const DOMAIN_REVIEWER = "worker:domain:mathematics-reviewer";
const ADVERSARIAL_REVIEWER = "worker:controller:adversarial";
const PROMOTER = "worker:memory-keeper";

const DECLARED = { sourceType: "bounded-html", contentType: "text/html", license: "public-domain" } as const;
const PUBLIC_ADDR: ResolvedAddress[] = [{ address: "93.184.216.34", family: 4 }];

const V1_SENTENCE = "The sum of the interior angles of a triangle equals 180 degrees.";
const V2_SENTENCE = "The sum of the interior angles of a triangle equals exactly 180 degrees in Euclidean geometry.";
const V1_HTML = `<html><body><h1>Euclid</h1><p>${V1_SENTENCE}</p></body></html>`;
const V2_HTML = `<html><body><h1>Euclid</h1><p>${V2_SENTENCE}</p></body></html>`;

const sha256Hex = (data: string | Uint8Array): string =>
  createHash("sha256").update(data instanceof Uint8Array ? Buffer.from(data) : Buffer.from(data, "utf8")).digest("hex");

/**
 * revision 行按 disposition 计数。`listRevisions` 以 (acquired_at, id) 排序，而同一次
 * acquisition 的 quarantine/admitted 两行 acquired_at 完全相同（取自不可变 envelope），
 * 行序由 uuid 决定 —— 因此断言只依赖「各 disposition 各几行」而不依赖行序。
 */
function dispositionCounts(revisions: readonly { disposition: string }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of revisions) out[r.disposition] = (out[r.disposition] ?? 0) + 1;
  return out;
}

// ─── L7 台账（正向分母 + 组合层负向 sentinel 的实测计数） ──────────────

/** 与 `scripts/eval-n29-minimal-intake.ts` 的 `N29_LEDGER_VERSION` 必须一致。 */
const LEDGER_VERSION = "n29-minimal-intake-ledger/1";
const LEDGER_PATH = process.env["N29_INTAKE_LEDGER"] ?? "";

const ledger = {
  version: LEDGER_VERSION,
  suite: "test/pth-knowledge-intake/minimal-loop.integration.test.ts",
  /** driver 用它证明台账来自被评估的那个 commit（未由 driver 驱动时为 null）。 */
  evaluatedCommit: process.env["N29_ACCEPT_COMMIT"] ?? null,
  writtenAt: "",
  tenantId: TENANT,
  space: SPACE,
  domain: DOMAIN,
  canonicalUri: URI,
  policy: { policyId: "", version: "", digest: "", keyId: "", humanPrincipalId: "", issuer: "" },
  positives: {
    initialIngestion: 0,
    unchangedRecrawl: 0,
    changedRecrawl: 0,
    staleWithdrawal: 0,
    supersede: 0,
    domainVerdict: 0,
    adversarialVerdict: 0,
    promotion: 0,
    brokerRetrieval: 0,
    contextRetrieval: 0,
    brokerContextRetrieval: 0,
  } as Record<string, number>,
  negatives: {
    subscribeOutOfScopeDenied: 0,
    dueScannerIdempotent: 0,
    unchangedNoNewCandidate: 0,
    staleNotAuthoritative: 0,
    policyRevocationStale: 0,
    crossTenantIsolation: 0,
    runCasRejected: 0,
  } as Record<string, number>,
  evidence: {
    subscriptionId: "",
    revisions: [] as Array<{ id: string; disposition: string; rawHash: string }>,
    officials: [] as Array<{
      entryId: string;
      contentHash: string;
      sourceRevisionId: string;
      artifactHash: string;
      quoteHash: string;
      locator: unknown;
      supersedes?: readonly string[];
    }>,
    verdicts: [] as Array<{ planId: string; kind: string; principalId: string }>,
  },
};

/** 只在对应断言已经通过之后调用；不接受任何"预置"分母。 */
function bump(group: "positives" | "negatives", key: string, by = 1): void {
  const bucket = ledger[group];
  bucket[key] = (bucket[key] ?? 0) + by;
}

function writeLedger(): void {
  if (!LEDGER_PATH) return;
  ledger.writtenAt = new Date().toISOString();
  ledger.positives["brokerContextRetrieval"] =
    (ledger.positives["brokerRetrieval"] ?? 0) + (ledger.positives["contextRetrieval"] ?? 0);
  writeFileSync(LEDGER_PATH, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
}

// ─── 可控 HTTP transport（唯一被替换的网络缝） ────────────────────────

interface ServedVersion {
  readonly html: string;
  readonly etag: string;
}

const served: { current: ServedVersion; requests: Array<{ url: string; ifNoneMatch?: string; status: number }> } = {
  current: { html: V1_HTML, etag: '"v1"' },
  requests: [],
};

function fakeResponse(body: string, status: number, headers: Record<string, string>): WebResponse {
  const chunk = new TextEncoder().encode(body);
  return {
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    body: async function* () {
      if (status !== 304) yield chunk;
    },
  };
}

const transport = async (
  url: URL,
  init: { signal: AbortSignal; addresses: ResolvedAddress[]; headers?: Readonly<Record<string, string>> },
): Promise<WebResponse> => {
  void init.signal;
  const ifNoneMatch = init.headers?.["if-none-match"];
  const version = served.current;
  const notModified = ifNoneMatch !== undefined && ifNoneMatch === version.etag;
  served.requests.push({
    url: url.toString(),
    ...(ifNoneMatch === undefined ? {} : { ifNoneMatch }),
    status: notModified ? 304 : 200,
  });
  if (notModified) {
    return fakeResponse("", 304, { etag: version.etag, "content-type": "text/html; charset=utf-8" });
  }
  return fakeResponse(version.html, 200, { "content-type": "text/html; charset=utf-8", etag: version.etag });
};

// ─── 可控 LlmFn 后端（唯一被替换的模型缝；processor 仍是生产实现） ────

const llmCalls: Array<{ kind: string; model: string }> = [];

const llm: LlmFn = {
  async complete(messages: LlmMessage[]): Promise<LlmResult> {
    const system = messages.find((m) => m.role === "system")?.content ?? "";
    const user = messages.find((m) => m.role === "user")?.content ?? "";
    if (/EXTRACTOR/i.test(system)) {
      // 真实抽取行为：只能从 prompt 里给出的 normalized representation 里逐字取一句。
      const match = /The sum of the interior angles[^.]*\./.exec(user);
      llmCalls.push({ kind: "extract", model: "stub-extract" });
      return {
        content: JSON.stringify({ claims: match ? [{ quote: match[0] }] : [] }),
        model: "stub-extract",
      };
    }
    if (/DOMAIN reviewer/i.test(system)) {
      llmCalls.push({ kind: "domain", model: "stub-domain" });
      return { content: JSON.stringify({ verdict: "pass", note: "quote matches the cited source span" }), model: "stub-domain" };
    }
    if (/ADVERSARIAL reviewer/i.test(system)) {
      llmCalls.push({ kind: "adversarial", model: "stub-adversarial" });
      return { content: JSON.stringify({ verdict: "pass", note: "no unsupported leap beyond the quoted span" }), model: "stub-adversarial" };
    }
    throw new Error(`unexpected llm prompt: ${system.slice(0, 60)}`);
  },
};

// ─── 真实签名 Trust Policy ────────────────────────────────────────────

function signedPolicy(): { manifest: TrustPolicyManifest; keyring: Record<string, string> } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const base: TrustPolicyManifest = {
    policyId: "policy-n29-l6",
    version: "1",
    tenantId: TENANT,
    spaces: [SPACE],
    validFrom: "2020-01-01T00:00:00.000Z",
    validUntil: "2099-01-01T00:00:00.000Z",
    approvedBy: { kind: "human", principalId: "human-alice", tenantId: TENANT, issuer: "ptl-human-interface" },
    approvalProof: { method: "signed-manifest", keyId: "human-alice", signature: "" },
    rules: [
      {
        ruleId: "rule-docs",
        effect: "allow",
        httpsOrigin: ORIGIN,
        pathPrefix: "/guide/",
        spaces: [SPACE],
        domains: [DOMAIN],
        sourceTypes: ["bounded-html"],
        contentTypes: ["text/html"],
        licenses: ["public-domain"],
        maxBytes: 1_000_000,
        redirectOrigins: [ORIGIN],
      },
    ],
    digest: "",
  };
  const digest = computePolicyDigest(base);
  const signature = edSign(
    null,
    canonicalPolicySigningBytes(base),
    privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  ).toString("base64");
  return {
    manifest: { ...base, digest, approvalProof: { ...base.approvalProof, signature } },
    keyring: { "human-alice": publicKey.export({ type: "spki", format: "pem" }).toString() },
  };
}

// ─── 组合根 ───────────────────────────────────────────────────────────

describe("N29 Task 6 最小可信摄入内环（真实 PG + 生产 outbox/handlers/Broker）", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Awaited<ReturnType<typeof createPgPool>>;
  let store: PgMemoryStore;
  let repo: ReturnType<typeof createKnowledgeIntakeRepository>;
  let verification: ReturnType<typeof createPgKnowledgeVerificationRepo>;
  let service: ReturnType<typeof createKnowledgeIntakeService>;
  let scanner: ReturnType<typeof createKnowledgeIntakeDueScanner>;
  let drainer: ReturnType<typeof createSideEffectDrainer>;
  let broker: ReturnType<typeof createKnowledgeBroker>;
  let context: ReturnType<typeof createKnowledgeContextProvider>;
  let policy: VerifiedTrustPolicy;
  let subscription: SourceSubscription;

  const grantService = createExecutionGrantService({
    keyProvider: createHmacGrantKeyProvider({ secret: "n29-l6-minimal-loop-secret-0123456789" }),
  });

  function grant(): ExecutionGrant {
    return grantService.issue({
      lease: { taskId: "task-n29-l6", leaseId: randomUUID(), generation: 1 },
      scope: { tenantId: TENANT, principalId: "worker:reader", roles: ["developer"], traceId: "trace-n29-l6", space: SPACE },
      workspace: { tenantId: TENANT, workspaceId: "ws-n29-l6", taskId: "task-n29-l6" },
      language: "ts",
      capabilities: ["memory.read"],
      ttlMs: 600_000,
    });
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    pool = await createPgPool({ connectionString: container.getConnectionUri() });
    await applySchema(pool);

    store = new PgMemoryStore(pool);
    repo = createKnowledgeIntakeRepository(pool, { leaseTtlMs: 120_000 });
    verification = createPgKnowledgeVerificationRepo(pool);

    const signed = signedPolicy();
    policy = await loadVerifiedTrustPolicy(signed.manifest, signed.keyring);
    ledger.policy = {
      policyId: policy.manifest.policyId,
      version: policy.manifest.version,
      digest: policy.manifest.digest,
      keyId: policy.manifest.approvalProof.keyId,
      humanPrincipalId: policy.manifest.approvedBy.principalId,
      issuer: policy.manifest.approvedBy.issuer,
    };

    const fetchBroker = createPolicyBoundSourceFetchBroker({
      // 闭包读取 `policy` 变量，使 P0-6 负向用例可在运行中轮换当前策略。
      policy: () => policy,
      declaredSource: DECLARED,
      lookup: async () => PUBLIC_ADDR,
      request: transport,
    });

    service = createKnowledgeIntakeService({
      pool,
      repository: repo,
      store,
      verification,
      policy: () => policy,
      broker: fetchBroker,
      ingestor: createKnowledgeIngestor({ pool, store, intake: repo }),
      extractor: createIntakeExtractProcessor({ llm }),
      domainReview: createDomainReviewProcessor({ llm }),
      adversarialReview: createAdversarialReviewProcessor({ llm }),
      principals: {
        producer: PRODUCER,
        domainReviewer: DOMAIN_REVIEWER,
        adversarialReviewer: ADVERSARIAL_REVIEWER,
        promoter: PROMOTER,
      },
      declared: DECLARED,
      producerRole: "recon-doc",
      promoterRole: "memory-keeper",
    });

    scanner = createKnowledgeIntakeDueScanner({ repository: repo, limit: 10 });
    drainer = createSideEffectDrainer({
      outbox: new PgSideEffectOutbox(pool),
      handlers: service.stageHandlers(),
      tickMs: 60_000,
    });

    broker = createKnowledgeBroker({
      grantService,
      dataWorld: {
        queryReadOnly: async (sql: string) => (await pool.query<SqlRow>(sql)).rows,
        memory: store,
      },
      isVisible: (meta, space) => isVisible(meta, space),
    });
    context = createKnowledgeContextProvider({
      memory: store,
      isVisible: (meta, space) => isVisible(meta, space),
    });
  }, 240_000);

  afterAll(async () => {
    writeLedger();
    await pool?.end();
    await container?.stop();
  }, 120_000);

  // ─── 辅助 ──────────────────────────────────────────────────────────

  /** 反复 drain 直到 run 终结（或达到轮次上限）。生产 drainer，不手动调 handler。 */
  async function drainUntilRunSettled(runId: string, maxRounds = 24): Promise<void> {
    for (let i = 0; i < maxRounds; i += 1) {
      await drainer.drainOnce();
      const run = await repo.getRun(TENANT, runId);
      if (run && (run.status === "completed" || run.status === "dead-letter")) return;
    }
  }

  /** 把 nextCrawlAt 拨到过去（CAS 重排程，不直接 UPDATE 表）。 */
  async function makeDue(): Promise<void> {
    const current = await repo.getSubscription(TENANT, subscription.id);
    expect(current).not.toBeNull();
    const moved = await repo.transitionSubscription({
      tenantId: TENANT,
      subscriptionId: subscription.id,
      expectedRowVersion: current!.rowVersion,
      toStatus: current!.status,
      nextCrawlAt: new Date(Date.now() - 60_000),
    });
    expect(moved).not.toBeNull();
    subscription = moved!;
  }

  async function officialEntries(): Promise<Array<{ id: string; content: string; status: string; meta: Record<string, unknown> }>> {
    const rows = await store.retrieve({ tenantId: TENANT, anchors: [DOMAIN], kinds: ["domain-fact"], status: ["official"] });
    return rows.map((e) => ({ id: e.id, content: e.content, status: e.status, meta: e.meta }));
  }

  async function allEntries(): Promise<Array<{ id: string; status: string; content: string }>> {
    const rows = await store.retrieve({ tenantId: TENANT, anchors: [DOMAIN], kinds: ["domain-fact"] });
    return rows.map((e) => ({ id: e.id, status: e.status, content: e.content }));
  }

  // ─── a) 初次摄入 ───────────────────────────────────────────────────

  it("service.stageHandlers() 就是生产 drainer 的注册面（五个阶段 kind 齐全）", () => {
    // batch-process.ts 用同一个工厂 Object.assign 进 createSideEffectDrainer({handlers})，
    // 因此这里断言的 kind 集合 == 生产 drainer 实际注册的集合。
    expect(Object.keys(service.stageHandlers()).sort()).toEqual([
      INTAKE_STAGE_OUTBOX_KINDS.fetch,
      INTAKE_STAGE_OUTBOX_KINDS.extract,
      INTAKE_STAGE_OUTBOX_KINDS.promote,
      INTAKE_STAGE_OUTBOX_KINDS.reviewAdversarial,
      INTAKE_STAGE_OUTBOX_KINDS.reviewDomain,
    ].sort());
  });

  it("subscribe(): 只经正式 application service 安装已验签 policy 并创建 probing Subscription", async () => {
    const subscriptions = createKnowledgeIntakeSubscriptionService({ repository: repo, policy: () => policy });
    subscription = await subscriptions.subscribe({
      space: SPACE,
      canonicalUri: URI,
      domainId: DOMAIN,
      recrawlIntervalMs: RECRAWL_MS,
      declared: DECLARED,
      nextCrawlAt: new Date(Date.now() - 1_000),
    });

    expect(subscription).toMatchObject({
      tenantId: TENANT,
      space: SPACE,
      canonicalUri: URI,
      domainId: DOMAIN,
      status: "probing",
      policyId: "policy-n29-l6",
      policyRuleId: "rule-docs",
    });

    // 策略镜像必须已落库（DB 行只是审计镜像；授权事实仍是签名 manifest）。
    const mirror = await pool.query<SqlRow>(
      `SELECT policy_digest FROM knowledge_trust_policies WHERE tenant_id = $1 AND policy_id = $2`,
      [TENANT, "policy-n29-l6"],
    );
    expect(mirror.rows[0]?.policy_digest).toBe(policy.manifest.digest);

    // 越权 URI（不在 pathPrefix 内）必须 fail closed，且不产生第二条 subscription。
    await expect(
      subscriptions.subscribe({
        space: SPACE,
        canonicalUri: `${ORIGIN}/private/secret`,
        domainId: DOMAIN,
        recrawlIntervalMs: RECRAWL_MS,
        declared: DECLARED,
      }),
    ).rejects.toThrow(/policy|authoriz/i);
    const count = await pool.query<SqlRow>(`SELECT count(*)::int AS n FROM knowledge_source_subscriptions WHERE tenant_id = $1`, [TENANT]);
    expect(count.rows[0].n).toBe(1);
    ledger.evidence.subscriptionId = subscription.id;
    bump("negatives", "subscribeOutOfScopeDenied");
  });

  it("due scanner 幂等：同一 due window 两次扫描只建一个 Run", async () => {
    const first = await scanner.scanOnce();
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ tenantId: TENANT, subscriptionId: subscription.id, reason: "initial", stage: "fetch", status: "queued" });

    const second = await scanner.scanOnce();
    expect(second).toHaveLength(0);

    const runs = await pool.query<SqlRow>(`SELECT count(*)::int AS n FROM knowledge_intake_runs WHERE tenant_id = $1`, [TENANT]);
    expect(runs.rows[0].n).toBe(1);

    const pending = await pool.query<SqlRow>(
      `SELECT count(*)::int AS n FROM side_effect_outbox WHERE tenant_id = $1 AND kind = $2`,
      [TENANT, INTAKE_STAGE_OUTBOX_KINDS.fetch],
    );
    expect(pending.rows[0].n).toBe(1);
    bump("negatives", "dueScannerIdempotent");
  });

  it("initial crawl：fetch → admit → extract → verify → promote 产出一条 official", async () => {
    const runId = (await pool.query<SqlRow>(`SELECT id FROM knowledge_intake_runs WHERE tenant_id = $1`, [TENANT])).rows[0].id as string;
    await drainUntilRunSettled(runId);

    const run = await repo.getRun(TENANT, runId);
    expect(run).toMatchObject({ stage: "complete", status: "completed" });
    expect(run?.sourceRevisionId).toBeTruthy();
    expect(run?.candidateId).toBeTruthy();
    expect(run?.verificationPlanId).toBeTruthy();

    // revision 链：raw-quarantine 与 admitted 是两条独立 append-only 行。
    // `listRevisions` 按 (acquired_at, id) 排序，而同一次 acquisition 的两行 acquired_at 完全相同
    // （取自不可变 envelope），行序由 uuid 决定 —— 断言按 disposition 定位，不依赖行序。
    const revisions = await repo.listRevisions(TENANT, subscription.id);
    expect(dispositionCounts(revisions)).toEqual({ "raw-quarantine": 1, admitted: 1 });
    const quarantined = revisions.find((r) => r.disposition === "raw-quarantine")!;
    const admitted = revisions.find((r) => r.disposition === "admitted")!;
    expect(admitted.derivedFromRevisionId).toBe(quarantined.id);
    expect(admitted.rawHash).toBe(sha256Hex(Buffer.from(V1_HTML, "utf8")));
    expect(admitted.usePolicyDecision?.decision).toBe("allow");

    // official 条目：内容 = 服务端从 normalized representation 重算的 quote。
    const officials = await officialEntries();
    expect(officials).toHaveLength(1);
    expect(officials[0]!.content).toBe(V1_SENTENCE);
    expect(officials[0]!.id).toBe(run?.candidateId);
    const evidence = officials[0]!.meta.evidence as Array<Record<string, unknown>>;
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      sourceRevisionId: admitted.id,
      sourceSubscriptionId: subscription.id,
      representation: "normalized-text",
      artifactHash: admitted.rawHash,
    });

    // 双 verdict 落持久行，且 domain / adversarial 是两个不同 principal。
    const verdicts = await verification.listVerdictRows(run!.verificationPlanId!, TENANT);
    expect(verdicts.map((v) => v.kind).sort()).toEqual(["adversarial", "domain"]);
    expect(new Set(verdicts.map((v) => v.principalId)).size).toBe(2);
    expect((await verification.getPlan(run!.verificationPlanId!, TENANT))?.status).toBe("satisfied");

    // subscription：probing → active，记录 lastSuccessfulRevisionId 与推进后的 nextCrawlAt。
    const sub = await repo.getSubscription(TENANT, subscription.id);
    expect(sub).toMatchObject({ status: "active", lastSuccessfulRevisionId: admitted.id });
    expect(Date.parse(sub!.nextCrawlAt)).toBeGreaterThan(Date.now());
    subscription = sub!;

    // 依赖边：candidate + knowledge-entry 两条，均未 stale。
    const deps = await repo.listDependencies(TENANT, subscription.id);
    expect(deps.filter((d) => d.stale)).toHaveLength(0);
    expect(deps.map((d) => d.dependentKind).sort()).toEqual(["candidate", "knowledge-entry"]);

    // ── L7 台账：分母只在上述断言全部通过之后累加 ──
    ledger.evidence.revisions = revisions.map((r) => ({ id: r.id, disposition: r.disposition, rawHash: r.rawHash }));
    ledger.evidence.officials.push({
      entryId: officials[0]!.id,
      contentHash: sha256Hex(officials[0]!.content),
      sourceRevisionId: String(evidence[0]!["sourceRevisionId"]),
      artifactHash: String(evidence[0]!["artifactHash"]),
      quoteHash: String(evidence[0]!["quoteHash"]),
      locator: evidence[0]!["locator"],
    });
    for (const v of verdicts) {
      ledger.evidence.verdicts.push({ planId: run!.verificationPlanId!, kind: String(v.kind), principalId: String(v.principalId) });
    }
    bump("positives", "initialIngestion");
    bump("positives", "promotion");
    bump("positives", "domainVerdict", verdicts.filter((v) => v.kind === "domain").length);
    bump("positives", "adversarialVerdict", verdicts.filter((v) => v.kind === "adversarial").length);
  }, 120_000);

  it("official 通过生产 Broker 与 KnowledgeContextProvider 可见（同一 evidence）", async () => {
    const officials = await officialEntries();
    const entryId = officials[0]!.id;

    const retrieved = await broker.query({ grant: grant(), op: "retrieve", anchors: [DOMAIN], kinds: ["domain-fact"], space: SPACE });
    expect(retrieved.ok).toBe(true);
    if (retrieved.ok) {
      expect((retrieved.entries as Array<{ id: string }>).map((e) => e.id)).toEqual([entryId]);
    }

    const got = await broker.query({ grant: grant(), op: "get", id: entryId, space: SPACE });
    expect(got.ok).toBe(true);
    if (got.ok) {
      expect((got.entry as { content: string }).content).toBe(V1_SENTENCE);
    }

    const built = await context.build({
      tenantId: TENANT,
      space: SPACE,
      roleId: "developer",
      domains: [DOMAIN],
      title: "triangle angles",
      text: V1_SENTENCE,
      catalogVersion: "test",
    });
    expect(built.entries.map((e) => e.entryId)).toContain(entryId);
    expect(built.entries.find((e) => e.entryId === entryId)?.evidence.length ?? 0).toBeGreaterThan(0);

    // L7 台账：两条生产消费面（Broker retrieve + Broker get）与 Context 各计一次命中。
    bump("positives", "brokerRetrieval", 2);
    bump("positives", "contextRetrieval");
  });

  // ─── b) 内容不变重爬 ───────────────────────────────────────────────

  it("unchanged recrawl：同内容 → 一条 unchanged revision、零新 candidate、零晋升", async () => {
    const before = {
      revisions: (await repo.listRevisions(TENANT, subscription.id)).length,
      entries: (await allEntries()).length,
      plans: (await pool.query<SqlRow>(`SELECT count(*)::int AS n FROM knowledge_verification_plans WHERE tenant_id = $1`, [TENANT])).rows[0].n as number,
      official: (await officialEntries())[0]!,
    };
    const llmCallsBefore = llmCalls.length;

    await makeDue();
    const created = await scanner.scanOnce();
    expect(created).toHaveLength(1);
    expect(created[0]!.reason).toBe("scheduled");
    await drainUntilRunSettled(created[0]!.id);

    const run = await repo.getRun(TENANT, created[0]!.id);
    expect(run).toMatchObject({ stage: "complete", status: "completed" });

    const revisions = await repo.listRevisions(TENANT, subscription.id);
    expect(revisions).toHaveLength(before.revisions + 1);
    const unchanged = revisions[revisions.length - 1]!;
    expect(unchanged.disposition).toBe("unchanged");
    expect(unchanged.rawHash).toBe(before.official.meta.intake && (before.official.meta.intake as Record<string, string>).artifactHash);
    expect(unchanged.previousRevisionId).toBe(subscription.lastSuccessfulRevisionId);

    // 条件请求真的发出去了，并被服务端以 304 回答（零成本重爬）。
    expect(served.requests.some((r) => r.status === 304)).toBe(true);

    // 无新 candidate / 无新 plan / 无新晋升 / 未调用任何 LLM。
    expect((await allEntries())).toHaveLength(before.entries);
    const plans = await pool.query<SqlRow>(`SELECT count(*)::int AS n FROM knowledge_verification_plans WHERE tenant_id = $1`, [TENANT]);
    expect(plans.rows[0].n).toBe(before.plans);
    expect(llmCalls.length).toBe(llmCallsBefore);

    const officials = await officialEntries();
    expect(officials).toHaveLength(1);
    expect(officials[0]!.id).toBe(before.official.id);
    expect(officials[0]!.meta.version).toBe(before.official.meta.version);

    // lastSuccessfulRevisionId 不变；nextCrawlAt 继续推进。
    const sub = await repo.getSubscription(TENANT, subscription.id);
    expect(sub!.lastSuccessfulRevisionId).toBe(subscription.lastSuccessfulRevisionId);
    expect(Date.parse(sub!.nextCrawlAt)).toBeGreaterThan(Date.now());
    // 依赖边未被误标 stale。
    expect((await repo.listDependencies(TENANT, subscription.id)).filter((d) => d.stale)).toHaveLength(0);
    subscription = sub!;

    ledger.evidence.revisions = revisions.map((r) => ({ id: r.id, disposition: r.disposition, rawHash: r.rawHash }));
    bump("positives", "unchangedRecrawl");
    bump("negatives", "unchangedNoNewCandidate");
  }, 120_000);

  // ─── c) 内容变化重爬 ───────────────────────────────────────────────

  it("changed recrawl：旧 official 先 stale（asOf 可读）→ 新 candidate → 双核验 → superseding official", async () => {
    const previous = (await officialEntries())[0]!;
    // 采样数据库时钟而非宿主机时钟——stale 转换用容器 now() 落库，宿主机/容器时钟漂移
    // 会让 host `new Date()` 的 asOf 判定在并行负载下漂移（既有 flake）。
    const asOfBeforeChange = (await pool.query<{ t: Date }>(`SELECT now() AS t`)).rows[0].t;
    served.current = { html: V2_HTML, etag: '"v2"' };

    await makeDue();
    const created = await scanner.scanOnce();
    expect(created).toHaveLength(1);
    await drainUntilRunSettled(created[0]!.id);

    const run = await repo.getRun(TENANT, created[0]!.id);
    expect(run).toMatchObject({ stage: "complete", status: "completed" });

    // 新一轮 raw-quarantine + admitted（累计：2 quarantine / 2 admitted / 1 unchanged）。
    const revisions = await repo.listRevisions(TENANT, subscription.id);
    expect(dispositionCounts(revisions)).toEqual({ "raw-quarantine": 2, admitted: 2, unchanged: 1 });
    const v2Hash = sha256Hex(Buffer.from(V2_HTML, "utf8"));
    const newAdmitted = revisions.find((r) => r.disposition === "admitted" && r.rawHash === v2Hash)!;
    expect(newAdmitted).toBeDefined();
    // 新 admitted 明确指回上一次成功 revision（supersede 链）与本轮 quarantine 行。
    expect(newAdmitted.previousRevisionId).toBe(subscription.lastSuccessfulRevisionId);
    const newQuarantine = revisions.find((r) => r.disposition === "raw-quarantine" && r.rawHash === v2Hash)!;
    expect(newAdmitted.derivedFromRevisionId).toBe(newQuarantine.id);

    // 旧 official 已被撤出 authoritative 检索，但仍以 stale 存在。
    const old = await store.get(previous.id, { tenantId: TENANT });
    expect(old?.status).toBe("stale");
    expect(old?.content).toBe(V1_SENTENCE);

    // 新 official 存在且内容来自 V2。
    const officials = await officialEntries();
    expect(officials).toHaveLength(1);
    const current = officials[0]!;
    expect(current.id).not.toBe(previous.id);
    expect(current.content).toBe(V2_SENTENCE);
    expect(current.id).toBe(run?.candidateId);

    // supersedes 关系双向显式。
    expect(current.meta.supersedes).toEqual([previous.id]);
    expect(old?.meta?.supersededBy).toBe(current.id);

    // 默认 authoritative 检索（Broker / Context）命中 0 条 stale。
    const retrieved = await broker.query({ grant: grant(), op: "retrieve", anchors: [DOMAIN], kinds: ["domain-fact"], space: SPACE });
    expect(retrieved.ok).toBe(true);
    if (retrieved.ok) {
      expect((retrieved.entries as Array<{ id: string }>).map((e) => e.id)).toEqual([current.id]);
    }
    const staleGet = await broker.query({ grant: grant(), op: "get", id: previous.id, space: SPACE });
    expect(staleGet).toMatchObject({ ok: false, status: 404 });

    // history / asOf 仍能读到 V1 的 official 状态。
    const history = await store.revisionHistory(previous.id, { tenantId: TENANT });
    expect(history.some((r) => r.status === "official" && r.content === V1_SENTENCE)).toBe(true);
    const asOf = await store.getAsOf(previous.id, { tenantId: TENANT, asOf: asOfBeforeChange });
    expect(asOf).toMatchObject({ status: "official", content: V1_SENTENCE });

    // 依赖边：旧 revision 的依赖 stale；新 revision 的依赖未 stale。
    const deps = await repo.listDependencies(TENANT, subscription.id);
    expect(deps.filter((d) => d.sourceRevisionId === newAdmitted.id).every((d) => !d.stale)).toBe(true);
    expect(deps.filter((d) => d.sourceRevisionId !== newAdmitted.id).every((d) => d.stale)).toBe(true);

    // 依赖刷新 outbox 已写出（变化重爬的 fan-out 事实）。
    const refresh = await pool.query<SqlRow>(
      `SELECT count(*)::int AS n FROM side_effect_outbox WHERE tenant_id = $1 AND kind = $2`,
      [TENANT, INTAKE_STAGE_OUTBOX_KINDS.dependencyRefresh],
    );
    expect(refresh.rows[0].n).toBeGreaterThan(0);

    const sub = await repo.getSubscription(TENANT, subscription.id);
    expect(sub).toMatchObject({ status: "active", lastSuccessfulRevisionId: newAdmitted.id });
    subscription = sub!;

    // ── L7 台账 ──
    const v2Evidence = (current.meta.evidence as Array<Record<string, unknown>>)[0]!;
    ledger.evidence.revisions = revisions.map((r) => ({ id: r.id, disposition: r.disposition, rawHash: r.rawHash }));
    ledger.evidence.officials.push({
      entryId: current.id,
      contentHash: sha256Hex(current.content),
      sourceRevisionId: String(v2Evidence["sourceRevisionId"]),
      artifactHash: String(v2Evidence["artifactHash"]),
      quoteHash: String(v2Evidence["quoteHash"]),
      locator: v2Evidence["locator"],
      supersedes: current.meta.supersedes as readonly string[],
    });
    bump("positives", "changedRecrawl");
    bump("positives", "staleWithdrawal");
    bump("positives", "supersede");
    bump("positives", "promotion");
    bump("positives", "brokerRetrieval");
    bump("negatives", "staleNotAuthoritative");
  }, 120_000);

  // ─── 撤销：停止重爬 + 依赖标 stale ─────────────────────────────────

  it("subscription 撤销：依赖项全部 stale，due scanner 不再建 run", async () => {
    const revoked = await service.revokeSubscription({
      tenantId: TENANT,
      subscriptionId: subscription.id,
      reason: "subscription-revoked",
    });
    expect(revoked.subscription?.status).toBe("revoked");
    expect(revoked.staleEntryIds.length).toBeGreaterThan(0);

    expect((await repo.listDependencies(TENANT, subscription.id)).every((d) => d.stale)).toBe(true);
    expect(await officialEntries()).toHaveLength(0);

    await scanner.scanOnce();
    const runs = await pool.query<SqlRow>(
      `SELECT count(*)::int AS n FROM knowledge_intake_runs WHERE tenant_id = $1 AND status IN ('queued','leased','waiting')`,
      [TENANT],
    );
    expect(runs.rows[0].n).toBe(0);
    bump("negatives", "policyRevocationStale");
  }, 60_000);

  // ─── 负向/故障矩阵（组合层；§5 Task 7 Step 2） ──────────────────────

  it("负向矩阵：跨 tenant 零可见（另一 tenant 读不到 subscription / revision / dependency / official）", async () => {
    expect(await repo.getSubscription(TENANT_B, subscription.id)).toBeNull();
    expect(await repo.listRevisions(TENANT_B, subscription.id)).toHaveLength(0);
    expect(await repo.listDependencies(TENANT_B, subscription.id)).toHaveLength(0);
    expect(await store.retrieve({ tenantId: TENANT_B, anchors: [DOMAIN], kinds: ["domain-fact"] })).toHaveLength(0);
    const subs = await pool.query<SqlRow>(`SELECT count(*)::int AS n FROM knowledge_source_subscriptions WHERE tenant_id = $1`, [TENANT_B]);
    expect(subs.rows[0].n).toBe(0);
    bump("negatives", "crossTenantIsolation");
  });

  it("负向矩阵：run CAS 错 token / 错 generation / 错 rowVersion / 跨 tenant 一律零写零 outbox", async () => {
    // 原 subscription 已撤销，因此另建一条同策略内 subscription，并用真实 due scanner 建 run。
    const subscriptions = createKnowledgeIntakeSubscriptionService({ repository: repo, policy: () => policy });
    const second = await subscriptions.subscribe({
      space: SPACE,
      canonicalUri: `${ORIGIN}/guide/other`,
      domainId: DOMAIN,
      recrawlIntervalMs: RECRAWL_MS,
      declared: DECLARED,
      nextCrawlAt: new Date(Date.now() - 1_000),
    });
    const created = await scanner.scanOnce();
    expect(created.map((r) => r.subscriptionId)).toEqual([second.id]);
    const run = created[0]!;
    const claimed = await repo.claimRun({
      tenantId: TENANT,
      runId: run.id,
      principalId: PRODUCER,
      executionId: "exec-n29-l7-cas",
    });
    expect(claimed).not.toBeNull();

    const countOutbox = async (): Promise<number> =>
      (await pool.query<SqlRow>(`SELECT count(*)::int AS n FROM side_effect_outbox WHERE tenant_id = $1`, [TENANT])).rows[0].n as number;
    const outboxBefore = await countOutbox();
    const base = {
      tenantId: TENANT,
      runId: run.id,
      fromStage: "fetch" as const,
      leaseToken: claimed!.leaseToken!,
      leaseGeneration: claimed!.leaseGeneration,
      expectedRowVersion: claimed!.rowVersion,
      // N29 refix P0-2：toStage 取 fromStage 的合法后继（fetch→admit）；
      // 否则这 4 条 CAS 反例会被"非法迁移边"提前拒绝而失去区分度。
      toStage: "admit" as const,
      status: "queued" as const,
      principalId: PRODUCER,
      executionId: "exec-n29-l7-cas",
      sideEffects: [
        { key: `intake.extract:${run.id}`, kind: INTAKE_STAGE_OUTBOX_KINDS.extract, payload: { runId: run.id } },
      ],
    };

    expect(await repo.transitionRun({ ...base, leaseToken: "tok:forged" })).toBeNull();
    expect(await repo.transitionRun({ ...base, leaseGeneration: claimed!.leaseGeneration + 7 })).toBeNull();
    expect(await repo.transitionRun({ ...base, expectedRowVersion: claimed!.rowVersion + 7 })).toBeNull();
    expect(await repo.transitionRun({ ...base, tenantId: TENANT_B })).toBeNull();

    expect(await countOutbox()).toBe(outboxBefore);
    const still = await repo.getRun(TENANT, run.id);
    expect(still).toMatchObject({ stage: "fetch", status: "leased", rowVersion: claimed!.rowVersion });
    bump("negatives", "runCasRejected", 4);
  }, 60_000);

  it("负向矩阵：unchanged 重爬遇到当前 use-policy deny → dead-letter + 依赖 official 撤出（P0-6）", async () => {
    // 独立 subscription：先完成初次摄入产出 official。
    const subscriptions = createKnowledgeIntakeSubscriptionService({ repository: repo, policy: () => policy });
    const sub = await subscriptions.subscribe({
      space: SPACE,
      canonicalUri: `${ORIGIN}/guide/policy-deny`,
      domainId: DOMAIN,
      recrawlIntervalMs: RECRAWL_MS,
      declared: DECLARED,
      nextCrawlAt: new Date(Date.now() - 1_000),
    });
    const first = await scanner.scanOnce();
    expect(first.map((r) => r.subscriptionId)).toEqual([sub.id]);
    await drainUntilRunSettled(first[0]!.id);
    const afterInitial = await repo.getRun(TENANT, first[0]!.id);
    expect(afterInitial).toMatchObject({ stage: "complete", status: "completed" });

    const before = await officialEntries();
    const target = before.find((e) => (e.meta.intake as { sourceSubscriptionId?: string } | undefined)?.sourceSubscriptionId === sub.id);
    expect(target).toBeDefined();

    // 建第二次重爬 run（subscription 仍 active）。
    const cur = await repo.getSubscription(TENANT, sub.id);
    const due = await repo.transitionSubscription({
      tenantId: TENANT,
      subscriptionId: sub.id,
      expectedRowVersion: cur!.rowVersion,
      toStatus: cur!.status,
      nextCrawlAt: new Date(Date.now() - 1_000),
    });
    expect(due).not.toBeNull();
    const second = await scanner.scanOnce();
    expect(second).toHaveLength(1);

    // P0-6 场景：策略轮换后 fetch 仍 allow（同源/同路径/同预算），
    // 但 use 阶段 domain 不再命中 → verdict=deny。内容未变 → 必须走 deny 分支，
    // 不得返回 unchanged-complete。
    const rotated = (() => {
      const { publicKey, privateKey } = generateKeyPairSync("ed25519");
      const base: TrustPolicyManifest = {
        policyId: "policy-n29-rotated",
        version: "1",
        tenantId: TENANT,
        spaces: [SPACE],
        validFrom: "2020-01-01T00:00:00.000Z",
        validUntil: "2099-01-01T00:00:00.000Z",
        approvedBy: { kind: "human", principalId: "human-alice", tenantId: TENANT, issuer: "ptl-human-interface" },
        approvalProof: { method: "signed-manifest", keyId: "human-alice", signature: "" },
        rules: [
          {
            ruleId: "rule-docs",
            effect: "allow",
            httpsOrigin: ORIGIN,
            pathPrefix: "/guide/",
            spaces: [SPACE],
            domains: [`not-${DOMAIN}`],
            sourceTypes: ["bounded-html"],
            contentTypes: ["text/html"],
            licenses: ["public-domain"],
            maxBytes: 1_000_000,
            redirectOrigins: [ORIGIN],
          },
        ],
        digest: "",
      };
      const digest = computePolicyDigest(base);
      const signature = edSign(
        null,
        canonicalPolicySigningBytes(base),
        privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      ).toString("base64");
      const manifest = { ...base, digest, approvalProof: { ...base.approvalProof, signature } };
      const keyring = { "human-alice": publicKey.export({ type: "spki", format: "pem" }).toString() };
      return loadVerifiedTrustPolicy(manifest, keyring);
    })();
    policy = await rotated;

    await drainUntilRunSettled(second[0]!.id);
    const deniedRun = await repo.getRun(TENANT, second[0]!.id);
    // P0-6：内容未变但 use-policy deny → 不得返回 unchanged-complete；run dead-letter。
    expect(deniedRun).toMatchObject({ stage: "fetch", status: "dead-letter" });

    // 依赖 official 必须被撤出 authoritative 面（stale），依赖边 stale。
    const staleDeps = (await repo.listDependencies(TENANT, sub.id)).filter((d) => d.stale);
    expect(staleDeps.length).toBeGreaterThan(0);
    const stillOfficial = await store.retrieve({ tenantId: TENANT, anchors: [DOMAIN], kinds: ["domain-fact"], status: ["official"] });
    expect(stillOfficial.some((e) => e.id === target!.id)).toBe(false);
    bump("negatives", "unchangedPolicyDenyDeadLetter");
  }, 120_000);
});
