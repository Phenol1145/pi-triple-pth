/**
 * g8-stage-sigkill-child.ts —— N29 再验收 G8-b 的阶段级 SIGKILL 故障注入子进程。
 *
 * 由 `g8-stage-sigkill.test.ts` 以独立 OS 进程拉起（真实 PG + 生产 scanner/drainer/
 * service/processors；唯一替换：可控 HTTP transport 与可控 LlmFn 后端，同 minimal-loop 约定）。
 *
 * 故障点不要求生产 service 携带测试钩子——三个窗口都通过**已存在的端口注入缝**实现：
 *   - `before-artifact-write`：包装 repository.storeAcquisition，在真实写库**之前**挂起；
 *   - `after-aggregate-outbox-commit`：包装 repository.transitionRun，真实 CAS + outbox
 *     已在同一事务提交后、handler 返回前挂起；
 *   - `after-handler-result`：包装 KnowledgeIngestor.ingest，candidate/plan 真实落库后、
 *     Run CAS/outbox complete 前挂起。
 *
 * 子进程打印 `FAULT:<point>` 后永远挂起，等待父进程 SIGKILL；`recover` 模式启动全新
 * 进程只读 PG 恢复，打印 `RECOVERED:<runId>:<status>:<stage>` 后退出。
 *
 * 用法：
 *   tsx g8-stage-sigkill-child.ts before-artifact-write <pg-uri> <tenant>
 *   tsx g8-stage-sigkill-child.ts after-aggregate-outbox-commit <pg-uri> <tenant>
 *   tsx g8-stage-sigkill-child.ts after-handler-result <pg-uri> <tenant>
 *   tsx g8-stage-sigkill-child.ts recover <pg-uri> <tenant>
 */

import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { PgMemoryStore } from "@away_from/pth-memory";
import { createPgPool } from "@away_from/pth-kernel-storage";
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
  type KnowledgeIntakeServiceRepository,
} from "../../src/pth/execution/knowledge-intake/index.js";
import {
  createAdversarialReviewProcessor,
  createDomainReviewProcessor,
  createIntakeExtractProcessor,
} from "../../src/pth/runner/index.js";
import { createPgKnowledgeVerificationRepo } from "../../src/pth/execution/index.js";
import {
  createSideEffectDrainer,
  PgSideEffectOutbox,
  type SideEffectClaimOptions,
  type SideEffectOutboxPort,
} from "../../src/pth/tasking/index.js";
import type { ResolvedAddress, WebResponse } from "../../src/pth/impls/kernels/web-transport.js";
import type { LlmFn, LlmMessage, LlmResult } from "@away_from/pth-kernel-interpreter";
import type { KnowledgeIngestor, TrustPolicyManifest } from "@away_from/pth-contracts";

const SPACE = "space-a";
const DOMAIN = "mathematics";
const ORIGIN = "https://docs.example.org";
const URI = `${ORIGIN}/guide/sigkill`;
const RECRAWL_MS = 3_600_000;
const PRODUCER = "worker:extractor:producer";
const DOMAIN_REVIEWER = "worker:domain:mathematics-reviewer";
const ADVERSARIAL_REVIEWER = "worker:controller:adversarial";
const PROMOTER = "worker:memory-keeper";
const DECLARED = { sourceType: "bounded-html", contentType: "text/html", license: "public-domain" } as const;
const PUBLIC_ADDR: ResolvedAddress[] = [{ address: "93.184.216.34", family: 4 }];
const SENTENCE = "The sum of the interior angles of a triangle equals 180 degrees.";
const HTML = `<html><body><h1>Euclid</h1><p>${SENTENCE}</p></body></html>`;
const LEASE_MS = 2_500;

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

/** 可控 HTTP transport：每次都是 200 + V1（无 304 分支，故障点是 initial crawl）。 */
const transport = async (
  _url: URL,
  _init: { signal: AbortSignal; addresses: ResolvedAddress[]; headers?: Readonly<Record<string, string>> },
): Promise<WebResponse> => fakeResponse(HTML, 200, { "content-type": "text/html; charset=utf-8", etag: '"v1"' });

