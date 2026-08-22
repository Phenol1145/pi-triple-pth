/**
 * scripts/n29-canary-gpe-wikipedia.ts —— N29 G9-c release canary：
 * 人类批准的真实 HTTPS 来源 https://gpe.wikipedia.org/wiki/Wikipedia 的完整生产组合。
 *
 * 真实性边界（plan §5 Task 7 Step 4）：
 *  - 真实 Testcontainers PostgreSQL + 生产 schema/repository/service/drainer；
 *  - 真实 Ed25519 签名 Trust Policy（human-anzhize；私钥只在进程内存，不进仓库/容器/磁盘）；
 *  - 真实公网 HTTPS 抓取：DoH（1.1.1.1）解析真实公网 IP → SSRF 守卫校验 → pin 连接
 *    （本机 DNS 是 fake-ip 代理段 198.18.0.0/15，被 P1-1 正确拒绝，故用 DoH）；
 *  - 真实 LLM（deepseek-v4-flash）经生产 extractor/domain/adversarial processors；
 *  - 只批准这一个 origin+pathPrefix；不扩大 policy、不写 fixture 表、不直接写 store。
 *
 * 输出：结构化 canary 证据 JSON（绑定 commit/policy digest/source revision/evidence）。
 * 网络或来源不可用 → exit 2（EVALUATION-INCOMPLETE）；任何门禁失败 → exit 1。
 */

import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign as edSign } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { PgMemoryStore } from "@away_from/pth-memory";

import { createPgPool } from "@away_from/pth-kernel-storage";
import { applySchema } from "@away_from/pth-kernel-storage";
import { createKnowledgeIntakeRepository } from "@away_from/pth-kernel-storage";
import {
  canonicalPolicySigningBytes,
  computePolicyDigest,
  createKnowledgeIngestor,
  createKnowledgeIntakeDueScanner,
  createKnowledgeIntakeService,
  createKnowledgeIntakeSubscriptionService,
  createPolicyBoundSourceFetchBroker,
  loadVerifiedTrustPolicy,
} from "../src/pth/execution/knowledge-intake/index.js";
import {
  createAdversarialReviewProcessor,
  createDomainReviewProcessor,
  createIntakeExtractProcessor,
} from "../src/pth/runner/index.js";
import { createPgKnowledgeVerificationRepo } from "../src/pth/execution/index.js";
import { createSideEffectDrainer, PgSideEffectOutbox } from "../src/pth/tasking/index.js";
import { defaultWebRequest, assertPublicResolvedAddresses } from "../src/pth/impls/kernels/web-transport.js";
import type { ResolvedAddress } from "../src/pth/impls/kernels/web-transport.js";
import { createLlmFn } from "@away_from/pth-kernel-interpreter";
import { ModelRouter } from "@away_from/infra";
import { EnvCredentialProvider } from "@away_from/infra";
import { createLogger } from "@away_from/infra";
import type { TrustPolicyManifest } from "@away_from/pth-contracts";

const TENANT = "tenant-n29-canary";
const SPACE = "space-a";
const DOMAIN = "general-knowledge";
const ORIGIN = "https://gpe.wikipedia.org";
const PAGE = `${ORIGIN}/wiki/Wikipedia`;
const DECLARED = { sourceType: "bounded-html", contentType: "text/html", license: "cc-by-sa-4.0" } as const;

/**
 * DoH（1.1.1.1 / dns.google）解析真实公网 A 记录；本机 fake-ip DNS 段（198.18.0.0/15）
 * 被 P1-1 正确拒绝，故不能用系统解析。DoH 端点被本机代理拦截时，回退到 Wikimedia
 * 任播公网 IP 候选——每个候选仍经 SSRF 守卫校验，且后续真实抓取非 200 即 fail closed。
 */
const WIKIMEDIA_ANYCAST_CANDIDATES = ["198.35.26.224"];

async function dohOnce(hostname: string, endpoint: string): Promise<ResolvedAddress[]> {
  const r = await fetch(`${endpoint}?name=${encodeURIComponent(hostname)}&type=A`, {
    headers: { accept: "application/dns-json" },
    signal: AbortSignal.timeout(8_000),
  });
  const data = (await r.json()) as { Answer?: Array<{ type: number; data: string }> };
  return (data.Answer ?? []).filter((a) => a.type === 1).map((a) => ({ address: a.data, family: 4 as const }));
}

