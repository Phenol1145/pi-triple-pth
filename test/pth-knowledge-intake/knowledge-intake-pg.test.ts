/**
 * knowledge-intake-pg.test.ts — N29 Task 3 真实 PG 红/绿测（Subscription/Run/Artifact/Revision 真相源）。
 *
 * 覆盖（plan §5 Task 3 Step 1）：
 *  - verified policy manifest append-only 审计镜像（exact 重放幂等；同版本不同 digest 显式 conflict）；
 *  - subscription 去重（tenant+space+canonicalUri）与 probe/active/paused/revoked/retired 迁移 rowVersion CAS；
 *  - due run 原子创建：FOR UPDATE SKIP LOCKED + 同事务推进 next_crawl_at + 同事务 enqueue outbox；
 *  - 双 scanner 并发只建一个 run、next_crawl_at 只推进一次、只入队一条 outbox；
 *  - lease expiry recovery（generation 递增、旧 token 失效）；
 *  - 错 token / 错 generation / 错 rowVersion / 跨 tenant 一律零写且零 outbox；
 *  - artifact raw_hash tenant 内去重（返回既有 artifact id）、跨 tenant 不共享；
 *  - raw-quarantine 与 admitted 是彼此独立的 append-only 行（不得原地 UPDATE 正文）；
 *  - dependency append-only + stale 标记 tenant+subscription 作用域、跨 tenant 零可见。
 *
 * 本套件不使用 Docker skip 守卫：Task 3 的结论只能由真实 PostgreSQL 给出。
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash, generateKeyPairSync, sign as edSign } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createPgPool } from "../../src/pth/kernel/storage/pg.js";
import { applySchema } from "../../src/pth/kernel/storage/schema.js";
import {
  createKnowledgeIntakeRepository,
  KnowledgeIntakeConflictError,
  KnowledgeIntakeValidationError,
} from "../../src/pth/kernel/storage/knowledge-intake-pg.js";
import {
  canonicalPolicySigningBytes,
  computePolicyDigest,
  loadVerifiedTrustPolicy,
} from "../../src/pth/execution/knowledge-intake/index.js";
// P0-3 对抗测专用：直接使用内部 attestation 模块（故意不从 contracts barrel 导出）。
import { attestVerifiedTrustPolicy } from "../../src/pth/contracts/knowledge-intake-attestation.js";
import type {
  IntakeRunStage,
  IntakeRunStatus,
  KnowledgeIntakeRepository,
  SourceRevision,
  SourceSubscription,
  StoreAcquisitionInput,
  TrustPolicyManifest,
  VerifiedTrustPolicy,
} from "../../src/pth/contracts/index.js";

/** 测试内 SQL 行形状（`src/types/pg.d.ts` 的 QueryResult 行默认 unknown；这里显式给出行形状以纳入 N29 typecheck 门禁）。 */
type SqlRow = Record<string, any>;

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
/** P0-4：从落库字节重算 artifact hash（断言"服务端可重算"而不是相信自报值）。 */
const sha256OfBuffer = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const SIGNER = "human:alice";

/** 未签名的 manifest 正文（digest/signature 留空，由 `signManifest()` 用生产算法补齐）。 */
function manifestBody(tenantId: string, over: Partial<TrustPolicyManifest> = {}): TrustPolicyManifest {
  return {
    policyId: "policy-intake",
    version: "v1",
    tenantId,
    spaces: ["space-a"],
    validFrom: "2026-01-01T00:00:00.000Z",
    validUntil: "2099-01-01T00:00:00.000Z",
    approvedBy: { kind: "human", principalId: SIGNER, tenantId, issuer: "ptl-human-interface" },
    approvalProof: { method: "signed-manifest", keyId: SIGNER, signature: "" },
    rules: [
      {
        ruleId: "rule-1",
        effect: "allow",
        httpsOrigin: "https://docs.example.org",
        pathPrefix: "/guide/",
        spaces: ["space-a"],
        domains: ["mathematics"],
        sourceTypes: ["html"],
        contentTypes: ["text/html"],
        licenses: ["cc-by-4.0"],
        maxBytes: 1_000_000,
        redirectOrigins: ["https://docs.example.org"],
      },
    ],
    digest: "",
    ...over,
  };
}

/**
 * 真实 Ed25519 detached signature + 生产 canonical digest。
 *
 * 全套件共用一对密钥（只暴露 public key）：Ed25519 签名对相同字节是确定性的，
 * 因此“同 tenant 同策略正文”重复安装得到 **完全相同** 的 manifest → exact 重放幂等。
 */
let suiteKeypairCache: { publicKeyPem: string; privateKeyPem: string } | null = null;
function suiteKeypair(): { publicKeyPem: string; privateKeyPem: string } {
  if (!suiteKeypairCache) {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    suiteKeypairCache = {
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
      privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    };
  }
  return suiteKeypairCache;
}

function signManifest(body: TrustPolicyManifest): { manifest: TrustPolicyManifest; keyring: Record<string, string> } {
  const { publicKeyPem, privateKeyPem } = suiteKeypair();
  const digest = computePolicyDigest(body);
  const signature = edSign(null, canonicalPolicySigningBytes(body), privateKeyPem).toString("base64");
  return {
    manifest: { ...body, digest, approvalProof: { ...body.approvalProof, signature } },
    keyring: { [body.approvalProof.keyId]: publicKeyPem },
  };
}

/** 唯一合法入口：经生产 verifier 产出带运行时 attestation 的 VerifiedTrustPolicy。 */
function signedFor(
  tenantId: string,
  over: Partial<TrustPolicyManifest> = {},
): { manifest: TrustPolicyManifest; keyring: Record<string, string> } {
  return signManifest(manifestBody(tenantId, over));
}

async function realVerifiedPolicy(
  tenantId: string,
  over: Partial<TrustPolicyManifest> = {},
): Promise<VerifiedTrustPolicy> {
  const signed = signedFor(tenantId, over);
  return await loadVerifiedTrustPolicy(signed.manifest, signed.keyring);
}

/**
 * P0-3 对抗输入：与 `VerifiedTrustPolicy` 完全同形的普通对象（TypeScript 结构类型不是运行时 attestation）。
 * 任何进程内调用者都能构造它——仓库必须在写事务之前拒绝。
 */
function forgedVerified(manifest: TrustPolicyManifest): VerifiedTrustPolicy {
  return {
    manifest,
    digest: manifest.digest,
    verifiedAt: "2026-08-19T00:00:00.000Z",
    verifiedBy: manifest.approvedBy,
    installedBy: SIGNER,
    authorizeFetch: () => {
      throw new Error("forged policy must never be consulted");
    },
    authorizeUse: () => {
      throw new Error("forged policy must never be consulted");
    },
  } as unknown as VerifiedTrustPolicy;
}

/**
 * 更强的对抗输入：直接用内部 attestation 模块盖章（模拟“验签器被误用/被绕过语义校验”），
 * 用来测仓库自己的纵深防御（human principal / issuer / attestation↔manifest 对账），
 * 而不是只测品牌是否存在。`manifestOverride` 用于模拟“验签后换 manifest”。
 */
function handAttested(attestedManifest: TrustPolicyManifest, manifestOverride?: TrustPolicyManifest): VerifiedTrustPolicy {
  const policy = forgedVerified(manifestOverride ?? attestedManifest) as {
    manifest: TrustPolicyManifest;
  } & VerifiedTrustPolicy;
  return attestVerifiedTrustPolicy(policy, {
    tenantId: attestedManifest.tenantId,
    policyId: attestedManifest.policyId,
    policyVersion: attestedManifest.version,
    digest: attestedManifest.digest,
    signerKind: "human",
    signerPrincipalId: attestedManifest.approvedBy.principalId,
    signerIssuer: attestedManifest.approvedBy.issuer,
    approvalMethod: attestedManifest.approvalProof.method,
    approvalKeyId: attestedManifest.approvalProof.keyId,
    verifiedAt: "2026-08-19T00:00:00.000Z",
  });
}