/** 可控 LlmFn 后端（processor 仍是生产实现，同 minimal-loop 约定）。 */
const llm: LlmFn = {
  async complete(messages: LlmMessage[]): Promise<LlmResult> {
    const system = messages.find((m) => m.role === "system")?.content ?? "";
    const user = messages.find((m) => m.role === "user")?.content ?? "";
    if (/EXTRACTOR/i.test(system)) {
      const match = /The sum of the interior angles[^.]*\./.exec(user);
      return {
        content: JSON.stringify({ claims: match ? [{ quote: match[0] }] : [] }),
        model: "stub-extract",
      };
    }
    if (/DOMAIN reviewer/i.test(system)) {
      return { content: JSON.stringify({ verdict: "pass", note: "quote matches the cited source span" }), model: "stub-domain" };
    }
    if (/ADVERSARIAL reviewer/i.test(system)) {
      return { content: JSON.stringify({ verdict: "pass", note: "no unsupported leap beyond the quoted span" }), model: "stub-adversarial" };
    }
    throw new Error(`unexpected llm prompt: ${system.slice(0, 60)}`);
  },
};

async function signedPolicy(tenantId: string): Promise<ReturnType<typeof loadVerifiedTrustPolicy>> {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const base: TrustPolicyManifest = {
    policyId: `policy-${tenantId}`,
    version: "1",
    tenantId,
    spaces: [SPACE],
    validFrom: "2020-01-01T00:00:00.000Z",
    validUntil: "2099-01-01T00:00:00.000Z",
    approvedBy: { kind: "human", principalId: "human-alice", tenantId, issuer: "ptl-human-interface" },
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
  return loadVerifiedTrustPolicy(
    { ...base, digest, approvalProof: { ...base.approvalProof, signature } },
    { "human-alice": publicKey.export({ type: "spki", format: "pem" }).toString() },
  );
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 保留原型方法的端口包装（对象展开会丢类实例的原型方法）。 */
function withPatch<T extends object>(target: T, patch: Partial<T>): T {
  return new Proxy(target, {
    get(t, prop) {
      if (prop in patch) return (patch as Record<string | symbol, unknown>)[prop as string];
      const value = Reflect.get(t, prop, t);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(t) : value;
    },
  }) as T;
}

async function main(): Promise<void> {
  const [mode, uri, tenant] = process.argv.slice(2);
  if (!mode || !uri || !tenant || !["before-artifact-write", "after-aggregate-outbox-commit", "after-handler-result", "recover"].includes(mode)) {
    throw new Error(
      "usage: <before-artifact-write|after-aggregate-outbox-commit|after-handler-result|recover> <pg-uri> <tenant>",
    );
  }

  const pool = await createPgPool({ connectionString: uri });
  const store = new PgMemoryStore(pool);
  const baseRepo = createKnowledgeIntakeRepository(pool, { leaseTtlMs: LEASE_MS });
  const verification = createPgKnowledgeVerificationRepo(pool);
  const policy = await signedPolicy(tenant);

  const subscriptionId = `sub:${tenant}`;
  let subscription = await baseRepo.getSubscription(tenant, subscriptionId);
  if (!subscription) {
    const subscriptions = createKnowledgeIntakeSubscriptionService({ repository: baseRepo, policy: () => policy });
    subscription = await subscriptions.subscribe({
      id: subscriptionId,
      space: SPACE,
      canonicalUri: URI,
      domainId: DOMAIN,
      recrawlIntervalMs: RECRAWL_MS,
      declared: DECLARED,
      nextCrawlAt: new Date(Date.now() - 60_000),
    });
    void subscription;
  }

  const never: Promise<never> = new Promise(() => {});
  const realIngestor = createKnowledgeIngestor({ pool, store, intake: baseRepo });
  let repository: KnowledgeIntakeServiceRepository = baseRepo;
  let ingestor: KnowledgeIngestor = realIngestor;
  let armed = true;

  if (mode === "before-artifact-write") {
    repository = withPatch<KnowledgeIntakeServiceRepository>(baseRepo, {
      storeAcquisition: async (input) => {
        if (armed) {
          armed = false;
          process.stdout.write(`FAULT:before-artifact-write:${tenant}\n`);
          await never;
        }
        return baseRepo.storeAcquisition(input);
      },
    });
  } else if (mode === "after-aggregate-outbox-commit") {
    repository = withPatch<KnowledgeIntakeServiceRepository>(baseRepo, {
      transitionRun: async (input) => {
        const moved = await baseRepo.transitionRun(input);
        if (armed && moved !== null && input.fromStage === "fetch" && input.toStage === "admit") {
          armed = false;
          process.stdout.write(`FAULT:after-aggregate-outbox-commit:${tenant}\n`);
          await never;
        }
        return moved;
      },
    });
  } else if (mode === "after-handler-result") {
    ingestor = withPatch<KnowledgeIngestor>(realIngestor, {
      ingest: async (input) => {
        const outcome = await realIngestor.ingest(input);
        if (armed) {
          armed = false;
          process.stdout.write(`FAULT:after-handler-result:${tenant}\n`);
          await never;
        }
        return outcome;
      },
    });
  }

  const broker = createPolicyBoundSourceFetchBroker({
    policy: () => policy,
    declaredSource: DECLARED,
    lookup: async () => PUBLIC_ADDR,
    request: transport,
  });
  const service = createKnowledgeIntakeService({
    pool,
    repository,
    store,
    verification,
    policy: () => policy,
    broker,
    ingestor,
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
    leaseMs: LEASE_MS,
  });

  // 生产 drainer + 端口注入短 processing lease（outbox 默认 2min 会拖慢故障恢复观察）；
  // claim 必须收窄到本 tenant——跨租户行对故障注入子进程不可见，也避免并发场景互相抢行。
  const outbox = new PgSideEffectOutbox(pool);
  const shortLeaseOutbox: SideEffectOutboxPort = {
    enqueue: (input) => outbox.enqueue(input),
    claimPending: (limit: number, opts?: SideEffectClaimOptions) =>
      outbox.claimPending(limit, {
        ...(opts ?? {}),
        leaseMs: opts?.leaseMs ?? LEASE_MS,
        tenantId: opts?.tenantId ?? tenant,
      }),
    complete: (input) => outbox.complete(input),
    markFailed: (input) => outbox.markFailed(input),
  };
  const drainer = createSideEffectDrainer({
    outbox: shortLeaseOutbox,
    handlers: service.stageHandlers(),
    tickMs: 60_000,
  });
  const scanner = createKnowledgeIntakeDueScanner({ repository: baseRepo, limit: 10 });
  await scanner.scanOnce();

  if (mode !== "recover") {
    // 持续 drain；对应故障点命中后子进程挂起等待父进程 SIGKILL。
    for (;;) await drainer.drainOnce();
  }

  for (let round = 0; round < 120; round += 1) {
    await drainer.drainOnce();
    const rows = await pool.query<{ id: string; status: string; stage: string }>(
      `SELECT id, status, stage FROM knowledge_intake_runs WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [tenant],
    );
    if (rows.rowCount === 1) {
      const run = rows.rows[0]!;
      if (run.status === "completed" || run.status === "dead-letter") {
        process.stdout.write(`RECOVERED:${run.id}:${run.status}:${run.stage}\n`);
        await pool.end();
        return;
      }
    }
    await sleep(100);
  }
  process.stderr.write(`g8-stage-sigkill-child: recovery did not settle for tenant ${tenant}\n`);
  await pool.end();
  process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(String(error instanceof Error ? error.stack ?? error.message : error));
  process.exitCode = 1;
});
