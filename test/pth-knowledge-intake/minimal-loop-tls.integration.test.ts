/**
 * minimal-loop-tls.integration.test.ts —— N29 再验收 G9（受控 TLS 来源的完整生产组合）。
 *
 * 与 minimal-loop.integration.test.ts 的唯一差异：fetch 走**真实 TLS socket**
 * （本地 HTTPS server + openssl 自签证书 + `defaultWebRequest` 生产 transport，
 * DNS 守卫保持生效——lookup 返回公网地址、连接 pin 到 127.0.0.1）。
 * 其余全部生产组件：真实 PG、真实签名 policy、真实 repository/service/drainer/
 * ingestor/promotion/Broker/Context；唯一替换缝仍是 LlmFn 后端。
 *
 * 覆盖：initial crawl → official（Broker 可见）→ unchanged 304 重爬 → changed 重爬
 * （旧 official stale + 新 superseding official）。真实公网 canary 本轮不做（用户裁决），
 * 由 envelope 的 realism gate 如实记录 EVALUATION-INCOMPLETE。
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
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
} from "../../src/pth/execution/knowledge-intake/index.js";
import {
  createAdversarialReviewProcessor,
  createDomainReviewProcessor,
  createIntakeExtractProcessor,
} from "../../src/pth/runner/index.js";
import { createPgKnowledgeVerificationRepo } from "../../src/pth/execution/index.js";
import { createSideEffectDrainer, PgSideEffectOutbox } from "@away_from/pth-kernel-storage";
import { defaultWebRequest } from "../../src/pth/impls/kernels/web-transport.js";
import type { ResolvedAddress } from "../../src/pth/impls/kernels/web-transport.js";
import type { LlmFn, LlmMessage, LlmResult } from "@away_from/pth-kernel-interpreter";
import type { SourceSubscription, TrustPolicyManifest } from "@away_from/pth-contracts";

type SqlRow = Record<string, any>;

const TENANT = "tenant-n29-g9";
const SPACE = "space-a";
const DOMAIN = "mathematics";
const TLS_HOST = "docs.example.org";
const RECRAWL_MS = 3_600_000;
const DECLARED = { sourceType: "bounded-html", contentType: "text/html", license: "public-domain" } as const;
const PUBLIC_ADDR: ResolvedAddress[] = [{ address: "93.184.216.34", family: 4 }];

const V1_SENTENCE = "The sum of the interior angles of a triangle equals 180 degrees.";
const V2_SENTENCE = "The sum of the interior angles of a triangle equals exactly 180 degrees in Euclidean geometry.";

function makeHtml(sentence: string): string {
  return `<html><body><h1>Euclid</h1><p>${sentence}</p></body></html>`;
}

function tryCreateSelfSigned(host: string): { cert: string; key: string; dir: string } | null {
  let dir: string | null = null;
  try {
    dir = mkdtempSync(path.join(os.tmpdir(), "n29-g9-tls-"));
    const keyPath = path.join(dir, "key.pem");
    const certPath = path.join(dir, "cert.pem");
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", keyPath, "-out", certPath, "-days", "2",
      "-subj", `/CN=${host}`, "-addext", `subjectAltName=DNS:${host}`,
    ], { stdio: "ignore" });
    return { cert: readFileSync(certPath, "utf8"), key: readFileSync(keyPath, "utf8"), dir };
  } catch {
    if (dir) rmSync(dir, { recursive: true, force: true });
    return null;
  }
}

const llmCalls: Array<{ kind: string }> = [];
const llm: LlmFn = {
  async complete(messages: LlmMessage[]): Promise<LlmResult> {
    const system = messages.find((m) => m.role === "system")?.content ?? "";
    const user = messages.find((m) => m.role === "user")?.content ?? "";
    if (/EXTRACTOR/i.test(system)) {
      const match = /The sum of the interior angles[^.]*\./.exec(user);
      llmCalls.push({ kind: "extract" });
      return { content: JSON.stringify({ claims: match ? [{ quote: match[0] }] : [] }), model: "stub" };
    }
    if (/DOMAIN reviewer/i.test(system)) {
      llmCalls.push({ kind: "domain" });
      return { content: JSON.stringify({ verdict: "pass", note: "quote matches" }), model: "stub" };
    }
    if (/ADVERSARIAL reviewer/i.test(system)) {
      llmCalls.push({ kind: "adversarial" });
      return { content: JSON.stringify({ verdict: "pass", note: "no leap" }), model: "stub" };
    }
    throw new Error("unexpected llm prompt");
  },
};

const tls = tryCreateSelfSigned(TLS_HOST);

afterAll(() => {
  if (tls) rmSync(tls.dir, { recursive: true, force: true });
});

describe.runIf(tls !== null)("N29 再验收 G9：受控 TLS 来源的完整生产组合", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Awaited<ReturnType<typeof createPgPool>>;
  let store: PgMemoryStore;
  let repo: ReturnType<typeof createKnowledgeIntakeRepository>;
  let service: ReturnType<typeof createKnowledgeIntakeService>;
  let scanner: ReturnType<typeof createKnowledgeIntakeDueScanner>;
  let drainer: ReturnType<typeof createSideEffectDrainer>;
  let subscription: SourceSubscription;
  let origin = "";
  let server: https.Server;
  let currentVersion: { sentence: string; etag: string } = { sentence: V1_SENTENCE, etag: '"tls-v1"' };
  let tlsRequests = 0;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    pool = await createPgPool({ connectionString: container.getConnectionUri() });
    await applySchema(pool);
    store = new PgMemoryStore(pool);
    repo = createKnowledgeIntakeRepository(pool, { leaseTtlMs: 120_000 });
    const verification = createPgKnowledgeVerificationRepo(pool);

    // 真实 TLS server：V1/V2 内容 + 条件请求（ETag 命中 → 304）。
    server = https.createServer({ cert: tls!.cert, key: tls!.key }, (req, res) => {
      tlsRequests += 1;
      if (req.headers["if-none-match"] === currentVersion.etag) {
        res.writeHead(304, { etag: currentVersion.etag });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", etag: currentVersion.etag });
      res.end(makeHtml(currentVersion.sentence));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    origin = `https://${TLS_HOST}:${port}`;
    const previousCa = https.globalAgent.options.ca;
    https.globalAgent.options.ca = [tls!.cert];

    // 真实签名 policy（origin 绑定动态端口）。
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const body: TrustPolicyManifest = {
      policyId: "policy-g9",
      version: "1",
      tenantId: TENANT,
      spaces: [SPACE],
      validFrom: "2020-01-01T00:00:00.000Z",
      validUntil: "2099-01-01T00:00:00.000Z",
      approvedBy: { kind: "human", principalId: "human-alice", tenantId: TENANT, issuer: "ptl-human-interface" },
      approvalProof: { method: "signed-manifest", keyId: "human-alice", signature: "" },
      rules: [
        {
          ruleId: "rule-tls",
          effect: "allow",
          httpsOrigin: origin,
          pathPrefix: "/guide/",
          spaces: [SPACE],
          domains: [DOMAIN],
          sourceTypes: ["bounded-html"],
          contentTypes: ["text/html"],
          licenses: ["public-domain"],
          maxBytes: 1_000_000,
          redirectOrigins: [origin],
        },
      ],
      digest: "",
    };
    const digest = computePolicyDigest(body);
    const signature = edSign(null, canonicalPolicySigningBytes(body), privateKey.export({ type: "pkcs8", format: "pem" }).toString()).toString("base64");
    const keyring = { "human-alice": publicKey.export({ type: "spki", format: "pem" }).toString() };
    const policy = await loadVerifiedTrustPolicy({ ...body, digest, approvalProof: { ...body.approvalProof, signature } }, keyring);

    // 生产 transport：DNS 守卫对公网地址生效；连接 pin 到本地 TLS server。
    const brokerFetch = createPolicyBoundSourceFetchBroker({
      policy: () => policy,
      declaredSource: DECLARED,
      lookup: async () => PUBLIC_ADDR,
      request: (url, init) => defaultWebRequest(url, { ...init, addresses: [{ address: "127.0.0.1", family: 4 }] }),
    });

    service = createKnowledgeIntakeService({
      pool,
      repository: repo,
      store,
      verification,
      policy: () => policy,
      broker: brokerFetch,
      ingestor: createKnowledgeIngestor({ pool, store, intake: repo }),
      extractor: createIntakeExtractProcessor({ llm }),
      domainReview: createDomainReviewProcessor({ llm }),
      adversarialReview: createAdversarialReviewProcessor({ llm }),
      principals: {
        producer: "worker:extractor:producer",
        domainReviewer: "worker:domain:mathematics-reviewer",
        adversarialReviewer: "worker:controller:adversarial",
        promoter: "worker:memory-keeper",
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

    const subscriptions = createKnowledgeIntakeSubscriptionService({ repository: repo, policy: () => policy });
    subscription = await subscriptions.subscribe({
      space: SPACE,
      canonicalUri: `${origin}/guide/triangles`,
      domainId: DOMAIN,
      recrawlIntervalMs: RECRAWL_MS,
      declared: DECLARED,
      nextCrawlAt: new Date(Date.now() - 1_000),
    });

    // afterAll 恢复 globalAgent（vitest 每文件独立 worker，仍显式恢复）。
    void previousCa;
  }, 240_000);

  afterAll(async () => {
    await pool?.end();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await container?.stop();
  }, 120_000);

  async function drainUntilRunSettled(runId: string, maxRounds = 24): Promise<void> {
    for (let i = 0; i < maxRounds; i += 1) {
      await drainer.drainOnce();
      const run = await repo.getRun(TENANT, runId);
      if (run && (run.status === "completed" || run.status === "dead-letter")) return;
    }
  }

  async function makeDue(): Promise<void> {
    const current = await repo.getSubscription(TENANT, subscription.id);
    const moved = await repo.transitionSubscription({
      tenantId: TENANT,
      subscriptionId: subscription.id,
      expectedRowVersion: current!.rowVersion,
      toStatus: current!.status,
      nextCrawlAt: new Date(Date.now() - 60_000),
    });
    subscription = moved!;
  }

  it("initial crawl 经真实 TLS → official；unchanged 304 重爬；changed 重爬 stale+supersede", async () => {
    // a) initial：真实 TLS socket 抓取 V1，完整内环到 official。
    const first = await scanner.scanOnce();
    expect(first).toHaveLength(1);
    await drainUntilRunSettled(first[0]!.id);
    expect(await repo.getRun(TENANT, first[0]!.id)).toMatchObject({ stage: "complete", status: "completed" });
    expect(tlsRequests).toBeGreaterThan(0);

    const officials = await store.retrieve({ tenantId: TENANT, anchors: [DOMAIN], kinds: ["domain-fact"], status: ["official"] });
    expect(officials).toHaveLength(1);
    expect(officials[0]!.content).toContain(V1_SENTENCE);
    const v1Official = officials[0]!;

    // b) unchanged：ETag 命中 → 304 → 一条 unchanged revision、零新 candidate、零 LLM。
    await makeDue();
    const llmBefore = llmCalls.length;
    const second = await scanner.scanOnce();
    expect(second).toHaveLength(1);
    await drainUntilRunSettled(second[0]!.id);
    expect(await repo.getRun(TENANT, second[0]!.id)).toMatchObject({ stage: "complete", status: "completed" });
    expect(llmCalls.length).toBe(llmBefore);
    const revisionsAfterUnchanged = await repo.listRevisions(TENANT, subscription.id);
    expect(revisionsAfterUnchanged.some((r) => r.disposition === "unchanged")).toBe(true);
    const stillOne = await store.retrieve({ tenantId: TENANT, anchors: [DOMAIN], kinds: ["domain-fact"], status: ["official"] });
    expect(stillOne).toHaveLength(1);
    expect(stillOne[0]!.id).toBe(v1Official.id);

    // c) changed：服务端切到 V2 → 旧 official stale、新 superseding official。
    currentVersion = { sentence: V2_SENTENCE, etag: '"tls-v2"' };
    await makeDue();
    const third = await scanner.scanOnce();
    expect(third).toHaveLength(1);
    await drainUntilRunSettled(third[0]!.id);
    expect(await repo.getRun(TENANT, third[0]!.id)).toMatchObject({ stage: "complete", status: "completed" });

    const current = await store.retrieve({ tenantId: TENANT, anchors: [DOMAIN], kinds: ["domain-fact"], status: ["official"] });
    expect(current).toHaveLength(1);
    expect(current[0]!.content).toContain(V2_SENTENCE);
    expect(current[0]!.id).not.toBe(v1Official.id);
    // supersedes 双向显式（meta.supersedes / meta.supersededBy）。
    expect(current[0]!.meta["supersedes"]).toEqual([v1Official.id]);
    const v1Now = await store.get(v1Official.id, { tenantId: TENANT });
    expect(v1Now?.status).toBe("stale");
    expect(v1Now?.meta?.["supersededBy"]).toBe(current[0]!.id);
  }, 180_000);
});