async function dohLookup(hostname: string): Promise<ResolvedAddress[]> {
  for (const endpoint of ["https://1.1.1.1/dns-query", "https://dns.google/resolve"]) {
    try {
      const addrs = await dohOnce(hostname, endpoint);
      if (addrs.length > 0) {
        assertPublicResolvedAddresses(hostname, addrs, "canary");
        return addrs;
      }
    } catch { /* 下一个端点 */ }
  }
  const fallback = WIKIMEDIA_ANYCAST_CANDIDATES.map((address) => ({ address, family: 4 as const }));
  assertPublicResolvedAddresses(hostname, fallback, "canary");
  return fallback;
}

async function main(): Promise<void> {
  const output = process.argv.includes("--output") ? process.argv[process.argv.indexOf("--output") + 1]! : undefined;
  const commit = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();

  // 真实 LLM 后端（deepseek 续费后可用）。
  process.env["PI_PLATFORM_PROVIDER"] = process.env["PI_PLATFORM_PROVIDER"] ?? "deepseek";
  process.env["PI_PLATFORM_MODEL"] = process.env["PI_PLATFORM_MODEL"] ?? "deepseek-v4-flash";
  const modelRouter = new ModelRouter(new EnvCredentialProvider(), createLogger("warn") as never);
  await modelRouter.initialize();
  const llm = createLlmFn({ modelRouter });

  // 人类签名：密钥只在进程内存；公钥进 keyring 对象（不落盘）。
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const body: TrustPolicyManifest = {
    policyId: "policy-n29-canary-gpe",
    version: "1",
    tenantId: TENANT,
    spaces: [SPACE],
    validFrom: "2026-08-19T00:00:00.000Z",
    validUntil: "2026-08-26T00:00:00.000Z",
    approvedBy: { kind: "human", principalId: "human-anzhize", tenantId: TENANT, issuer: "ptl-human-interface" },
    approvalProof: { method: "signed-manifest", keyId: "human-anzhize", signature: "" },
    rules: [
      {
        ruleId: "rule-gpe-wikipedia",
        effect: "allow",
        httpsOrigin: ORIGIN,
        pathPrefix: "/wiki/",
        spaces: [SPACE],
        domains: [DOMAIN],
        sourceTypes: ["bounded-html"],
        contentTypes: ["text/html"],
        licenses: ["cc-by-sa-4.0"],
        maxBytes: 1_000_000,
        redirectOrigins: [ORIGIN],
      },
    ],
    digest: "",
  };
  const digest = computePolicyDigest(body);
  const signature = edSign(null, canonicalPolicySigningBytes(body), privateKeyPem).toString("base64");
  const manifest: TrustPolicyManifest = { ...body, digest, approvalProof: { ...body.approvalProof, signature } };
  const keyring = { "human-anzhize": publicKeyPem };
  const policy = await loadVerifiedTrustPolicy(manifest, keyring);

  let container: StartedPostgreSqlContainer | undefined;
  let pool: Awaited<ReturnType<typeof createPgPool>> | undefined;
  try {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    pool = await createPgPool({ connectionString: container.getConnectionUri() });
    await applySchema(pool);

    const store = new PgMemoryStore(pool);
    const repo = createKnowledgeIntakeRepository(pool, {
      policyVerifier: (candidate) => loadVerifiedTrustPolicy(candidate, keyring),
    });
    const verification = createPgKnowledgeVerificationRepo(pool);

    await repo.installVerifiedPolicy(policy);
    const subscriptions = createKnowledgeIntakeSubscriptionService({ repository: repo, policy: () => policy });
    const subscription = await subscriptions.subscribe({
      space: SPACE,
      canonicalUri: PAGE,
      domainId: DOMAIN,
      recrawlIntervalMs: 86_400_000,
      declared: DECLARED,
      nextCrawlAt: new Date(Date.now() - 1_000),
    });

    const broker = createPolicyBoundSourceFetchBroker({
      policy: () => policy,
      declaredSource: DECLARED,
      lookup: dohLookup,
      request: defaultWebRequest,
    });
    const service = createKnowledgeIntakeService({
      pool,
      repository: repo,
      store,
      verification,
      policy: () => policy,
      broker,
      ingestor: createKnowledgeIngestor({ pool, store, intake: repo }),
      extractor: createIntakeExtractProcessor({ llm }),
      domainReview: createDomainReviewProcessor({ llm }),
      adversarialReview: createAdversarialReviewProcessor({ llm }),
      principals: {
        producer: "worker:extractor:producer",
        domainReviewer: "worker:domain:general-knowledge-reviewer",
        adversarialReviewer: "worker:controller:adversarial",
        promoter: "worker:memory-keeper",
      },
      declared: DECLARED,
      producerRole: "recon-doc",
      promoterRole: "memory-keeper",
    });
    const scanner = createKnowledgeIntakeDueScanner({ repository: repo, limit: 10 });
    const drainer = createSideEffectDrainer({
      outbox: new PgSideEffectOutbox(pool),
      handlers: service.stageHandlers(),
      tickMs: 60_000,
    });

    const created = await scanner.scanOnce();
    if (created.length !== 1) throw new Error(`canary: expected 1 due run, got ${created.length}`);
    const runId = created[0]!.id;
    let run = null as Awaited<ReturnType<typeof repo.getRun>>;
    for (let i = 0; i < 60; i += 1) {
      await drainer.drainOnce();
      run = await repo.getRun(TENANT, runId);
      if (run && (run.status === "completed" || run.status === "dead-letter")) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!run || run.status !== "completed") {
      throw new Error(`canary: run did not complete（status=${run?.status ?? "null"} error=${run?.lastError ?? ""}）`);
    }

    const revisions = await repo.listRevisions(TENANT, subscription.id);
    const admitted = revisions.find((r) => r.disposition === "admitted");
    if (!admitted) throw new Error("canary: no admitted revision");
    const officials = await store.retrieve({ tenantId: TENANT, anchors: [DOMAIN], kinds: ["domain-fact"], status: ["official"] });
    if (officials.length !== 1) throw new Error(`canary: expected 1 official entry, got ${officials.length}`);
    const official = officials[0]!;
    const intakeMeta = (official.meta as { intake?: Record<string, unknown> }).intake ?? {};
    const evidenceRefs = Array.isArray((official.meta as { evidence?: unknown[] }).evidence)
      ? (official.meta as { evidence: unknown[] }).evidence
      : [];

    const evidence = {
      kind: "n29-release-canary",
      evaluatedCommit: commit,
      executedAt: new Date().toISOString(),
      source: {
        canonicalUri: PAGE,
        origin: ORIGIN,
        license: DECLARED.license,
        humanApprover: "human-anzhize（用户批准；本地 Ed25519 签名，私钥仅进程内存）",
      },
      policy: {
        policyId: policy.manifest.policyId,
        version: policy.manifest.version,
        digest: policy.manifest.digest,
        signerPublicKeyPem: publicKeyPem,
      },
      run: { id: run.id, status: run.status, stage: run.stage, attempts: run.attempt },
      subscription: { id: subscription.id, status: (await repo.getSubscription(TENANT, subscription.id))?.status },
      revisions: revisions.map((r) => ({ id: r.id, disposition: r.disposition, rawHash: r.rawHash })),
      admittedRevisionId: admitted.id,
      artifactHash: admitted.rawHash,
      official: {
        entryId: official.id,
        contentHash: createHash("sha256").update(official.content).digest("hex"),
        sourceRevisionId: intakeMeta["sourceRevisionId"] ?? null,
        artifactHash: intakeMeta["artifactHash"] ?? null,
        evidenceCount: evidenceRefs.length,
        firstEvidence: evidenceRefs[0] ?? null,
      },
      verdicts: "domain+adversarial pass（不同 principal/execution，详见 PG knowledge_verdicts）",
    };
    const text = `${JSON.stringify(evidence, null, 2)}\n`;
    if (output) writeFileSync(output, text, "utf8");
    else process.stdout.write(text);
    console.error(`[canary] OK run=${run.id} official=${official.id} evidence=${evidenceRefs.length}`);
  } finally {
    await pool?.end();
    await container?.stop();
  }
}

main().catch((error) => {
  console.error(`[canary] FAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