describe("knowledge intake PG 真相源（N29 Task 3）", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Awaited<ReturnType<typeof createPgPool>>;
  let repo: KnowledgeIntakeRepository;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    pool = await createPgPool({ connectionString: container.getConnectionUri() });
    await applySchema(pool);
    repo = createKnowledgeIntakeRepository(pool, { leaseTtlMs: 60_000 });
  }, 180_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
    // Docker 负载高时 container.stop() 可能超过默认 10s hookTimeout（既有 PG 套件的偶发 flake 源）。
  }, 120_000);

  /** 每个用例独立 tenant——共用容器不串扰。 */
  let seq = 0;
  const nextTenant = (label: string): string => `t-${label}-${++seq}`;

  async function installPolicy(tenantId: string): Promise<TrustPolicyManifest> {
    const policy = await realVerifiedPolicy(tenantId);
    await repo.installVerifiedPolicy(policy);
    return policy.manifest;
  }

  async function seedSubscription(
    tenantId: string,
    over: { status?: SourceSubscription["status"]; nextCrawlAt?: Date; canonicalUri?: string } = {},
  ): Promise<SourceSubscription> {
    const manifest = await installPolicy(tenantId);
    const created = await repo.createSubscription({
      tenantId,
      space: "space-a",
      canonicalUri: over.canonicalUri ?? "https://docs.example.org/guide/intro",
      domainId: "mathematics",
      policyId: manifest.policyId,
      policyVersion: manifest.version,
      policyDigest: manifest.digest,
      policyRuleId: manifest.rules[0].ruleId,
      recrawlIntervalMs: 3_600_000,
      nextCrawlAt: over.nextCrawlAt ?? new Date(Date.now() - 60_000),
    });
    if (over.status && over.status !== created.status) {
      const moved = await repo.transitionSubscription({
        tenantId,
        subscriptionId: created.id,
        expectedRowVersion: created.rowVersion,
        toStatus: over.status,
      });
      expect(moved).not.toBeNull();
      return moved as SourceSubscription;
    }
    return created;
  }

  async function countOutbox(tenantId: string): Promise<number> {
    const r = await pool.query<SqlRow>(`SELECT count(*)::int AS n FROM side_effect_outbox WHERE tenant_id = $1`, [tenantId]);
    return r.rows[0].n as number;
  }

  async function countRuns(tenantId: string): Promise<number> {
    const r = await pool.query<SqlRow>(`SELECT count(*)::int AS n FROM knowledge_intake_runs WHERE tenant_id = $1`, [tenantId]);
    return r.rows[0].n as number;
  }

  /**
   * storeAcquisition 的**合法**输入（N29 再验收 P0-4 的正向基线）：
   *  - `rawHash === sha256(rawBytes)`、`normalizedTextHash === sha256(normalizedText)`
   *    —— 两者都必须能由仓库服务端重算；
   *  - fetch/use decision 的 policy id/version/digest/rule 取自 Subscription 的策略绑定
   *    （= 已装策略审计镜像），因此 decision 与 Subscription/Policy 三方一致；
   *  - `admitted` 必须由调用方显式给出同 tenant/subscription 的 raw-quarantine 父 revision。
   *
   * `extra` 的每个字段都是一类**对抗输入**（错 hash / deny / 错父 / 错策略绑定），
   * 供 P0-4 负测逐项破坏单一不变量。
   */
  const acquisitionInput = (
    sub: SourceSubscription,
    runId: string,
    body: string,
    disposition: "raw-quarantine" | "admitted" | "unchanged",
    extra: {
      derivedFromRevisionId?: string;
      withUseDecision?: boolean;
      useDecision?: "allow" | "deny";
      rawHash?: string;
      byteLength?: number;
      normalizedTextHash?: string;
      policyId?: string;
      policyVersion?: string;
      policyDigest?: string;
      ruleId?: string;
      subscriptionId?: string;
    } = {},
  ): StoreAcquisitionInput => {
    const decisionOf = (decision: "allow" | "deny") => ({
      policyId: extra.policyId ?? sub.policyId,
      policyVersion: extra.policyVersion ?? sub.policyVersion,
      policyDigest: extra.policyDigest ?? sub.policyDigest,
      ruleId: extra.ruleId ?? sub.policyRuleId,
      decision,
      decidedAt: "2026-08-19T00:00:00.000Z",
    });
    return {
      tenantId: sub.tenantId,
      subscriptionId: extra.subscriptionId ?? sub.id,
      runId,
      artifact: {
        rawHash: extra.rawHash ?? sha(body),
        byteLength: extra.byteLength ?? Buffer.byteLength(body),
        rawBytes: new Uint8Array(Buffer.from(body)),
        contentType: "text/html",
      },
      revision: {
        requestedUri: "https://docs.example.org/guide/intro",
        finalUri: "https://docs.example.org/guide/intro",
        redirectChain: ["https://docs.example.org/guide/intro"],
        acquiredAt: "2026-08-19T00:00:00.000Z",
        responseStatus: 200,
        contentType: "text/html",
        etag: 'W/"v1"',
        normalizedText: body,
        normalizedTextHash: extra.normalizedTextHash ?? sha(body),
        disposition,
        fetchPolicyDecision: decisionOf("allow"),
        ...((extra.withUseDecision ?? disposition !== "raw-quarantine")
          ? { usePolicyDecision: decisionOf(extra.useDecision ?? "allow") }
          : {}),
        ...(extra.derivedFromRevisionId ? { derivedFromRevisionId: extra.derivedFromRevisionId } : {}),
      },
    };
  };

  /** 合法 admitted 只能派生自同 tenant/subscription 的 raw-quarantine 行（两条独立 append-only 行）。 */
  async function storeQuarantineThenAdmitted(
    sub: SourceSubscription,
    runId: string,
    body: string,
  ): Promise<{ quarantine: SourceRevision; admitted: SourceRevision }> {
    const quarantine = await repo.storeAcquisition(acquisitionInput(sub, runId, body, "raw-quarantine"));
    const admitted = await repo.storeAcquisition(
      acquisitionInput(sub, runId, body, "admitted", { derivedFromRevisionId: quarantine.id }),
    );
    return { quarantine, admitted };
  }

  // ---------------------------------------------------------------- schema 面

  it("七张最小表存在，可变聚合有 row_version，主查询键以 tenant_id 起头", async () => {
    const tables = [
      "knowledge_trust_policies",
      "knowledge_source_subscriptions",
      "knowledge_intake_runs",
      "knowledge_intake_attempts",
      "knowledge_source_artifacts",
      "knowledge_source_revisions",
      "knowledge_source_dependencies",
    ];
    for (const t of tables) {
      const r = await pool.query<SqlRow>(`SELECT to_regclass($1) AS r`, [t]);
      expect(r.rows[0].r, `table ${t} should exist`).toBeTruthy();
    }
    for (const t of ["knowledge_source_subscriptions", "knowledge_intake_runs", "knowledge_source_dependencies"]) {
      const r = await pool.query<SqlRow>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = $1 AND column_name = 'row_version'`,
        [t],
      );
      expect(r.rows, `${t}.row_version`).toHaveLength(1);
    }
    // 主键（复合）首列必须是 tenant_id
    for (const t of [
      "knowledge_trust_policies",
      "knowledge_source_subscriptions",
      "knowledge_intake_runs",
      "knowledge_source_artifacts",
      "knowledge_source_revisions",
    ]) {
      const r = await pool.query<SqlRow>(
        `SELECT a.attname
           FROM pg_index i
           JOIN pg_class c ON c.oid = i.indrelid
           JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = i.indkey[0]
          WHERE c.relname = $1 AND i.indisprimary`,
        [t],
      );
      expect(r.rows[0]?.attname, `${t} PK first column`).toBe("tenant_id");
    }
  });

  it("applySchema 幂等重放（二次执行不报错）", async () => {
    await applySchema(pool);
    const r = await pool.query<SqlRow>(`SELECT to_regclass('knowledge_source_revisions') AS r`);
    expect(r.rows[0].r).toBeTruthy();
  });

  // ---------------------------------------------------------------- policy 镜像

  it("installVerifiedPolicy：exact 重放幂等；manifest 正文不可 UPDATE", async () => {
    const tenantId = nextTenant("policy");
    const signed = signedFor(tenantId);
    const manifest = signed.manifest;
    await repo.installVerifiedPolicy(await loadVerifiedTrustPolicy(manifest, signed.keyring));
    // exact 重放：同 manifest 再验一次（新的 attestation）→ 幂等，仍然只有一行。
    await repo.installVerifiedPolicy(await loadVerifiedTrustPolicy(manifest, signed.keyring));
    const rows = await pool.query<SqlRow>(`SELECT * FROM knowledge_trust_policies WHERE tenant_id = $1`, [tenantId]);
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].policy_digest).toBe(manifest.digest);

    await expect(
      pool.query<SqlRow>(`UPDATE knowledge_trust_policies SET manifest = '{"hacked":true}'::jsonb WHERE tenant_id = $1`, [
        tenantId,
      ]),
    ).rejects.toThrow(/append-only|immutable/i);
    const after = await pool.query<SqlRow>(`SELECT manifest FROM knowledge_trust_policies WHERE tenant_id = $1`, [tenantId]);
    expect(after.rows[0].manifest.policyId).toBe(manifest.policyId);
  });

  it("installVerifiedPolicy：同 policyId/version 不同 digest 显式 conflict（DB 行不得替换策略）", async () => {
    const tenantId = nextTenant("policy-conflict");
    const manifest = await installPolicy(tenantId);
    // 同 policyId@version、真实签名、但正文不同（maxBytes 变化）→ digest 不同 → 显式 conflict。
    const other = await realVerifiedPolicy(tenantId, {
      rules: [{ ...manifestBody(tenantId).rules[0]!, maxBytes: 2_000_000 }],
    });
    expect(other.manifest.digest).not.toBe(manifest.digest);
    await expect(repo.installVerifiedPolicy(other)).rejects.toThrow(KnowledgeIntakeConflictError);
    const rows = await pool.query<SqlRow>(`SELECT policy_digest FROM knowledge_trust_policies WHERE tenant_id = $1`, [tenantId]);
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].policy_digest).toBe(manifest.digest);
  });

  // -------------------------------------------- P0-3：verified 边界必须是运行时 attestation

  async function countPolicies(tenantId: string): Promise<number> {
    const rows = await pool.query<SqlRow>(
      `SELECT count(*)::int AS n FROM knowledge_trust_policies WHERE tenant_id = $1`,
      [tenantId],
    );
    return rows.rows[0].n as number;
  }

  it("P0-3：结构同形但伪造 signature/digest 的 VerifiedTrustPolicy 安装为零行", async () => {
    const tenantId = nextTenant("policy-forged");
    const body = manifestBody(tenantId);
    const forged: TrustPolicyManifest = {
      ...body,
      digest: sha("forged-digest"),
      approvalProof: { ...body.approvalProof, signature: "definitely-not-valid" },
    };
    await expect(repo.installVerifiedPolicy(forgedVerified(forged))).rejects.toThrow(KnowledgeIntakeValidationError);
    await expect(repo.installVerifiedPolicy(forgedVerified(forged))).rejects.toThrow(/not verified|loadVerifiedTrustPolicy/);
    expect(await countPolicies(tenantId)).toBe(0);
  });

  it("P0-3：真实 verifier 产出的 policy 安装成功，其结构拷贝（丢失 attestation）被拒", async () => {
    const tenantId = nextTenant("policy-attested");
    const policy = await realVerifiedPolicy(tenantId);
    await repo.installVerifiedPolicy(policy);
    expect(await countPolicies(tenantId)).toBe(1);

    // spread 拷贝保留全部结构字段，但不再是被签发的那个对象 → 必须拒绝。
    const copy = { ...policy } as VerifiedTrustPolicy;
    await expect(repo.installVerifiedPolicy(copy)).rejects.toThrow(KnowledgeIntakeValidationError);
    expect(await countPolicies(tenantId)).toBe(1);
  });

  it("P0-3：service 签名的 policy（principal kind != human）安装为零行", async () => {
    const tenantId = nextTenant("policy-service-signer");
    const body = manifestBody(tenantId, {
      approvedBy: {
        kind: "service" as unknown as TrustPolicyManifest["approvedBy"]["kind"],
        principalId: SIGNER,
        tenantId,
        issuer: "ptl-human-interface",
      },
    });
    const signed = signManifest(body);
    // ① 生产 verifier 直接拒签（human signer 边界）。
    await expect(loadVerifiedTrustPolicy(signed.manifest, signed.keyring)).rejects.toThrow(/human signer/);
    // ② 绕开 verifier 直接调仓库同样零行。
    await expect(repo.installVerifiedPolicy(forgedVerified(signed.manifest))).rejects.toThrow(
      KnowledgeIntakeValidationError,
    );
    expect(await countPolicies(tenantId)).toBe(0);
  });

  it("P0-3：即使手工盖 attestation，service principal/错 issuer 仍被仓库拒（纵深防御）", async () => {
    const serviceTenant = nextTenant("policy-attested-service");
    const serviceBody = manifestBody(serviceTenant, {
      approvedBy: {
        kind: "service" as unknown as TrustPolicyManifest["approvedBy"]["kind"],
        principalId: SIGNER,
        tenantId: serviceTenant,
        issuer: "ptl-human-interface",
      },
    });
    await expect(repo.installVerifiedPolicy(handAttested(signManifest(serviceBody).manifest))).rejects.toThrow(
      /human principal/,
    );
    expect(await countPolicies(serviceTenant)).toBe(0);

    const issuerTenant = nextTenant("policy-attested-issuer");
    const issuerBody = manifestBody(issuerTenant, {
      approvedBy: {
        kind: "human",
        principalId: SIGNER,
        tenantId: issuerTenant,
        issuer: "ptl-platform-service" as unknown as TrustPolicyManifest["approvedBy"]["issuer"],
      },
    });
    await expect(repo.installVerifiedPolicy(handAttested(signManifest(issuerBody).manifest))).rejects.toThrow(
      /ptl-human-interface/,
    );
    expect(await countPolicies(issuerTenant)).toBe(0);
  });

  it("P0-3：attestation 与 manifest 身份不一致（验签后换 manifest）安装为零行", async () => {
    const tenantId = nextTenant("policy-attest-swap");
    const honest = signManifest(manifestBody(tenantId)).manifest;
    const swapped = signManifest(manifestBody(tenantId, { policyId: "policy-swapped" })).manifest;
    // attestation 记的是 honest 的身份，manifest 却换成了 swapped → 必须拒绝。
    const spliced = handAttested(honest, swapped);
    await expect(repo.installVerifiedPolicy(spliced)).rejects.toThrow(/attestation 与 manifest 不一致/);
    expect(await countPolicies(tenantId)).toBe(0);
  });

  it("P0-3（approach A）：注入 verifier 的仓库自行验签 raw manifest；伪签名仍零行", async () => {
    const tenantId = nextTenant("policy-injected-verifier");
    const signed = signedFor(tenantId);
    const verifyingRepo = createKnowledgeIntakeRepository(pool, {
      leaseTtlMs: 60_000,
      policyVerifier: (candidate) => loadVerifiedTrustPolicy(candidate, signed.keyring),
    });

    // 未盖章的同形对象：仓库用注入 verifier 重新验签 → 真签名通过。
    await verifyingRepo.installVerifiedPolicy(forgedVerified(signed.manifest));
    expect(await countPolicies(tenantId)).toBe(1);

    // 伪造 signature 的同形对象：重新验签失败 → 零新行。
    const forgedTenant = nextTenant("policy-injected-forged");
    const forgedSigned = signedFor(forgedTenant);
    const forged: TrustPolicyManifest = {
      ...forgedSigned.manifest,
      approvalProof: { ...forgedSigned.manifest.approvalProof, signature: "definitely-not-valid" },
    };
    const forgingRepo = createKnowledgeIntakeRepository(pool, {
      leaseTtlMs: 60_000,
      policyVerifier: (candidate) => loadVerifiedTrustPolicy(candidate, forgedSigned.keyring),
    });
    await expect(forgingRepo.installVerifiedPolicy(forgedVerified(forged))).rejects.toThrow(
      KnowledgeIntakeValidationError,
    );
    await expect(forgingRepo.installVerifiedPolicy(forgedVerified(forged))).rejects.toThrow(/not verified/);
    expect(await countPolicies(forgedTenant)).toBe(0);
  });

  it("P0-3（approach A）：注入 verifier 后连手工盖章的伪造 policy 也会被重新验签拒绝", async () => {
    const tenantId = nextTenant("policy-restamped-forgery");
    const honest = signedFor(tenantId);
    // 品牌齐全（手工盖章）+ 结构完整的 human manifest，但 signature 是伪造的：
    // 生产装配（注入 verifier）会无条件重新验签 → 密码学上拒绝。
    const forgedManifest: TrustPolicyManifest = {
      ...honest.manifest,
      approvalProof: { ...honest.manifest.approvalProof, signature: "definitely-not-valid" },
    };
    const verifyingRepo = createKnowledgeIntakeRepository(pool, {
      leaseTtlMs: 60_000,
      policyVerifier: (candidate) => loadVerifiedTrustPolicy(candidate, honest.keyring),
    });
    await expect(verifyingRepo.installVerifiedPolicy(handAttested(forgedManifest))).rejects.toThrow(
      KnowledgeIntakeValidationError,
    );
    expect(await countPolicies(tenantId)).toBe(0);
  });

  // ---------------------------------------------------------------- subscription

  it("createSubscription：probing 起步；同 tenant+space+uri 去重返回同一行", async () => {
    const tenantId = nextTenant("sub");
    const first = await seedSubscription(tenantId);
    expect(first.status).toBe("probing");
    expect(first.rowVersion).toBe(1);

    const again = await seedSubscription(tenantId);
    expect(again.id).toBe(first.id);
    const rows = await pool.query<SqlRow>(`SELECT count(*)::int AS n FROM knowledge_source_subscriptions WHERE tenant_id = $1`, [
      tenantId,
    ]);
    expect(rows.rows[0].n).toBe(1);
  });

  it("createSubscription：未安装（或 digest 不符）的 policy 绑定 fail closed，零写", async () => {
    const tenantId = nextTenant("sub-nopolicy");
    await expect(
      repo.createSubscription({
        tenantId,
        space: "space-a",
        canonicalUri: "https://docs.example.org/guide/x",
        domainId: "mathematics",
        policyId: "policy-intake",
        policyVersion: "v1",
        policyDigest: sha("unknown"),
        policyRuleId: "rule-1",
        recrawlIntervalMs: 1000,
        nextCrawlAt: new Date(),
      }),
    ).rejects.toThrow();

    const manifest = await installPolicy(tenantId);
    await expect(
      repo.createSubscription({
        tenantId,
        space: "space-a",
        canonicalUri: "https://docs.example.org/guide/x",
        domainId: "mathematics",
        policyId: manifest.policyId,
        policyVersion: manifest.version,
        policyDigest: sha("wrong-digest"),
        policyRuleId: "rule-1",
        recrawlIntervalMs: 1000,
        nextCrawlAt: new Date(),
      }),
    ).rejects.toThrow();

    const rows = await pool.query<SqlRow>(`SELECT count(*)::int AS n FROM knowledge_source_subscriptions WHERE tenant_id = $1`, [
      tenantId,
    ]);
    expect(rows.rows[0].n).toBe(0);
  });

  it("transitionSubscription：rowVersion CAS + 合法迁移；错 rowVersion/跨 tenant/非法迁移零写", async () => {
    const tenantId = nextTenant("sub-fsm");
    const sub = await seedSubscription(tenantId);

    const active = await repo.transitionSubscription({
      tenantId,
      subscriptionId: sub.id,
      expectedRowVersion: sub.rowVersion,
      toStatus: "active",
    });
    expect(active?.status).toBe("active");
    expect(active?.rowVersion).toBe(sub.rowVersion + 1);

    // 错 rowVersion（重放旧版本）→ 零写
    expect(
      await repo.transitionSubscription({
        tenantId,
        subscriptionId: sub.id,
        expectedRowVersion: sub.rowVersion,
        toStatus: "paused",
      }),
    ).toBeNull();
    // 跨 tenant → 零写
    expect(
      await repo.transitionSubscription({
        tenantId: `${tenantId}-other`,
        subscriptionId: sub.id,
        expectedRowVersion: active!.rowVersion,
        toStatus: "paused",
      }),
    ).toBeNull();
    expect((await repo.getSubscription(tenantId, sub.id))?.status).toBe("active");

    const paused = await repo.transitionSubscription({
      tenantId,
      subscriptionId: sub.id,
      expectedRowVersion: active!.rowVersion,
      toStatus: "paused",
    });
    expect(paused?.status).toBe("paused");
    const revoked = await repo.transitionSubscription({
      tenantId,
      subscriptionId: sub.id,
      expectedRowVersion: paused!.rowVersion,
      toStatus: "revoked",
    });
    expect(revoked?.status).toBe("revoked");
    // revoked 是终态：不得回到 active
    expect(
      await repo.transitionSubscription({
        tenantId,
        subscriptionId: sub.id,
        expectedRowVersion: revoked!.rowVersion,
        toStatus: "active",
      }),
    ).toBeNull();
    const retired = await repo.transitionSubscription({
      tenantId,
      subscriptionId: sub.id,
      expectedRowVersion: revoked!.rowVersion,
      toStatus: "retired",
    });
    expect(retired?.status).toBe("retired");
  });

  // ---------------------------------------------------------------- due scanner

  it("createDueRuns：active+due 建一个 run、同事务推进 next_crawl_at、同事务 enqueue intake.fetch", async () => {
    const tenantId = nextTenant("due");
    const sub = await seedSubscription(tenantId, { status: "active", nextCrawlAt: new Date(Date.now() - 60_000) });
    const before = await repo.getSubscription(tenantId, sub.id);

    const now = new Date();
    const runs = await repo.createDueRuns(now, 10, { tenantId });
    expect(runs).toHaveLength(1);
    expect(runs[0].subscriptionId).toBe(sub.id);
    expect(runs[0].stage).toBe("fetch");
    expect(runs[0].status).toBe("queued");
    expect(runs[0].reason).toBe("scheduled");

    const after = await repo.getSubscription(tenantId, sub.id);
    expect(Date.parse(after!.nextCrawlAt)).toBeGreaterThan(Date.parse(before!.nextCrawlAt));
    expect(Date.parse(after!.nextCrawlAt)).toBe(now.getTime() + sub.recrawlIntervalMs);
    expect(after!.rowVersion).toBe(before!.rowVersion + 1);

    const ob = await pool.query<SqlRow>(`SELECT key, kind, payload, status FROM side_effect_outbox WHERE tenant_id = $1`, [
      tenantId,
    ]);
    expect(ob.rowCount).toBe(1);
    expect(ob.rows[0].kind).toBe("intake.fetch");
    expect(ob.rows[0].payload.runId).toBe(runs[0].id);
    expect(ob.rows[0].status).toBe("pending");

    // 已有 open run 且 next_crawl_at 未到 → 再扫零 run
    expect(await repo.createDueRuns(new Date(), 10, { tenantId })).toHaveLength(0);
  });

  it("createDueRuns：probing 首轮为 initial；paused/revoked/retired 与未到期一律零 run", async () => {
    const probing = nextTenant("due-probing");
    const psub = await seedSubscription(probing, { nextCrawlAt: new Date(Date.now() - 1000) });
    expect(psub.status).toBe("probing");
    const pruns = await repo.createDueRuns(new Date(), 10, { tenantId: probing });
    expect(pruns).toHaveLength(1);
    expect(pruns[0].reason).toBe("initial");

    for (const status of ["paused", "revoked", "retired"] as const) {
      const tenantId = nextTenant(`due-${status}`);
      await seedSubscription(tenantId, { status, nextCrawlAt: new Date(Date.now() - 1000) });
      expect(await repo.createDueRuns(new Date(), 10, { tenantId })).toHaveLength(0);
      expect(await countOutbox(tenantId)).toBe(0);
    }

    const future = nextTenant("due-future");
    await seedSubscription(future, { status: "active", nextCrawlAt: new Date(Date.now() + 3_600_000) });
    expect(await repo.createDueRuns(new Date(), 10, { tenantId: future })).toHaveLength(0);
    expect(await countOutbox(future)).toBe(0);
  });

  it("双 scanner 并发：同一 due window 只建一个 run、next_crawl_at 只推进一次、只一条 outbox", async () => {
    const tenantId = nextTenant("due-race");
    const sub = await seedSubscription(tenantId, { status: "active", nextCrawlAt: new Date(Date.now() - 60_000) });
    const before = await repo.getSubscription(tenantId, sub.id);

    const [a, b] = await Promise.all([
      repo.createDueRuns(new Date(), 10, { tenantId }),
      repo.createDueRuns(new Date(), 10, { tenantId }),
    ]);
    expect(a.length + b.length).toBe(1);
    expect(await countRuns(tenantId)).toBe(1);
    expect(await countOutbox(tenantId)).toBe(1);

    const after = await repo.getSubscription(tenantId, sub.id);
    expect(after!.rowVersion).toBe(before!.rowVersion + 1);
  });

  // ---------------------------------------------------------------- lease / CAS

  it("claimRun：首次 claim 发 lease；未过期 lease 二次 claim 零写；错 tenant/rowVersion 零写", async () => {
    const tenantId = nextTenant("claim");
    const sub = await seedSubscription(tenantId, { status: "active" });
    const [run] = await repo.createDueRuns(new Date(), 10, { tenantId });

    const claimed = await repo.claimRun({
      tenantId,
      runId: run.id,
      principalId: "worker:scout",
      executionId: "exec-1",
      inputHash: sha("input-1"),
    });
    expect(claimed).not.toBeNull();
    expect(claimed!.status).toBe("leased");
    expect(claimed!.leaseGeneration).toBe(1);
    expect(claimed!.attempt).toBe(1);
    expect(claimed!.leaseToken).toBeTruthy();
    expect(Date.parse(claimed!.lockedUntil!)).toBeGreaterThan(Date.now());
    expect(claimed!.rowVersion).toBe(run.rowVersion + 1);

    // 未过期 lease → 第二个 worker 拿不到
    expect(
      await repo.claimRun({ tenantId, runId: run.id, principalId: "worker:other", executionId: "exec-2" }),
    ).toBeNull();
    // 跨 tenant → 零写
    expect(
      await repo.claimRun({ tenantId: `${tenantId}-other`, runId: run.id, principalId: "w", executionId: "e" }),
    ).toBeNull();
    // 错 expectedRowVersion → 零写
    expect(
      await repo.claimRun({
        tenantId,
        runId: run.id,
        principalId: "w",
        executionId: "e",
        expectedRowVersion: run.rowVersion,
      }),
    ).toBeNull();

    const fresh = await repo.getRun(tenantId, run.id);
    expect(fresh!.rowVersion).toBe(claimed!.rowVersion);
    expect(fresh!.leaseToken).toBe(claimed!.leaseToken);
    // 跨 tenant 读零可见
    expect(await repo.getRun(`${tenantId}-other`, run.id)).toBeNull();
  });

  it("lease 过期可由新 claim 回收：generation 递增、旧 token 立即失效", async () => {
    const tenantId = nextTenant("lease-expiry");
    await seedSubscription(tenantId, { status: "active" });
    const [run] = await repo.createDueRuns(new Date(), 10, { tenantId });

    const first = await repo.claimRun({
      tenantId,
      runId: run.id,
      principalId: "worker:a",
      executionId: "exec-a",
      leaseMs: 80,
    });
    expect(first!.leaseGeneration).toBe(1);
    await sleep(150);

    const second = await repo.claimRun({ tenantId, runId: run.id, principalId: "worker:b", executionId: "exec-b" });
    expect(second).not.toBeNull();
    expect(second!.leaseGeneration).toBe(2);
    expect(second!.attempt).toBe(2);
    expect(second!.leaseToken).not.toBe(first!.leaseToken);

    // 旧 token/generation 已失效：迁移零写 + 零 outbox
    expect(
      await repo.transitionRun({
        tenantId,
        runId: run.id,
        fromStage: "fetch",
        leaseToken: first!.leaseToken!,
        leaseGeneration: first!.leaseGeneration,
        expectedRowVersion: first!.rowVersion,
        toStage: "admit",
        status: "queued",
        principalId: "worker:a",
        executionId: "exec-a",
        sideEffects: [{ key: `stale:${run.id}`, kind: "intake.admit", payload: { runId: run.id } }],
      }),
    ).toBeNull();
    expect(await countOutbox(tenantId)).toBe(1); // 只有 due scanner 那条 intake.fetch

    // 新 lease 正常迁移
    const moved = await repo.transitionRun({
      tenantId,
      runId: run.id,
      fromStage: "fetch",
      leaseToken: second!.leaseToken!,
      leaseGeneration: second!.leaseGeneration,
      expectedRowVersion: second!.rowVersion,
      toStage: "admit",
      status: "queued",
      principalId: "worker:b",
      executionId: "exec-b",
      sideEffects: [{ key: `intake.admit:${run.id}`, kind: "intake.admit", payload: { runId: run.id } }],
    });
    expect(moved!.stage).toBe("admit");
    expect(moved!.status).toBe("queued");
    expect(moved!.leaseToken).toBeUndefined();
    expect(await countOutbox(tenantId)).toBe(2);
  });

  it("transitionRun：expired lease 零行、零 attempt、零 outbox（§8 条件 7 的提交门）", async () => {
    const tenantId = nextTenant("transition-expired-lease");
    await seedSubscription(tenantId, { status: "active" });
    const [run] = await repo.createDueRuns(new Date(), 10, { tenantId });
    const claimed = await repo.claimRun({
      tenantId,
      runId: run.id,
      principalId: "worker:a",
      executionId: "exec-a",
      leaseMs: 80,
    });
    await sleep(160);

    const attemptsBefore = (await repo.listAttempts(tenantId, run.id)).length;
    const outboxBefore = await countOutbox(tenantId);
    expect(
      await repo.transitionRun({
        tenantId,
        runId: run.id,
        fromStage: "fetch",
        leaseToken: claimed!.leaseToken!,
        leaseGeneration: claimed!.leaseGeneration,
        expectedRowVersion: claimed!.rowVersion,
        toStage: "admit",
        status: "queued",
        principalId: "worker:a",
        executionId: "exec-a",
        sideEffects: [{ key: `expired:${run.id}`, kind: "intake.admit", payload: { runId: run.id } }],
      }),
    ).toBeNull();
    // 过期 lease 提交不得留下任何 attempt / outbox 写。
    expect((await repo.listAttempts(tenantId, run.id)).length).toBe(attemptsBefore);
    expect(await countOutbox(tenantId)).toBe(outboxBefore);

    // 新 worker 正常回收后，同一边仍可提交（证明只拒绝过期 lease，没有打坏聚合）。
    const reclaimed = await repo.claimRun({ tenantId, runId: run.id, principalId: "worker:b", executionId: "exec-b" });
    expect(reclaimed!.leaseGeneration).toBe(2);
    const moved = await repo.transitionRun({
      tenantId,
      runId: run.id,
      fromStage: "fetch",
      leaseToken: reclaimed!.leaseToken!,
      leaseGeneration: reclaimed!.leaseGeneration,
      expectedRowVersion: reclaimed!.rowVersion,
      toStage: "admit",
      status: "queued",
      principalId: "worker:b",
      executionId: "exec-b",
      sideEffects: [{ key: `recovered:${run.id}`, kind: "intake.admit", payload: { runId: run.id } }],
    });
    expect(moved!.stage).toBe("admit");
    expect(await countOutbox(tenantId)).toBe(outboxBefore + 1);
  });

  it("transitionRun：错 token / 错 generation / 错 rowVersion / 跨 tenant 均零行且零 outbox", async () => {
    const tenantId = nextTenant("transition-cas");
    await seedSubscription(tenantId, { status: "active" });
    const [run] = await repo.createDueRuns(new Date(), 10, { tenantId });
    const claimed = await repo.claimRun({ tenantId, runId: run.id, principalId: "worker:a", executionId: "exec-a" });
    const base = {
      tenantId,
      runId: run.id,
      fromStage: "fetch" as const,
      leaseToken: claimed!.leaseToken!,
      leaseGeneration: claimed!.leaseGeneration,
      expectedRowVersion: claimed!.rowVersion,
      // N29 refix P0-2：toStage 必须是 fromStage 的合法后继（fetch→admit）；
      // 旧用例用 fetch→extract 做正向断言，会被合法迁移矩阵拒绝，从而掩盖本用例要钉的 4 个 CAS 字段。
      toStage: "admit" as const,
      status: "queued" as const,
      principalId: "worker:a",
      executionId: "exec-a",
      sideEffects: [{ key: `intake.extract:${run.id}`, kind: "intake.extract", payload: { runId: run.id } }],
    };

    expect(await repo.transitionRun({ ...base, leaseToken: "tok:forged" })).toBeNull();
    expect(await repo.transitionRun({ ...base, leaseGeneration: 99 })).toBeNull();
    expect(await repo.transitionRun({ ...base, expectedRowVersion: 99 })).toBeNull();
    expect(await repo.transitionRun({ ...base, tenantId: `${tenantId}-other` })).toBeNull();

    expect(await countOutbox(tenantId)).toBe(1); // 仅 intake.fetch
    const still = await repo.getRun(tenantId, run.id);
    expect(still!.rowVersion).toBe(claimed!.rowVersion);
    expect(still!.stage).toBe("fetch");
    expect(still!.status).toBe("leased");

    const ok = await repo.transitionRun(base);
    expect(ok!.stage).toBe("admit");
    expect(ok!.rowVersion).toBe(claimed!.rowVersion + 1);
    expect(await countOutbox(tenantId)).toBe(2);
  });

  // ── N29 再验收 P0-2：Run CAS 必须比较 fromStage 与真实 stage，并只允许冻结矩阵内的边 ──
  // 反例来源：docs/pth/n29-minimal-intake-reacceptance-feedback.md §3 P0-2 / §8 条件 2。

  it("N29 refix P0-2：真实 stage=fetch 时伪报 fromStage=promote→complete 零行零 outbox；随后 fetch→admit 成功", async () => {
    const tenantId = nextTenant("refix-fromstage");
    await seedSubscription(tenantId, { status: "active" });
    const [run] = await repo.createDueRuns(new Date(), 10, { tenantId });
    const claimed = await repo.claimRun({ tenantId, runId: run.id, principalId: "worker:a", executionId: "exec-a" });
    expect(claimed!.stage).toBe("fetch");

    // 本轮反例（旧实现 exit 0 通过）：fromStage 谎报为 promote，直接跳到 complete。
    const forged = await repo.transitionRun({
      tenantId,
      runId: run.id,
      fromStage: "promote",
      toStage: "complete",
      status: "completed",
      leaseToken: claimed!.leaseToken!,
      leaseGeneration: claimed!.leaseGeneration,
      expectedRowVersion: claimed!.rowVersion,
      principalId: "worker:a",
      executionId: "exec-a",
      sideEffects: [{ key: `forged:${run.id}`, kind: "intake.promote", payload: { runId: run.id } }],
    });
    expect(forged).toBeNull();

    // 零领域写：stage/status/rowVersion 完全不动；零 outbox（只有 due scanner 的 intake.fetch）。
    const untouched = await repo.getRun(tenantId, run.id);
    expect(untouched).toMatchObject({ stage: "fetch", status: "leased", rowVersion: claimed!.rowVersion });
    expect(await countOutbox(tenantId)).toBe(1);
    // 零 attempt 审计行增量（claim 的 leased 行之外没有任何结果行）。
    expect((await repo.listAttempts(tenantId, run.id)).map((a) => a.disposition)).toEqual(["leased"]);

    // 同一 lease 走合法边仍然成功（证明拒绝来自 fromStage/矩阵，而不是 lease 被打坏）。
    const ok = await repo.transitionRun({
      tenantId,
      runId: run.id,
      fromStage: "fetch",
      toStage: "admit",
      status: "queued",
      leaseToken: claimed!.leaseToken!,
      leaseGeneration: claimed!.leaseGeneration,
      expectedRowVersion: claimed!.rowVersion,
      principalId: "worker:a",
      executionId: "exec-a",
      sideEffects: [{ key: `intake.extract:${run.id}`, kind: "intake.extract", payload: { runId: run.id } }],
    });
    expect(ok).toMatchObject({ stage: "admit", status: "queued", rowVersion: claimed!.rowVersion + 1 });
    expect(await countOutbox(tenantId)).toBe(2);
  });

  it("N29 refix P0-2：fromStage 与真实 stage 不符（正确后继但错来源）零行", async () => {
    const tenantId = nextTenant("refix-wrong-from");
    await seedSubscription(tenantId, { status: "active" });
    const [run] = await repo.createDueRuns(new Date(), 10, { tenantId });
    const claimed = await repo.claimRun({ tenantId, runId: run.id, principalId: "worker:a", executionId: "exec-a" });

    // admit→verify 是矩阵内的合法边，但真实 stage 是 fetch → SQL 的 `stage = fromStage` 必须挡住。
    expect(
      await repo.transitionRun({
        tenantId,
        runId: run.id,
        fromStage: "admit",
        toStage: "verify",
        status: "queued",
        leaseToken: claimed!.leaseToken!,
        leaseGeneration: claimed!.leaseGeneration,
        expectedRowVersion: claimed!.rowVersion,
        principalId: "worker:a",
        executionId: "exec-a",
        sideEffects: [{ key: `wrong-from:${run.id}`, kind: "intake.review.domain", payload: { runId: run.id } }],
      }),
    ).toBeNull();

    expect(await repo.getRun(tenantId, run.id)).toMatchObject({
      stage: "fetch",
      status: "leased",
      rowVersion: claimed!.rowVersion,
    });
    expect(await countOutbox(tenantId)).toBe(1);
  });

  it("N29 refix P0-2：跳阶段/回退/终态出边等非法边全部零行零 outbox", async () => {
    const tenantId = nextTenant("refix-illegal-edges");
    await seedSubscription(tenantId, { status: "active" });
    const [run] = await repo.createDueRuns(new Date(), 10, { tenantId });
    const claimed = await repo.claimRun({ tenantId, runId: run.id, principalId: "worker:a", executionId: "exec-a" });
    const base = {
      tenantId,
      runId: run.id,
      leaseToken: claimed!.leaseToken!,
      leaseGeneration: claimed!.leaseGeneration,
      expectedRowVersion: claimed!.rowVersion,
      principalId: "worker:a",
      executionId: "exec-a",
    };

    // 真实 stage = fetch：所有非法 toStage（跳阶段）都必须零行。
    const illegalFromFetch: ReadonlyArray<[IntakeRunStage, IntakeRunStatus]> = [
      ["extract", "queued"],
      ["verify", "queued"],
      ["promote", "queued"],
    ];
    for (const [toStage, status] of illegalFromFetch) {
      expect(
        await repo.transitionRun({
          ...base,
          fromStage: "fetch",
          toStage,
          status,
          sideEffects: [{ key: `skip:${toStage}:${run.id}`, kind: `intake.${toStage}`, payload: { runId: run.id } }],
        }),
      ).toBeNull();
    }

    // status 也在矩阵内：completed 只能配 toStage=complete；非终点 stage 的 completed 必须零行。
    expect(await repo.transitionRun({ ...base, fromStage: "fetch", toStage: "admit", status: "completed" })).toBeNull();
    // dead-letter / failed 只能停在原地（自边），不得同时跨阶段推进。
    expect(await repo.transitionRun({ ...base, fromStage: "fetch", toStage: "admit", status: "dead-letter" })).toBeNull();
    expect(await repo.transitionRun({ ...base, fromStage: "fetch", toStage: "complete", status: "failed" })).toBeNull();
    // lease 只能由 claimRun() 签发：transitionRun 不得把 run 置回 leased/waiting。
    expect(await repo.transitionRun({ ...base, fromStage: "fetch", toStage: "fetch", status: "leased" })).toBeNull();
    expect(await repo.transitionRun({ ...base, fromStage: "fetch", toStage: "fetch", status: "waiting" })).toBeNull();

    expect(await repo.getRun(tenantId, run.id)).toMatchObject({
      stage: "fetch",
      status: "leased",
      rowVersion: claimed!.rowVersion,
    });
    expect(await countOutbox(tenantId)).toBe(1);
    expect((await repo.listAttempts(tenantId, run.id)).map((a) => a.disposition)).toEqual(["leased"]);

    // 推进到真实 stage = admit，继续钉 admit 的非法出边（含"当前不可达"的 extract 节点）。
    const admitted = await repo.transitionRun({
      ...base,
      fromStage: "fetch",
      toStage: "admit",
      status: "queued",
      sideEffects: [{ key: `intake.extract:${run.id}`, kind: "intake.extract", payload: { runId: run.id } }],
    });
    expect(admitted!.stage).toBe("admit");
    const reclaimed = await repo.claimRun({ tenantId, runId: run.id, principalId: "worker:b", executionId: "exec-b" });
    const admitBase = {
      tenantId,
      runId: run.id,
      leaseToken: reclaimed!.leaseToken!,
      leaseGeneration: reclaimed!.leaseGeneration,
      expectedRowVersion: reclaimed!.rowVersion,
      principalId: "worker:b",
      executionId: "exec-b",
      status: "queued" as const,
    };
    // extract 是不可达节点（抽取发生在 admit 阶段）：admit→extract 非法。
    expect(await repo.transitionRun({ ...admitBase, fromStage: "admit", toStage: "extract" })).toBeNull();
    // 回退（admit→fetch）与跳阶段（admit→promote）非法。
    expect(await repo.transitionRun({ ...admitBase, fromStage: "admit", toStage: "fetch" })).toBeNull();
    expect(await repo.transitionRun({ ...admitBase, fromStage: "admit", toStage: "promote" })).toBeNull();
    // admit 不是成功终点：admit→complete 非法（unchanged 完成只在 fetch 阶段）。
    expect(
      await repo.transitionRun({ ...admitBase, fromStage: "admit", toStage: "complete", status: "completed" }),
    ).toBeNull();

    expect(await repo.getRun(tenantId, run.id)).toMatchObject({
      stage: "admit",
      status: "leased",
      rowVersion: reclaimed!.rowVersion,
    });
    expect(await countOutbox(tenantId)).toBe(2); // intake.fetch + 上面那条合法 intake.extract
  });

  it("N29 refix P0-2：合法边逐条通过——fetch→admit→verify→(verify 自边 domain→adversarial)→promote→complete", async () => {
    const tenantId = nextTenant("refix-legal-path");
    await seedSubscription(tenantId, { status: "active" });
    const [run] = await repo.createDueRuns(new Date(), 10, { tenantId });

    // 生产链路的每一条边都必须在矩阵内（fetch→admit / admit→verify / verify→verify / verify→promote / promote→complete）。
    const edges: ReadonlyArray<[IntakeRunStage, IntakeRunStage, IntakeRunStatus]> = [
      ["fetch", "admit", "queued"],
      ["admit", "verify", "queued"],
      ["verify", "verify", "queued"], // domain → adversarial 的同 stage 特例
      ["verify", "promote", "queued"],
      ["promote", "complete", "completed"],
    ];
    let step = 0;
    for (const [fromStage, toStage, status] of edges) {
      const claimed = await repo.claimRun({
        tenantId,
        runId: run.id,
        principalId: "worker:a",
        executionId: `exec-${++step}`,
      });
      expect(claimed!.stage).toBe(fromStage);
      const moved = await repo.transitionRun({
        tenantId,
        runId: run.id,
        fromStage,
        toStage,
        status,
        leaseToken: claimed!.leaseToken!,
        leaseGeneration: claimed!.leaseGeneration,
        expectedRowVersion: claimed!.rowVersion,
        principalId: "worker:a",
        executionId: `exec-${step}`,
      });
      expect(moved).toMatchObject({ stage: toStage, status });
    }

    // complete 是终态：任何出边（含自边）都零行。
    const done = await repo.getRun(tenantId, run.id);
    expect(done).toMatchObject({ stage: "complete", status: "completed" });
    for (const toStage of ["complete", "fetch", "promote", "verify"] as const) {
      expect(
        await repo.transitionRun({
          tenantId,
          runId: run.id,
          fromStage: "complete",
          toStage,
          status: toStage === "complete" ? "completed" : "queued",
          leaseToken: "tok:whatever",
          leaseGeneration: done!.leaseGeneration,
          expectedRowVersion: done!.rowVersion,
          principalId: "worker:a",
          executionId: "exec-replay",
          sideEffects: [{ key: `terminal:${toStage}:${run.id}`, kind: "intake.promote", payload: { runId: run.id } }],
        }),
      ).toBeNull();
    }
    expect((await repo.getRun(tenantId, run.id))!.rowVersion).toBe(done!.rowVersion);
    expect(await countOutbox(tenantId)).toBe(1); // 只有 due scanner 的 intake.fetch
  });

  // ── N29 再验收 P0-1：Run side effect 的 tenant 由 run 自身 tenant_id 盖章 ──

  it("N29 refix P0-1：tenant-a 的 run 声明 tenantId=tenant-b 的 side effect → fail closed，零迁移零 outbox", async () => {
    const tenantId = nextTenant("refix-run-cross-tenant");
    const otherTenant = `${tenantId}-b`;
    await seedSubscription(tenantId, { status: "active" });
    const [run] = await repo.createDueRuns(new Date(), 10, { tenantId });
    const claimed = await repo.claimRun({ tenantId, runId: run.id, principalId: "worker:a", executionId: "exec-a" });

    // 本轮反例（旧实现写出 tenant_id=tenant-b 的 outbox 行）。
    await expect(
      repo.transitionRun({
        tenantId,
        runId: run.id,
        fromStage: "fetch",
        toStage: "admit",
        status: "queued",
        leaseToken: claimed!.leaseToken!,
        leaseGeneration: claimed!.leaseGeneration,
        expectedRowVersion: claimed!.rowVersion,
        principalId: "worker:a",
        executionId: "exec-a",
        sideEffects: [
          { key: "cross-intake", tenantId: otherTenant, kind: "intake.extract", payload: { runId: run.id } },
        ],
      }),
    ).rejects.toThrow(/tenant/i);

    // 跨 tenant outbox 零行；本 tenant 也零新增（fail closed → 整个事务回滚）。
    expect(await countOutbox(otherTenant)).toBe(0);
    expect(await countOutbox(tenantId)).toBe(1);
    expect(await repo.getRun(tenantId, run.id)).toMatchObject({
      stage: "fetch",
      status: "leased",
      rowVersion: claimed!.rowVersion,
    });
  });

  it("N29 refix P0-1：省略 tenantId 的 run side effect 由 run 的 tenant_id 盖章", async () => {
    const tenantId = nextTenant("refix-run-stamped");
    await seedSubscription(tenantId, { status: "active" });
    const [run] = await repo.createDueRuns(new Date(), 10, { tenantId });
    const claimed = await repo.claimRun({ tenantId, runId: run.id, principalId: "worker:a", executionId: "exec-a" });

    const moved = await repo.transitionRun({
      tenantId,
      runId: run.id,
      fromStage: "fetch",
      toStage: "admit",
      status: "queued",
      leaseToken: claimed!.leaseToken!,
      leaseGeneration: claimed!.leaseGeneration,
      expectedRowVersion: claimed!.rowVersion,
      principalId: "worker:a",
      executionId: "exec-a",
      sideEffects: [{ key: `stamped:${run.id}`, kind: "intake.extract", payload: { runId: run.id } }],
    });
    expect(moved).not.toBeNull();

    const stamped = await pool.query<SqlRow>(`SELECT tenant_id FROM side_effect_outbox WHERE key = $1`, [
      `stamped:${run.id}`,
    ]);
    expect(stamped.rows.map((r) => r.tenant_id as string)).toEqual([tenantId]);
  });

  it("outbox conflict 回滚整个 transition（run 不变、outbox 不增行）", async () => {
    const tenantId = nextTenant("transition-rollback");
    await seedSubscription(tenantId, { status: "active" });
    const [run] = await repo.createDueRuns(new Date(), 10, { tenantId });
    const claimed = await repo.claimRun({ tenantId, runId: run.id, principalId: "worker:a", executionId: "exec-a" });
    const fetchKey = (await pool.query<SqlRow>(`SELECT key FROM side_effect_outbox WHERE tenant_id = $1`, [tenantId])).rows[0]
      .key as string;

    // 同 tenant/key 不同 payload → L1 conflict → 事务整体回滚
    await expect(
      repo.transitionRun({
        tenantId,
        runId: run.id,
        fromStage: "fetch",
        leaseToken: claimed!.leaseToken!,
        leaseGeneration: claimed!.leaseGeneration,
        expectedRowVersion: claimed!.rowVersion,
        toStage: "admit",
        status: "queued",
        principalId: "worker:a",
        executionId: "exec-a",
        sideEffects: [{ key: fetchKey, kind: "intake.fetch", payload: { tampered: true } }],
      }),
    ).rejects.toThrow();

    expect(await countOutbox(tenantId)).toBe(1);
    const still = await repo.getRun(tenantId, run.id);
    expect(still!.stage).toBe("fetch");
    expect(still!.rowVersion).toBe(claimed!.rowVersion);
  });

  it("attempt 行 append-only：claim/transition 各留一行；正文不可 UPDATE", async () => {
    const tenantId = nextTenant("attempts");
    await seedSubscription(tenantId, { status: "active" });
    const [run] = await repo.createDueRuns(new Date(), 10, { tenantId });
    const claimed = await repo.claimRun({
      tenantId,
      runId: run.id,
      principalId: "worker:a",
      executionId: "exec-a",
      inputHash: sha("in"),
    });
    await repo.transitionRun({
      tenantId,
      runId: run.id,
      fromStage: "fetch",
      leaseToken: claimed!.leaseToken!,
      leaseGeneration: claimed!.leaseGeneration,
      expectedRowVersion: claimed!.rowVersion,
      toStage: "admit",
      status: "queued",
      disposition: "succeeded",
      outputHash: sha("out"),
      principalId: "worker:a",
      executionId: "exec-a",
    });

    const attempts = await repo.listAttempts(tenantId, run.id);
    expect(attempts.map((a) => a.disposition)).toEqual(["leased", "succeeded"]);
    expect(attempts[0].leaseTokenHash).not.toBe(claimed!.leaseToken); // 只存 hash
    expect(attempts[0].leaseTokenHash).toHaveLength(64);
    expect(await repo.listAttempts(`${tenantId}-other`, run.id)).toHaveLength(0);

    await expect(
      pool.query<SqlRow>(`UPDATE knowledge_intake_attempts SET disposition = 'succeeded' WHERE tenant_id = $1`, [tenantId]),
    ).rejects.toThrow(/append-only|immutable/i);
  });

  it("终态 run 不可复活：completed 后 claim/transition 零写，但下一个 due window 可建新 run（重爬）", async () => {
    const tenantId = nextTenant("terminal");
    const sub = await seedSubscription(tenantId, { status: "active" });
    const [run] = await repo.createDueRuns(new Date(), 10, { tenantId });
    const claimed = await repo.claimRun({ tenantId, runId: run.id, principalId: "worker:a", executionId: "exec-a" });
    const done = await repo.transitionRun({
      tenantId,
      runId: run.id,
      fromStage: "fetch",
      leaseToken: claimed!.leaseToken!,
      leaseGeneration: claimed!.leaseGeneration,
      expectedRowVersion: claimed!.rowVersion,
      toStage: "complete",
      status: "completed",
      principalId: "worker:a",
      executionId: "exec-a",
    });
    expect(done!.status).toBe("completed");
    expect(done!.leaseToken).toBeUndefined();

    // 终态：既不能被新 claim 复活，也不能被旧 lease 继续迁移
    expect(await repo.claimRun({ tenantId, runId: run.id, principalId: "worker:b", executionId: "exec-b" })).toBeNull();
    expect(
      await repo.transitionRun({
        tenantId,
        runId: run.id,
        fromStage: "complete",
        leaseToken: claimed!.leaseToken!,
        leaseGeneration: claimed!.leaseGeneration,
        expectedRowVersion: done!.rowVersion,
        toStage: "promote",
        status: "queued",
        principalId: "worker:a",
        executionId: "exec-a",
        sideEffects: [{ key: `zombie:${run.id}`, kind: "intake.promote", payload: { runId: run.id } }],
      }),
    ).toBeNull();
    expect(await countOutbox(tenantId)).toBe(1);
    expect((await repo.getRun(tenantId, run.id))!.rowVersion).toBe(done!.rowVersion);

    // run 终结后 open-run 唯一性释放：next_crawl_at 到期即建新 run（unchanged/changed 重爬入口）
    const current = await repo.getSubscription(tenantId, sub.id);
    const rescheduled = await repo.transitionSubscription({
      tenantId,
      subscriptionId: sub.id,
      expectedRowVersion: current!.rowVersion,
      toStatus: "active",
      nextCrawlAt: new Date(Date.now() - 1000),
    });
    expect(rescheduled?.status).toBe("active");
    const second = await repo.createDueRuns(new Date(), 10, { tenantId });
    expect(second).toHaveLength(1);
    expect(second[0].id).not.toBe(run.id);
    expect(second[0].reason).toBe("scheduled");
    expect(await countRuns(tenantId)).toBe(2);
  });

  it("policy 审计镜像不跨 tenant 授权：B 安装的 policy 不能让 A 建 subscription", async () => {
    const tenantA = nextTenant("policy-iso-a");
    const tenantB = nextTenant("policy-iso-b");
    const manifestB = await installPolicy(tenantB);
    await expect(
      repo.createSubscription({
        tenantId: tenantA,
        space: "space-a",
        canonicalUri: "https://docs.example.org/guide/intro",
        domainId: "mathematics",
        policyId: manifestB.policyId,
        policyVersion: manifestB.version,
        policyDigest: manifestB.digest,
        policyRuleId: manifestB.rules[0].ruleId,
        recrawlIntervalMs: 1000,
        nextCrawlAt: new Date(),
      }),
    ).rejects.toThrow(/installVerifiedPolicy|审计镜像/);
    const rows = await pool.query<SqlRow>(`SELECT count(*)::int AS n FROM knowledge_source_subscriptions WHERE tenant_id = $1`, [
      tenantA,
    ]);
    expect(rows.rows[0].n).toBe(0);
  });

  // ---------------------------------------------------------------- artifact / revision

  it("storeAcquisition：raw-quarantine 与 admitted 是两条独立 append-only 行，共用同一 artifact", async () => {
    const tenantId = nextTenant("acq");
    const sub = await seedSubscription(tenantId, { status: "active" });
    const [run] = await repo.createDueRuns(new Date(), 10, { tenantId });
    const body = "<html><body>Fermat</body></html>";

    const raw = await repo.storeAcquisition(acquisitionInput(sub, run.id, body, "raw-quarantine"));
    expect(raw.disposition).toBe("raw-quarantine");
    expect(raw.usePolicyDecision).toBeUndefined();

    const admitted = await repo.storeAcquisition(
      acquisitionInput(sub, run.id, body, "admitted", { derivedFromRevisionId: raw.id }),
    );
    expect(admitted.id).not.toBe(raw.id);
    expect(admitted.artifactId).toBe(raw.artifactId); // rawHash 去重复用既有 artifact
    expect(admitted.derivedFromRevisionId).toBe(raw.id);
    expect(admitted.usePolicyDecision).toBeTruthy();

    // 原 quarantine 行未被原地改写
    const rawAfter = await repo.getRevision(tenantId, raw.id);
    expect(rawAfter!.disposition).toBe("raw-quarantine");

    const artifacts = await pool.query<SqlRow>(
      `SELECT count(*)::int AS n FROM knowledge_source_artifacts WHERE tenant_id = $1 AND raw_hash = $2`,
      [tenantId, sha(body)],
    );
    expect(artifacts.rows[0].n).toBe(1);
    const revisions = await repo.listRevisions(tenantId, sub.id);
    expect(revisions).toHaveLength(2);
    expect(await repo.listRevisions(`${tenantId}-other`, sub.id)).toHaveLength(0);
  });

  it("revision 正文不可 UPDATE（quarantined 不得原地升为 admitted）", async () => {
    const tenantId = nextTenant("rev-immutable");
    const sub = await seedSubscription(tenantId, { status: "active" });
    const [run] = await repo.createDueRuns(new Date(), 10, { tenantId });
    const raw = await repo.storeAcquisition(acquisitionInput(sub, run.id, "body-x", "raw-quarantine"));

    await expect(
      pool.query<SqlRow>(`UPDATE knowledge_source_revisions SET disposition = 'admitted' WHERE tenant_id = $1 AND id = $2`, [
        tenantId,
        raw.id,
      ]),
    ).rejects.toThrow(/append-only|immutable/i);
    await expect(
      pool.query<SqlRow>(`UPDATE knowledge_source_revisions SET normalized_text = 'tampered' WHERE tenant_id = $1 AND id = $2`, [
        tenantId,
        raw.id,
      ]),
    ).rejects.toThrow(/append-only|immutable/i);
    await expect(
      pool.query<SqlRow>(`UPDATE knowledge_source_artifacts SET raw_bytes = 'x'::bytea WHERE tenant_id = $1`, [tenantId]),
    ).rejects.toThrow(/append-only|immutable/i);
  });

  it("admitted revision 必须带 use policy decision（缺失 fail closed，零行）", async () => {
    const tenantId = nextTenant("rev-usedecision");
    const sub = await seedSubscription(tenantId, { status: "active" });
    const [run] = await repo.createDueRuns(new Date(), 10, { tenantId });
    const input = acquisitionInput(sub, run.id, "body-y", "admitted", { withUseDecision: false });
    await expect(repo.storeAcquisition(input)).rejects.toThrow();
    expect(await repo.listRevisions(tenantId, sub.id)).toHaveLength(0);
  });

  // ------------------------------ P0-4：SourceRevision / Artifact 不变量必须在写口守住
  // 反例来源：docs/pth/n29-minimal-intake-reacceptance-feedback.md §3 P0-4 / §8 条件 4。
  // 这些用例**直接调用**仓库公共写口（模拟"被错误内部调用者直接调用"），不经 service happy path。

  /** 每个 P0-4 负测的公共前置：真实 policy + subscription + run + 一条合法 raw-quarantine 父行。 */
  async function quarantinedFixture(label: string, body = `<html><body>${label}</body></html>`): Promise<{
    tenantId: string;
    sub: SourceSubscription;
    runId: string;
    body: string;
    quarantine: SourceRevision;
  }> {
    const tenantId = nextTenant(label);
    const sub = await seedSubscription(tenantId, { status: "active" });
    const [run] = await repo.createDueRuns(new Date(), 10, { tenantId });
    const quarantine = await repo.storeAcquisition(acquisitionInput(sub, run.id, body, "raw-quarantine"));
    return { tenantId, sub, runId: run.id, body, quarantine };
  }

  /** 断言：抛出带指定 code 的 KnowledgeIntakeValidationError，且 revision 行数不变（零写）。 */
  async function expectAdmittedRejected(
    fixture: { tenantId: string; sub: SourceSubscription },
    input: StoreAcquisitionInput,
    code: string,
  ): Promise<void> {
    const before = (await repo.listRevisions(fixture.tenantId, fixture.sub.id)).map((r) => r.id).sort();
    const error = await repo.storeAcquisition(input).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error, `storeAcquisition 必须拒绝（期望 code=${code}）`).toBeInstanceOf(KnowledgeIntakeValidationError);
    expect((error as KnowledgeIntakeValidationError).code).toBe(code);
    // 零写：revision 行集合（id 集合）完全不变
    const after = (await repo.listRevisions(fixture.tenantId, fixture.sub.id)).map((r) => r.id).sort();
    expect(after).toEqual(before);
  }

  it("P0-4：usePolicyDecision=deny 的 admitted revision 零行", async () => {
    const f = await quarantinedFixture("p04-deny");
    await expectAdmittedRejected(
      f,
      acquisitionInput(f.sub, f.runId, f.body, "admitted", {
        derivedFromRevisionId: f.quarantine.id,
        useDecision: "deny",
      }),
      "ADMITTED_USE_DECISION_NOT_ALLOW",
    );
  });

  it("P0-4：rawHash 与 rawBytes 不符（自报 hash）零行——服务端必须重算", async () => {
    const f = await quarantinedFixture("p04-rawhash");
    await expectAdmittedRejected(
      f,
      acquisitionInput(f.sub, f.runId, f.body, "admitted", {
        derivedFromRevisionId: f.quarantine.id,
        rawHash: sha("totally-different-bytes"),
      }),
      "ARTIFACT_RAW_HASH_MISMATCH",
    );
  });

  it("P0-4：normalizedTextHash 与 normalizedText 不符零行——服务端必须重算", async () => {
    const f = await quarantinedFixture("p04-normhash");
    await expectAdmittedRejected(
      f,
      acquisitionInput(f.sub, f.runId, f.body, "admitted", {
        derivedFromRevisionId: f.quarantine.id,
        normalizedTextHash: "not-a-hash",
      }),
      "REVISION_NORMALIZED_TEXT_HASH_MISMATCH",
    );
  });

  it("P0-4：admitted 缺少 derivedFromRevisionId（无 raw→admitted 关联）零行", async () => {
    const f = await quarantinedFixture("p04-noparent");
    await expectAdmittedRejected(
      f,
      acquisitionInput(f.sub, f.runId, f.body, "admitted"),
      "ADMITTED_PARENT_REQUIRED",
    );
  });

  it("P0-4：derivedFromRevisionId 指向另一 tenant 的 revision 零行", async () => {
    const foreign = await quarantinedFixture("p04-foreign-parent", "<html><body>foreign</body></html>");
    const f = await quarantinedFixture("p04-crosstenant");
    await expectAdmittedRejected(
      f,
      acquisitionInput(f.sub, f.runId, f.body, "admitted", { derivedFromRevisionId: foreign.quarantine.id }),
      "ADMITTED_PARENT_NOT_FOUND",
    );
    // 另一 tenant 的 quarantine 行本身不受影响（零跨租户副作用）
    expect((await repo.getRevision(foreign.tenantId, foreign.quarantine.id))!.disposition).toBe("raw-quarantine");
  });

  it("P0-4：derivedFromRevisionId 指向非 raw-quarantine 行零行", async () => {
    const f = await quarantinedFixture("p04-parent-kind");
    const admitted = await repo.storeAcquisition(
      acquisitionInput(f.sub, f.runId, f.body, "admitted", { derivedFromRevisionId: f.quarantine.id }),
    );
    // 拿一条 admitted 行当"父"——raw→admitted 关联语义被破坏，必须拒绝。
    await expectAdmittedRejected(
      { tenantId: f.tenantId, sub: f.sub },
      acquisitionInput(f.sub, f.runId, f.body, "admitted", { derivedFromRevisionId: admitted.id }),
      "ADMITTED_PARENT_NOT_QUARANTINE",
    );
  });

  it("P0-4：derivedFromRevisionId 指向另一 subscription 的 quarantine 零行", async () => {
    const f = await quarantinedFixture("p04-parent-sub");
    // 同 tenant 第二个 subscription（不同 canonicalUri）的 quarantine 不能当父行。
    const otherSub = await seedSubscription(f.tenantId, {
      status: "active",
      canonicalUri: "https://docs.example.org/guide/other",
    });
    const otherQuarantine = await repo.storeAcquisition(
      acquisitionInput(otherSub, f.runId, "<html><body>other-sub</body></html>", "raw-quarantine"),
    );
    await expectAdmittedRejected(
      f,
      acquisitionInput(f.sub, f.runId, f.body, "admitted", { derivedFromRevisionId: otherQuarantine.id }),
      "ADMITTED_PARENT_SUBSCRIPTION_MISMATCH",
    );
  });

  it("P0-4：use decision 的 policy 绑定与 Subscription 不一致零行（digest / ruleId / policyId）", async () => {
    const f = await quarantinedFixture("p04-policybind");
    for (const [over, code] of [
      [{ policyDigest: sha("forged-policy-digest") }, "POLICY_DECISION_BINDING_MISMATCH"],
      [{ ruleId: "rule-does-not-exist" }, "POLICY_DECISION_BINDING_MISMATCH"],
      [{ policyId: "policy-other" }, "POLICY_DECISION_BINDING_MISMATCH"],
      [{ policyVersion: "v9" }, "POLICY_DECISION_BINDING_MISMATCH"],
    ] as const) {
      await expectAdmittedRejected(
        f,
        acquisitionInput(f.sub, f.runId, f.body, "admitted", {
          derivedFromRevisionId: f.quarantine.id,
          ...over,
        }),
        code,
      );
    }
  });

  it("P0-4：Subscription 不存在（或跨 tenant）零行", async () => {
    const f = await quarantinedFixture("p04-nosub");
    const before = await repo.listRevisions(f.tenantId, f.sub.id);
    await expect(
      repo.storeAcquisition(
        acquisitionInput(f.sub, f.runId, f.body, "raw-quarantine", { subscriptionId: "sub-does-not-exist" }),
      ),
    ).rejects.toThrow(KnowledgeIntakeValidationError);
    expect(await repo.listRevisions(f.tenantId, f.sub.id)).toHaveLength(before.length);
  });

  it("P0-4：recordDependency 不得把依赖边绑到 raw-quarantine / 跨 subscription 的 revision", async () => {
    const f = await quarantinedFixture("p04-dep");
    const { admitted } = await storeQuarantineThenAdmitted(f.sub, f.runId, "<html><body>dep</body></html>");

    // ① 绑到未准入字节（raw-quarantine）→ 拒绝，零依赖边
    const quarantineEdge = await repo.recordDependency({
      tenantId: f.tenantId,
      subscriptionId: f.sub.id,
      sourceRevisionId: f.quarantine.id,
      dependentId: "entry-p04-dep",
      evidenceDigest: sha("ev"),
      space: "space-a",
    }).then(() => null, (e: unknown) => e);
    expect(quarantineEdge).toBeInstanceOf(KnowledgeIntakeValidationError);
    expect(await repo.listDependencies(f.tenantId, f.sub.id)).toHaveLength(0);

    // ② 跨 subscription 引用 → 拒绝
    const otherSub = await seedSubscription(f.tenantId, {
      status: "active",
      canonicalUri: "https://docs.example.org/guide/dep-other",
    });
    const crossEdge = await repo.recordDependency({
      tenantId: f.tenantId,
      subscriptionId: otherSub.id,
      sourceRevisionId: admitted.id,
      dependentId: "entry-p04-dep",
      evidenceDigest: sha("ev"),
      space: "space-a",
    }).then(() => null, (e: unknown) => e);
    expect(crossEdge).toBeInstanceOf(KnowledgeIntakeValidationError);
    expect(await repo.listDependencies(f.tenantId, otherSub.id)).toHaveLength(0);

    // ③ 绑到 admitted revision → 成功（正向基线）
    await repo.recordDependency({
      tenantId: f.tenantId,
      subscriptionId: f.sub.id,
      sourceRevisionId: admitted.id,
      dependentId: "entry-p04-dep",
      evidenceDigest: sha("ev"),
      space: "space-a",
    });
    expect(await repo.listDependencies(f.tenantId, f.sub.id)).toHaveLength(1);
  });

  it("P0-4：全部不变量满足的 admitted revision 成功落库（hash 可重算 + raw 父 + allow + 策略一致）", async () => {
    const tenantId = nextTenant("p04-happy");
    const sub = await seedSubscription(tenantId, { status: "active" });
    const [run] = await repo.createDueRuns(new Date(), 10, { tenantId });
    const body = "<html><body>P0-4 happy path</body></html>";
    const { quarantine, admitted } = await storeQuarantineThenAdmitted(sub, run.id, body);

    expect(admitted.disposition).toBe("admitted");
    expect(admitted.derivedFromRevisionId).toBe(quarantine.id);
    expect(admitted.usePolicyDecision!.decision).toBe("allow");
    // 落库 hash 与服务端重算值逐字段一致
    expect(admitted.rawHash).toBe(sha(body));
    expect(admitted.normalizedTextHash).toBe(sha(admitted.normalizedText));
    const stored = await pool.query<SqlRow>(
      `SELECT r.raw_hash, r.normalized_text_hash, a.raw_bytes, a.byte_length
         FROM knowledge_source_revisions r
         JOIN knowledge_source_artifacts a ON a.tenant_id = r.tenant_id AND a.id = r.artifact_id
        WHERE r.tenant_id = $1 AND r.id = $2`,
      [tenantId, admitted.id],
    );
    expect(sha256OfBuffer(stored.rows[0].raw_bytes as Buffer)).toBe(stored.rows[0].raw_hash);
    expect(Number(stored.rows[0].byte_length)).toBe(Buffer.byteLength(body));
  });

  it("artifact raw_hash 去重是 tenant 作用域：跨 tenant 各存一份，互不可见", async () => {
    const tenantA = nextTenant("art-a");
    const tenantB = nextTenant("art-b");
    const body = "shared-bytes";
    const subA = await seedSubscription(tenantA, { status: "active" });
    const subB = await seedSubscription(tenantB, { status: "active" });
    const [runA] = await repo.createDueRuns(new Date(), 10, { tenantId: tenantA });
    const [runB] = await repo.createDueRuns(new Date(), 10, { tenantId: tenantB });

    const revA = await repo.storeAcquisition(acquisitionInput(subA, runA.id, body, "raw-quarantine"));
    const revB = await repo.storeAcquisition(acquisitionInput(subB, runB.id, body, "raw-quarantine"));
    expect(revA.rawHash).toBe(revB.rawHash);
    expect(revA.artifactId).not.toBe(revB.artifactId);

    // 同 tenant 内重复 rawHash → 复用同一 artifact id
    const revA2 = await repo.storeAcquisition(acquisitionInput(subA, runA.id, body, "unchanged"));
    expect(revA2.artifactId).toBe(revA.artifactId);

    const counts = await pool.query<SqlRow>(
      `SELECT tenant_id, count(*)::int AS n FROM knowledge_source_artifacts
        WHERE raw_hash = $1 AND tenant_id = ANY($2::text[]) GROUP BY tenant_id ORDER BY tenant_id`,
      [sha(body), [tenantA, tenantB]],
    );
    expect(counts.rows.map((r) => r.n)).toEqual([1, 1]);
    expect(await repo.getRevision(tenantB, revA.id)).toBeNull();
  });

  // ---------------------------------------------------------------- dependency / stale

  it("recordDependency append-only 幂等；markDependentsStale 限 tenant+subscription；跨 tenant 零可见", async () => {
    const tenantA = nextTenant("dep-a");
    const tenantB = nextTenant("dep-b");
    const subA = await seedSubscription(tenantA, { status: "active" });
    const subB = await seedSubscription(tenantB, { status: "active" });
    const [runA] = await repo.createDueRuns(new Date(), 10, { tenantId: tenantA });
    const [runB] = await repo.createDueRuns(new Date(), 10, { tenantId: tenantB });
    const { admitted: revA1 } = await storeQuarantineThenAdmitted(subA, runA.id, "v1");
    const { admitted: revA2 } = await storeQuarantineThenAdmitted(subA, runA.id, "v2");
    const { admitted: revB1 } = await storeQuarantineThenAdmitted(subB, runB.id, "v1");

    await repo.recordDependency({
      tenantId: tenantA,
      subscriptionId: subA.id,
      sourceRevisionId: revA1.id,
      dependentId: "entry-a-1",
      evidenceDigest: sha("ev-a-1"),
      space: "space-a",
    });
    // 重复登记同一边 → 幂等（不新增行、不覆盖）
    await repo.recordDependency({
      tenantId: tenantA,
      subscriptionId: subA.id,
      sourceRevisionId: revA1.id,
      dependentId: "entry-a-1",
      evidenceDigest: sha("ev-a-1"),
      space: "space-a",
    });
    await repo.recordDependency({
      tenantId: tenantA,
      subscriptionId: subA.id,
      sourceRevisionId: revA2.id,
      dependentId: "entry-a-2",
      evidenceDigest: sha("ev-a-2"),
      space: "space-a",
    });
    await repo.recordDependency({
      tenantId: tenantB,
      subscriptionId: subB.id,
      sourceRevisionId: revB1.id,
      dependentId: "entry-b-1",
      evidenceDigest: sha("ev-b-1"),
      space: "space-a",
    });
    expect(await repo.listDependencies(tenantA, subA.id)).toHaveLength(2);

    // 变化重爬：除当前 revision 外的 dependent 全部 stale
    const staled = await repo.markDependentsStale({
      tenantId: tenantA,
      subscriptionId: subA.id,
      exceptSourceRevisionId: revA2.id,
      reason: "source-changed",
    });
    expect(staled).toEqual(["entry-a-1"]);
    const depsA = await repo.listDependencies(tenantA, subA.id);
    expect(depsA.find((d) => d.dependentId === "entry-a-1")!.stale).toBe(true);
    expect(depsA.find((d) => d.dependentId === "entry-a-1")!.rowVersion).toBe(2);
    expect(depsA.find((d) => d.dependentId === "entry-a-2")!.stale).toBe(false);

    // 跨 tenant 零效果 + 零可见
    expect(
      await repo.markDependentsStale({ tenantId: tenantA, subscriptionId: subB.id, reason: "source-changed" }),
    ).toEqual([]);
    expect(await repo.listDependencies(tenantA, subB.id)).toHaveLength(0);
    expect((await repo.listDependencies(tenantB, subB.id))[0].stale).toBe(false);

    // dependency 身份/正文不可 UPDATE（只有 stale 状态可迁移）
    await expect(
      pool.query<SqlRow>(`UPDATE knowledge_source_dependencies SET dependent_id = 'hijack' WHERE tenant_id = $1`, [tenantA]),
    ).rejects.toThrow(/append-only|immutable/i);
  });
});
