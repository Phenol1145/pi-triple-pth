/**
 * R6 组合验收（N27 wave-4 最后一棒）——真实 PostgreSQL 全链 + 七类故障注入。
 *
 * 覆盖契约 docs/pth/n27-r6-contract.md §4.1 与 §4.2：
 *   claim → context → commit → outbox（同事务）→ drainer → scoped draft candidate
 *   → VerificationPlan → domain+adversarial verdict → promotion（CAS+plan 绑定）
 *   → official → 生产 retrieve 命中；
 *   以及 crash-between-commit-and-enqueue / dual drainer / lease expiry /
 *   duplicate result / stale worker / cross-tenant / stale verdict 七类负向断言。
 *
 * Docker 不可用时 skip（与 packages/pth-memory/test/memory-store-pg.test.ts 同模式）；
 * 本轮验收环境 Docker 可用，故必须真实跑通，不允许以宿主无 DB 的 skip 作为证据。
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { getContainerRuntimeClient } from "testcontainers";
import { Pool } from "pg";
import {
  buildKnowledgeProvenance,
  isVisible,
  knowledgeEvidenceRefsFromMeta,
  PgMemoryStore,
  runReadOnlyQuery,
  setSpaceLookup,
  type KnowledgeEvidenceRef,
} from "@away_from/pth-memory";
import { applySchema } from "../../src/pth/kernel/storage/schema.js";
import { PgTaskStore } from "../../src/pth/kernel/storage/task-store-pg.js";
import { TaskControlService } from "../../src/pth/tasking/task-control-service.js";
import { PgTaskQueries } from "../../src/pth/tasking/task-queries.js";
import { createPgTaskRepository } from "../../src/pth/tasking/adapters/pg-task-repository.js";
import { TaskDispatcher } from "../../src/pth/tasking/task-dispatcher.js";
import { TaskOutcomeCommitter } from "../../src/pth/tasking/task-outcome-committer.js";
import {
  PgSideEffectOutbox,
  createSideEffectDrainer,
  type SideEffectOutboxPort,
} from "../../src/pth/tasking/side-effect-outbox.js";
import { createKnowledgeContextProvider } from "../../src/pth/runner/knowledge-context.js";
import {
  createKnowledgeBroker,
  searchKnowledgeEntries,
} from "../../src/pth/execution/knowledge-broker.js";
import {
  createPgKnowledgeVerificationRepo,
  recordKnowledgeVerdict,
  promoteKnowledgeEntry,
  type KnowledgeVerificationRepo,
} from "../../src/pth/execution/knowledge-promotion.js";
import {
  computeCandidateHash,
  sourceBindingsDigestOf,
} from "../../src/pth/execution/knowledge-verdicts.js";
import {
  DISCIPLINE_DEFINITIONS,
  DisciplineCatalogBuilder,
  createDisciplineResolver,
  PILOT_KNOWLEDGE,
  type DisciplineCatalogSnapshot,
} from "../../src/pth/catalog/index.js";
import { createExecutionGrantService } from "../../src/pth/execution/authorization/execution-grant-service.js";
import { createHmacGrantKeyProvider } from "../../src/pth/execution/authorization/grant-key-provider.js";
import { checkTaskRouting, routeTaskRole } from "../../src/pth/kernel/execution/role-router.js";
import { installDefaultRoles } from "../helpers.js";
import type {
  ExecutionGrant,
  TaskLease,
  TaskOutcome,
  TaskRunner,
  TaskWorkItem,
  TenantScope,
} from "../../src/pth/contracts/index.js";
import type { KnowledgeContext } from "../../src/pth/runner/knowledge-context.js";

// ── Docker 守卫 ──────────────────────────────────────────────────────────────
async function hasDocker(): Promise<boolean> {
  if (process.env.PTH_TEST_NO_DOCKER === "1") return false;
  try {
    await getContainerRuntimeClient();
    return true;
  } catch {
    return false;
  }
}

const dockerAvailable = await hasDocker();
const suite = dockerAvailable ? describe : describe.skip;

const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";
const SPACE_META = "meta";
const SPACE_DEV = "dev";
const SECRET = "r6-composition-acceptance-secret-0123456789";
const DOMAIN_PL = "programming-languages";
const DOMAIN_MS = "materials-science";

const grantKey = createHmacGrantKeyProvider({ secret: SECRET });
const grantService = createExecutionGrantService({
  keyProvider: grantKey,
  clock: () => new Date("2030-01-01T00:00:00.000Z"),
});

function issueGrant(opts: {
  tenantId?: string;
  space?: string;
  capabilities?: string[];
  role?: string;
} = {}): ExecutionGrant {
  const tenantId = opts.tenantId ?? TENANT_A;
  const role = opts.role ?? "developer";
  return grantService.issue({
    lease: { taskId: "task-r6", leaseId: randomUUID(), generation: 1 },
    scope: {
      tenantId,
      principalId: `worker:${role}`,
      roles: [role],
      traceId: "trace-r6",
      space: opts.space ?? SPACE_META,
    },
    workspace: { tenantId, workspaceId: "ws-r6", taskId: "task-r6" },
    language: "ts",
    capabilities: opts.capabilities ?? ["memory.read"],
    ttlMs: 60_000,
  });
}

function buildCatalog(): DisciplineCatalogSnapshot {
  const builder = new DisciplineCatalogBuilder();
  for (const def of DISCIPLINE_DEFINITIONS) builder.add(def);
  return builder.build();
}

function scopeOf(tenantId: string, role = "developer", taskId = "task-r6"): TenantScope {
  return {
    tenantId,
    principalId: `worker:${role}`,
    roles: [role],
    traceId: `task:${taskId}`,
  };
}

function provenanceOf(content: string, taskId: string, producerRole = "developer"): Record<string, unknown> {
  return buildKnowledgeProvenance({
    content,
    sourceTaskId: taskId,
    producerRole,
    producerModel: "deepseek-v4-flash",
    sourceRefs: [`task:${taskId}`],
    createdAt: 1, // 固定时间戳——重复写入同内容时保持幂等（version 不递增）
  });
}

suite("R6 组合验收（真实 PostgreSQL）", () => {
  let container: PostgreSqlContainer;
  let pool: Pool;
  let poolB: Pool;
  let store: PgMemoryStore;
  let repo: KnowledgeVerificationRepo;
  let taskRepository: ReturnType<typeof createPgTaskRepository>;
  let outbox: PgSideEffectOutbox;
  let outboxB: PgSideEffectOutbox;
  let catalog: DisciplineCatalogSnapshot;
  let taskControl: TaskControlService;
  let contextProvider: ReturnType<typeof createKnowledgeContextProvider>;

  beforeAll(async () => {
    installDefaultRoles();
    setSpaceLookup({
      get: (id) => {
        if (id === SPACE_DEV) return { parent: SPACE_META };
        if (id === "child") return { parent: SPACE_DEV };
        return undefined;
      },
    });

    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    poolB = new Pool({ connectionString: container.getConnectionUri() });
    await applySchema(pool);

    store = new PgMemoryStore(pool, { requireTenant: true });
    repo = createPgKnowledgeVerificationRepo(pool);
    outbox = new PgSideEffectOutbox(pool);
    outboxB = new PgSideEffectOutbox(poolB);
    taskRepository = createPgTaskRepository(pool, { leaseTtlMs: 60_000 });
    catalog = buildCatalog();

    const routedStore = new PgTaskStore(
      pool,
      { validate: checkTaskRouting, assign: routeTaskRole },
      createDisciplineResolver(catalog),
    );
    taskControl = new TaskControlService({
      store: routedStore,
      pool,
      queries: new PgTaskQueries(pool),
    });

    contextProvider = createKnowledgeContextProvider({
      memory: { retrieve: (opts) => store.retrieve(opts) },
      catalog,
      isVisible: (meta, space) => isVisible(meta, space),
    });

    // ── seed：双域 24 条 domain-fact × 双租户 + 多空间 ─────────────────────
    // tenant A：一条设为 dev/private（空间隔离负向）；其余 meta/public。
    // tenant B：全部 meta/public（跨租户负向）。
    for (const tenantId of [TENANT_A, TENANT_B]) {
      for (const entry of PILOT_KNOWLEDGE) {
        const space = tenantId === TENANT_A && entry.id === "pl-fact-type-checking"
          ? SPACE_DEV
          : SPACE_META;
        // N29 P0-4：official 领域知识 seed 走与 worker capability 分离的内部 authority。
        await store.write({
          id: `r6-${entry.id}`,
          tenantId,
          kind: entry.kind,
          anchors: [...entry.anchors],
          content: entry.content,
          status: "official",
          meta: {
            provenance: provenanceOf(entry.content, `seed:${entry.id}`, "domain:seed"),
            evidence: entry.evidence,
            spaceScope: { space, visibility: space === SPACE_META ? "public" : "private" },
          },
        }, { knowledgeOfficialAuthority: "seed-migration" });
      }
    }
  }, 120_000);

  afterAll(async () => {
    await Promise.all([pool.end(), poolB.end()]);
    await container.stop();
  });

  // 每个用例独立 outbox/tasks/verdict 工作面；memory_entries 的 24+24 条 seed 保留（beforeAll 一次写入）。
  beforeEach(async () => {
    await pool.query(
      "TRUNCATE knowledge_verdict_rows, knowledge_verification_plans, side_effect_outbox, tasks RESTART IDENTITY CASCADE",
    );
  });

  // ── §4.1 组合场景：claim → context → commit → outbox → candidate → verification → promotion → retrieve ──
  it("§4.1 全链：发布(domains 盖章)→claim→KnowledgeContext(结构化 evidence)→commit→outbox 同事务→drainer→scoped draft→plan→双 verdict→promotion(CAS+plan 绑定)→official→retrieve 命中", async () => {
    // 1. 发布任务：生产 resolver 盖章 domains/domainBinding。
    const published = await taskControl.publish(
      {
        title: "R6 组合验收：编程语言知识整理",
        text: "请基于类型检查与中间表示知识完成任务并提交总结",
        tags: ["code"],
        domains: [DOMAIN_PL],
        payload: {},
      },
      scopeOf(TENANT_A),
    );
    expect(published.tenantId).toBe(TENANT_A);
    expect(published.assigned_role).toBe("developer");
    expect((published.payload as { domains?: unknown }).domains).toEqual([DOMAIN_PL]);
    expect((published.payload as { domainBinding?: { resolverVersion?: string; primaryDomain?: string } }).domainBinding).toMatchObject({
      resolverVersion: "v1-explicit-alias",
      primaryDomain: DOMAIN_PL,
    });

    // 2. claim + KnowledgeContext 注入 + 执行完成 + commit + outbox 同事务落库。
    let capturedLease: TaskLease | undefined;
    let capturedWork: TaskWorkItem | undefined;
    let capturedContext: KnowledgeContext | undefined;
    let sideEffectKey = "";

    const runner: TaskRunner = {
      async run({ lease, work }) {
        capturedLease = lease;
        capturedWork = work;
        capturedContext = await contextProvider.build({
          tenantId: work.scope.tenantId,
          space: SPACE_META,
          roleId: work.assignedRole,
          domains: work.domains,
          title: work.title,
          text: work.text,
          catalogVersion: catalog.version,
        });
        return {
          lease: { taskId: lease.taskId, leaseId: lease.leaseId, generation: lease.generation },
          status: "completed",
          result: {
            value: {
              contextId: capturedContext.id,
              entryCount: capturedContext.entries.length,
              evidence: capturedContext.entries.map((e) => e.evidence),
            },
          },
          artifacts: [],
          traceId: work.scope.traceId,
        };
      },
    };

    const dispatcher = new TaskDispatcher({
      repository: taskRepository,
      committer: new TaskOutcomeCommitter(taskRepository),
      runner,
      observers: [],
      buildSideEffects: async (event) => {
        const tenantId = event.work.scope.tenantId;
        sideEffectKey = `refine:${tenantId}:${event.lease.taskId}:${event.lease.generation}`;
        return [{
          key: sideEffectKey,
          tenantId,
          kind: "refine",
          payload: {
            taskId: event.lease.taskId,
            roleId: event.work.assignedRole,
            tenantId,
            domains: event.work.domains,
            ...(event.work.domainBinding ? { domainBinding: event.work.domainBinding } : {}),
            candidate: {
              content: "R6 组合验收候选知识：类型检查与中间表示是编译器前后端协作的基础。",
              anchors: [DOMAIN_PL, "类型检查", "中间表示"],
              evidence: [
                { sourceId: "pl-jls", locator: "JLS SE23 §4.12.2", sourceVersion: "SE23", artifactHash: "r6-hash-001" },
                { sourceId: "pl-llvm-langref", locator: "LLVM LangRef: IR structure", quoteHash: "r6-hash-002" },
              ],
            },
          },
        }];
      },
    });

    const dispatchResult = await dispatcher.dispatchOnce(scopeOf(TENANT_A, "developer", published.id), "developer", [published.id]);
    expect(dispatchResult).toEqual({ claimed: 1, ran: 1, committed: 1, skipped: 0 });

    // 断言 claim 阶段落库形态：真实 lease + work.domains/domainBinding。
    expect(capturedLease).toMatchObject({ taskId: published.id, generation: 1 });
    expect(capturedWork).toMatchObject({ assignedRole: "developer" });
    expect(capturedWork?.domains).toEqual([DOMAIN_PL]);
    expect(capturedWork?.domainBinding?.primaryDomain).toBe(DOMAIN_PL);

    // 断言 KnowledgeContext 注入：命中 official 种子且 evidence 为结构化 KnowledgeEvidenceRef[]；
    // 且 dev/private 条目不可见（空间隔离）。
    expect(capturedContext).toBeDefined();
    expect(capturedContext!.domains).toEqual([DOMAIN_PL]);
    expect(capturedContext!.entries.length).toBeGreaterThan(0);
    const contextIds = capturedContext!.entries.map((e) => e.entryId);
    expect(contextIds).toContain("r6-pl-fact-ir");
    expect(contextIds).not.toContain("r6-pl-fact-type-checking");
    const irEntry = capturedContext!.entries.find((e) => e.entryId === "r6-pl-fact-ir");
    expect(irEntry).toBeDefined();
    expect(irEntry!.evidence.length).toBeGreaterThan(0);
    expect(irEntry!.evidence[0]).toMatchObject({ sourceId: "pl-llvm-langref", locator: expect.any(String) });

    // 断言 commit 与 outbox 同事务落库（task=completed + outbox=pending refine）。
    const taskRow = await pool.query(
      "SELECT status, payload FROM tasks WHERE id = $1 AND tenant_id = $2",
      [published.id, TENANT_A],
    );
    expect(taskRow.rows[0].status).toBe("completed");
    expect(taskRow.rows[0].payload.result).toEqual({ value: expect.objectContaining({ contextId: capturedContext!.id }) });
    const outboxRow = await pool.query(
      "SELECT status, kind, attempts, payload FROM side_effect_outbox WHERE key = $1",
      [sideEffectKey],
    );
    expect(outboxRow.rows[0]).toMatchObject({ status: "pending", kind: "refine", attempts: 0 });

    // 3. drainer 消费 → refiner 产出 scoped draft candidate（生产 store + provenance/evidence 形状）。
    let candidateId = "";
    let candidateContent = "";
    let candidateEvidence: KnowledgeEvidenceRef[] = [];
    const drainer = createSideEffectDrainer({
      outbox: outbox as SideEffectOutboxPort,
      handlers: {
        refine: async (payload) => {
          const p = payload as {
            taskId: string;
            tenantId: string;
            domains: string[];
            domainBinding?: unknown;
            candidate: { content: string; anchors: string[]; evidence: KnowledgeEvidenceRef[] };
          };
          candidateId = `r6-cand-${p.taskId}`;
          candidateContent = p.candidate.content;
          candidateEvidence = p.candidate.evidence;
          await store.write({
            id: candidateId,
            tenantId: p.tenantId,
            kind: "domain-fact",
            anchors: [...p.candidate.anchors],
            content: p.candidate.content,
            status: "draft",
            meta: {
              tenantId: p.tenantId,
              spaceScope: { space: SPACE_META, visibility: "private" as const },
              provenance: provenanceOf(p.candidate.content, p.taskId),
              evidence: p.candidate.evidence,
              domains: [...p.domains],
              ...(p.domainBinding ? { domainBinding: p.domainBinding } : {}),
            },
          });
        },
      },
    });
    await drainer.drainOnce();

    expect(candidateId).toBe(`r6-cand-${published.id}`);
    const candidate = await store.get(candidateId, { tenantId: TENANT_A });
    expect(candidate?.status).toBe("draft");
    expect(candidate?.meta?.version).toBe(1);
    expect(candidate?.meta?.spaceScope).toEqual({ space: SPACE_META, visibility: "private" });
    expect(candidate?.meta?.provenance).toMatchObject({ sourceTaskId: published.id, producerRole: "developer" });
    expect(knowledgeEvidenceRefsFromMeta(candidate?.meta)).toEqual(candidateEvidence);
    const outboxAfterDrain = await pool.query(
      "SELECT status, done_at FROM side_effect_outbox WHERE key = $1",
      [sideEffectKey],
    );
    expect(outboxAfterDrain.rows[0].status).toBe("done");
    expect(outboxAfterDrain.rows[0].done_at).not.toBeNull();

    // 4. 创建持久 VerificationPlan（plan 绑定 candidateRevision/candidateHash/sourceBindingsDigest）。
    const planId = `plan-${candidateId}`;
    const planHash = computeCandidateHash({
      content: candidateContent,
      domains: [DOMAIN_PL],
      evidence: candidateEvidence,
      effect: null,
    });
    const planDigest = sourceBindingsDigestOf(candidateEvidence);
    await pool.query(
      `INSERT INTO knowledge_verification_plans
         (id, tenant_id, candidate_id, candidate_revision, candidate_hash, required_domains, checks, source_bindings_digest, status)
       VALUES ($1, $2, $3, 1, $4, $5::jsonb, $6::jsonb, $7, 'open')`,
      [
        planId,
        TENANT_A,
        candidateId,
        planHash,
        JSON.stringify([DOMAIN_PL]),
        JSON.stringify([
          {
            checkId: "domain-1",
            kind: "domain",
            domainId: DOMAIN_PL,
            quorum: 1,
            eligiblePrincipals: ["tenant:tenant-a:domain-verifier"],
            separationFrom: ["producer", "other-verifier"],
          },
          {
            checkId: "adv-1",
            kind: "adversarial",
            quorum: 1,
            eligiblePrincipals: ["worker:controller:adversarial"],
            separationFrom: ["producer", "other-verifier"],
          },
        ]),
        planDigest,
      ],
    );
    const plan = await repo.getPlan(planId, TENANT_A);
    expect(plan).toMatchObject({
      candidateId,
      candidateRevision: 1,
      candidateHash: planHash,
      sourceBindingsDigest: planDigest,
      status: "open",
    });

    // 5. domain + adversarial verdict（不同 principal；service 强制 auth/planId/revision）。
    const authDomain = { principalId: "tenant:tenant-a:domain-verifier", executionId: "task-domain-verifier", roleId: "domain-verifier" };
    const authAdv = { principalId: "worker:controller:adversarial", executionId: "task-adversarial", roleId: "controller:adversarial" };
    const domainVerdict = await recordKnowledgeVerdict(
      store, repo, planId, "domain-1", 1,
      {
        kind: "domain",
        verdict: "pass",
        reviewerRole: "domain:expert",
        note: "domain evidence verified against source registry",
        at: Date.now(),
        domainId: DOMAIN_PL,
        evidence: ["JLS SE23 §4.12.2", "LLVM LangRef IR structure"],
      },
      authDomain,
      { tenantId: TENANT_A },
    );
    expect(domainVerdict).toEqual({ ok: true });
    const adversarialVerdict = await recordKnowledgeVerdict(
      store, repo, planId, "adv-1", 1,
      {
        kind: "adversarial",
        verdict: "pass",
        reviewerRole: "controller:adversarial",
        note: "no shortcut or pitfall uncovered",
        at: Date.now() + 1,
        evidence: ["adversarial pass probe"],
      },
      authAdv,
      { tenantId: TENANT_A },
    );
    expect(adversarialVerdict).toEqual({ ok: true });

    const verdictRows = await repo.listVerdictRows(planId, TENANT_A);
    expect(verdictRows).toHaveLength(2);
    expect(verdictRows.map((r) => r.checkId).sort()).toEqual(["adv-1", "domain-1"]);
    expect(verdictRows.every((r) => r.candidateRevision === 1 && r.candidateHash === planHash)).toBe(true);
    expect(verdictRows.map((r) => r.principalId).sort()).toEqual([
      "tenant:tenant-a:domain-verifier",
      "worker:controller:adversarial",
    ]);
    expect((await repo.getPlan(planId, TENANT_A))?.status).toBe("satisfied");

    // 6. promotion：R1 单事务 CAS + R3 plan 绑定 + 同事务 promotion-index outbox。
    const authMk = { principalId: "worker:memory-keeper", executionId: "task-memory-keeper", roleId: "memory-keeper" };
    const promoted = await promoteKnowledgeEntry(
      store, repo, candidateId, planId, 1, authMk, { tenantId: TENANT_A },
    );
    expect(promoted).toEqual({ ok: true, id: candidateId });

    const official = await store.get(candidateId, { tenantId: TENANT_A });
    expect(official?.status).toBe("official");
    expect(official?.meta?.version).toBe(2);
    expect(official?.meta?.promotion).toMatchObject({
      promotedBy: "memory-keeper",
      principalId: "worker:memory-keeper",
      planId,
      candidateRevision: 1,
    });
    const history = await store.revisionHistory(candidateId, { tenantId: TENANT_A });
    expect(history.map((h) => h.revision)).toEqual([1]);
    expect(history[0]).toMatchObject({ status: "draft", reason: "knowledge-promotion" });
    const promotionOutbox = await pool.query(
      "SELECT kind, status FROM side_effect_outbox WHERE key = $1",
      [`promotion-index:${TENANT_A}:${candidateId}:${planId}`],
    );
    expect(promotionOutbox.rows[0]).toMatchObject({ kind: "promotion-index", status: "pending" });

    // 7. 生产 retrieve 命中（KnowledgeBroker search 窄口；tenant/status/space 全由生产端口保证）。
    const broker = createKnowledgeBroker({
      grantService,
      dataWorld: {
        queryReadOnly: (sql) => runReadOnlyQuery(pool, sql),
        memory: {
          retrieve: (opts) => store.retrieve(opts),
          get: (id, opts) => store.get(id, opts),
          search: (opts) => searchKnowledgeEntries(store, opts),
        },
      },
      isVisible: (meta, space) => isVisible(meta, space),
    });
    const searchResult = await broker.query({
      grant: issueGrant({ tenantId: TENANT_A, space: SPACE_META }),
      op: "search",
      domains: [DOMAIN_PL],
      queryText: "类型检查 中间表示",
      limit: 20,
    });
    expect(searchResult.ok).toBe(true);
    if (!searchResult.ok) return;
    const searchIds = (searchResult.entries as Array<{ id: string }>).map((e) => e.id);
    expect(searchIds).toContain(candidateId);
    expect(searchIds).not.toContain("r6-pl-fact-type-checking"); // dev/private 空间隔离在检索面同样成立

    const getResult = await broker.query({
      grant: issueGrant({ tenantId: TENANT_A, space: SPACE_META }),
      op: "get",
      id: candidateId,
    });
    expect(getResult.ok).toBe(true);
    if (getResult.ok) {
      expect((getResult.entry as { status: string }).status).toBe("official");
    }
  });

  // ── §4.2 七类故障注入（全部负向断言）───────────────────────────────────────

  it("§4.2 crash between commit and enqueue：enqueue 失败 → task commit 整体回滚，candidate 不永久缺失", async () => {
    const taskId = "r6-atomic-task";
    const leaseId = randomUUID();
    await pool.query(
      `INSERT INTO tasks (id, tenant_id, title, text, created_by, status, assigned_role, lease_id, lease_generation, lease_expires_at)
       VALUES ($1, $2, 'atomic', 'x', 'r6', 'claimed', 'developer', $3, 1, now() + interval '5 minutes')`,
      [taskId, TENANT_A, leaseId],
    );
    const outcome: TaskOutcome = {
      lease: { taskId, leaseId, generation: 1 },
      status: "completed",
      result: { value: "ok" },
      artifacts: [],
      traceId: "trace-atomic",
    };

    // 注入：side_effect_outbox.key 为 NOT NULL，null key 触发 INSERT 失败 → 事务回滚。
    await expect(
      taskRepository.commit(outcome, {
        scope: { tenantId: TENANT_A },
        sideEffects: [{ key: null as unknown as string, tenantId: TENANT_A, kind: "refine", payload: { n: 1 } }],
      }),
    ).rejects.toThrow();

    let row = await pool.query("SELECT status FROM tasks WHERE id = $1 AND tenant_id = $2", [taskId, TENANT_A]);
    expect(row.rows[0].status).toBe("claimed"); // commit 未生效（回滚）
    let outboxRow = await pool.query(
      "SELECT count(*)::int AS n FROM side_effect_outbox WHERE key = $1",
      ["refine:tenant-a:r6-atomic-task:1"],
    );
    expect(outboxRow.rows[0].n).toBe(0);

    // 可修复：同 lease 重放 valid side effect → task completed + outbox pending 同事务落库。
    const repaired = await taskRepository.commit(outcome, {
      scope: { tenantId: TENANT_A },
      sideEffects: [{
        key: "refine:tenant-a:r6-atomic-task:1",
        tenantId: TENANT_A,
        kind: "refine",
        payload: { taskId, roleId: "developer", tenantId: TENANT_A },
      }],
    });
    expect(repaired).toEqual({ committed: true });
    row = await pool.query("SELECT status FROM tasks WHERE id = $1 AND tenant_id = $2", [taskId, TENANT_A]);
    expect(row.rows[0].status).toBe("completed");
    outboxRow = await pool.query(
      "SELECT status FROM side_effect_outbox WHERE key = $1",
      ["refine:tenant-a:r6-atomic-task:1"],
    );
    expect(outboxRow.rows[0].status).toBe("pending");
  });

  it("§4.2 dual drainer：两个独立连接并发 claim，同一 outbox 行不被处理两次", async () => {
    for (let i = 0; i < 20; i += 1) {
      await outbox.enqueue({ key: `r6-dual-${i}`, tenantId: TENANT_A, kind: "refine", payload: { i } });
    }
    const [a, b] = await Promise.all([
      outbox.claimPending(10, { owner: "drainer-a", leaseMs: 60_000 }),
      outboxB.claimPending(10, { owner: "drainer-b", leaseMs: 60_000 }),
    ]);
    expect(a).toHaveLength(10);
    expect(b).toHaveLength(10);
    const seen = new Set<string>();
    for (const row of [...a, ...b]) {
      expect(seen.has(row.key)).toBe(false);
      seen.add(row.key);
      expect(row.status).toBe("processing");
      expect(row.processingToken).toBeTruthy();
    }
    expect(seen.size).toBe(20);
    const leftover = await outbox.claimPending(1, { owner: "drainer-a", leaseMs: 60_000 });
    expect(leftover).toHaveLength(0);
  });

  it("§4.2 lease expiry：claim 后不 complete，租约过期被重新 claim，attempts 递增且不丢行", async () => {
    const key = "r6-lease-key";
    await outbox.enqueue({ key, tenantId: TENANT_A, kind: "refine", payload: { n: 1 } });
    const [first] = await outbox.claimPending(1, { owner: "drainer-a", leaseMs: 60_000 });
    expect(first).toBeDefined();
    expect(first!.attempts).toBe(1);

    await pool.query(
      "UPDATE side_effect_outbox SET locked_until = now() - interval '1 second' WHERE key = $1",
      [key],
    );

    const [second] = await outboxB.claimPending(1, { owner: "drainer-b", leaseMs: 60_000 });
    expect(second).toBeDefined();
    expect(second!.attempts).toBe(2);
    expect(second!.owner).toBe("drainer-b");
    expect(second!.processingToken).not.toBe(first!.processingToken);

    const db = await pool.query(
      "SELECT status, owner, attempts FROM side_effect_outbox WHERE key = $1",
      [key],
    );
    expect(db.rows[0]).toMatchObject({ status: "processing", owner: "drainer-b", attempts: 2 });
  });

  it("§4.2 stale worker：旧 token complete/markFailed 均 CAS 冲突，不能覆盖新状态", async () => {
    const key = "r6-stale-worker-key";
    await outbox.enqueue({ key, tenantId: TENANT_A, kind: "refine", payload: { n: 1 } });
    const [first] = await outbox.claimPending(1, { owner: "drainer-a", leaseMs: 60_000 });
    await pool.query(
      "UPDATE side_effect_outbox SET locked_until = now() - interval '1 second' WHERE key = $1",
      [key],
    );
    const [second] = await outboxB.claimPending(1, { owner: "drainer-b", leaseMs: 60_000 });
    expect(second).toBeDefined();

    // 旧 worker 想 complete：token 已不匹配 → false，行仍 processing。
    expect(await outbox.complete({ tenantId: TENANT_A, key, token: first!.processingToken! })).toBe(false);
    let row = await pool.query(
      "SELECT status, owner, processing_token FROM side_effect_outbox WHERE key = $1",
      [key],
    );
    expect(row.rows[0].status).toBe("processing");
    expect(row.rows[0].owner).toBe("drainer-b");
    expect(row.rows[0].processing_token).toBe(second!.processingToken);

    // 新 worker 完成后，旧 worker 想 markFailed 把行改回 pending：同样 CAS 拒绝。
    expect(await outboxB.complete({ tenantId: TENANT_A, key, token: second!.processingToken! })).toBe(true);
    expect(await outbox.markFailed({
      tenantId: TENANT_A,
      key,
      token: first!.processingToken!,
      attempts: first!.attempts,
      lastError: "stale worker after new owner completed",
    })).toBe(false);
    row = await pool.query("SELECT status FROM side_effect_outbox WHERE key = $1", [key]);
    expect(row.rows[0].status).toBe("done");
  });

  it("§4.2 duplicate result：同 key 重复 enqueue / 重复 promotion 幂等，不重复处理、不重复晋升", async () => {
    const key = "r6-duplicate-key";
    await outbox.enqueue({ key, tenantId: TENANT_A, kind: "refine", payload: { n: 1 } });
    // N29 P0-3：同 tenant/key 的 exact 重放（同 kind + payload + payload_hash）才算幂等；
    await outbox.enqueue({ key, tenantId: TENANT_A, kind: "refine", payload: { n: 1 } });
    // 不同 payload 不再 DO NOTHING 静默丢弃，而是显式 conflict（不覆盖首写）。
    await expect(
      outbox.enqueue({ key, tenantId: TENANT_A, kind: "refine", payload: { n: 2 } }),
    ).rejects.toThrow(/conflict/);
    const countRow = await pool.query("SELECT count(*)::int AS n FROM side_effect_outbox WHERE key = $1", [key]);
    expect(countRow.rows[0].n).toBe(1);

    let handled = 0;
    const drainer = createSideEffectDrainer({
      outbox: outbox as SideEffectOutboxPort,
      handlers: {
        refine: async () => {
          handled += 1;
          await store.write({
            id: "r6-dup-candidate",
            tenantId: TENANT_A,
            kind: "domain-fact",
            anchors: [DOMAIN_PL],
            content: "duplicate candidate content",
            status: "draft",
            meta: {
              tenantId: TENANT_A,
              spaceScope: { space: SPACE_META, visibility: "private" as const },
              provenance: provenanceOf("duplicate candidate content", "task-dup"),
              evidence: [{ sourceId: "pl-jls", locator: "JLS SE23" }],
              domains: [DOMAIN_PL],
            },
          });
        },
      },
    });
    await drainer.drainOnce();
    expect(handled).toBe(1);
    expect((await pool.query("SELECT status FROM side_effect_outbox WHERE key = $1", [key])).rows[0].status).toBe("done");

    // 同内容重复 write 幂等：version 不递增。
    await store.write({
      id: "r6-dup-candidate",
      tenantId: TENANT_A,
      kind: "domain-fact",
      anchors: [DOMAIN_PL],
      content: "duplicate candidate content",
      status: "draft",
      meta: {
        tenantId: TENANT_A,
        spaceScope: { space: SPACE_META, visibility: "private" as const },
        provenance: provenanceOf("duplicate candidate content", "task-dup"),
        evidence: [{ sourceId: "pl-jls", locator: "JLS SE23" }],
        domains: [DOMAIN_PL],
      },
    });
    expect((await store.get("r6-dup-candidate", { tenantId: TENANT_A }))?.meta?.version).toBe(1);

    // 重复 promotion 幂等：同 promoter 重放不重复写 revision、不重复插入 promotion-index outbox。
    const content = "duplicate candidate content";
    const evidence = [{ sourceId: "pl-jls", locator: "JLS SE23" }];
    const planId = "plan-r6-dup-candidate";
    await pool.query(
      `INSERT INTO knowledge_verification_plans
         (id, tenant_id, candidate_id, candidate_revision, candidate_hash, required_domains, checks, source_bindings_digest, status)
       VALUES ($1, $2, 'r6-dup-candidate', 1, $3, $4::jsonb, $5::jsonb, $6, 'satisfied')`,
      [
        planId,
        TENANT_A,
        computeCandidateHash({ content, domains: [DOMAIN_PL], evidence, effect: null }),
        JSON.stringify([DOMAIN_PL]),
        JSON.stringify([
          {
            checkId: "domain-1",
            kind: "domain",
            domainId: DOMAIN_PL,
            quorum: 1,
            eligiblePrincipals: ["tenant:tenant-a:domain-verifier"],
            separationFrom: ["producer"],
          },
          {
            checkId: "adv-1",
            kind: "adversarial",
            quorum: 1,
            eligiblePrincipals: ["worker:controller:adversarial"],
            separationFrom: ["producer"],
          },
        ]),
        sourceBindingsDigestOf(evidence),
      ],
    );
    await repo.insertVerdictRow({
      planId,
      tenantId: TENANT_A,
      checkId: "domain-1",
      candidateId: "r6-dup-candidate",
      candidateRevision: 1,
      candidateHash: computeCandidateHash({ content, domains: [DOMAIN_PL], evidence, effect: null }),
      principalId: "tenant:tenant-a:domain-verifier",
      executionId: "task-domain-verifier",
      kind: "domain",
      verdict: "pass",
      reviewerRole: "domain:expert",
      note: "verified",
      domainId: DOMAIN_PL,
      evidence: [],
      at: 1,
    });
    await repo.insertVerdictRow({
      planId,
      tenantId: TENANT_A,
      checkId: "adv-1",
      candidateId: "r6-dup-candidate",
      candidateRevision: 1,
      candidateHash: computeCandidateHash({ content, domains: [DOMAIN_PL], evidence, effect: null }),
      principalId: "worker:controller:adversarial",
      executionId: "task-adversarial",
      kind: "adversarial",
      verdict: "pass",
      reviewerRole: "controller:adversarial",
      note: "verified",
      evidence: [],
      at: 2,
    });

    const authMk = { principalId: "worker:memory-keeper", executionId: "task-mk", roleId: "memory-keeper" };
    const firstPromote = await promoteKnowledgeEntry(
      store, repo, "r6-dup-candidate", planId, 1, authMk, { tenantId: TENANT_A },
    );
    const secondPromote = await promoteKnowledgeEntry(
      store, repo, "r6-dup-candidate", planId, 1, authMk, { tenantId: TENANT_A },
    );
    expect(firstPromote).toEqual({ ok: true, id: "r6-dup-candidate" });
    expect(secondPromote).toEqual({ ok: true, id: "r6-dup-candidate" }); // 幂等重放

    const history = await store.revisionHistory("r6-dup-candidate", { tenantId: TENANT_A });
    expect(history.map((h) => h.revision)).toEqual([1]); // 只晋升一次
    const outboxCount = await pool.query(
      "SELECT count(*)::int AS n FROM side_effect_outbox WHERE key = $1",
      [`promotion-index:${TENANT_A}:r6-dup-candidate:${planId}`],
    );
    expect(outboxCount.rows[0].n).toBe(1); // 幂等 key 首写生效
  });

  it("§4.2 cross-tenant：tenant B 全程无法检索/verify/promote tenant A 的 candidate；raw query 与 retrieve 双负向", async () => {
    // 准备 tenant A 的 draft candidate + plan。
    const candidateId = "r6-cross-tenant-candidate";
    const content = "cross-tenant isolation candidate";
    const evidence = [{ sourceId: "pl-jls", locator: "JLS SE23" }];
    await store.write({
      id: candidateId,
      tenantId: TENANT_A,
      kind: "domain-fact",
      anchors: [DOMAIN_PL],
      content,
      status: "draft",
      meta: {
        tenantId: TENANT_A,
        spaceScope: { space: SPACE_META, visibility: "private" as const },
        provenance: provenanceOf(content, "task-cross-tenant"),
        evidence,
        domains: [DOMAIN_PL],
      },
    });
    const planId = "plan-r6-cross-tenant";
    await pool.query(
      `INSERT INTO knowledge_verification_plans
         (id, tenant_id, candidate_id, candidate_revision, candidate_hash, required_domains, checks, source_bindings_digest, status)
       VALUES ($1, $2, $3, 1, $4, $5::jsonb, $6::jsonb, $7, 'open')`,
      [
        planId,
        TENANT_A,
        candidateId,
        computeCandidateHash({ content, domains: [DOMAIN_PL], evidence, effect: null }),
        JSON.stringify([DOMAIN_PL]),
        JSON.stringify([
          {
            checkId: "domain-1",
            kind: "domain",
            domainId: DOMAIN_PL,
            quorum: 1,
            eligiblePrincipals: ["tenant:tenant-a:domain-verifier"],
            separationFrom: ["producer"],
          },
          {
            checkId: "adv-1",
            kind: "adversarial",
            quorum: 1,
            eligiblePrincipals: ["worker:controller:adversarial"],
            separationFrom: ["producer"],
          },
        ]),
        sourceBindingsDigestOf(evidence),
      ],
    );

    // store 层：tenant B 读不到 tenant A 的 candidate / 官方种子。
    expect(await store.get(candidateId, { tenantId: TENANT_B })).toBeUndefined();
    const bEntries = await store.retrieve({ anchors: [DOMAIN_PL], tenantId: TENANT_B });
    expect(bEntries.some((e) => e.tenantId === TENANT_A)).toBe(false);
    expect(bEntries.every((e) => e.tenantId === TENANT_B)).toBe(true);

    // raw query 数据面：tenant B 的 SQL 只能命中 tenant B 行（谓词由 server 注入）。
    const rawBroker = createKnowledgeBroker({
      grantService,
      dataWorld: {
        queryReadOnly: (sql) => runReadOnlyQuery(pool, sql),
        memory: {
          retrieve: async () => [],
          get: async () => undefined,
        },
      },
      isVisible: () => true, // 关闭 JS 兜底，证明隔离来自 SQL 数据面
    });
    const raw = await rawBroker.query({
      grant: issueGrant({ tenantId: TENANT_B, space: SPACE_META, capabilities: ["memory.read", "memory.query"] }),
      op: "query",
      sql: "SELECT id, tenant_id, status, meta FROM memory_entries",
    });
    expect(raw.ok).toBe(true);
    if (raw.ok) {
      const rows = raw.rows as Array<{ tenant_id: string; id: string }>;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.tenant_id === TENANT_B)).toBe(true);
      expect(rows.some((r) => r.id === candidateId)).toBe(false);
    }

    // retrieve 隔离：tenant B broker search 不返回 tenant A 候选。
    const broker = createKnowledgeBroker({
      grantService,
      dataWorld: {
        queryReadOnly: (sql) => runReadOnlyQuery(pool, sql),
        memory: {
          retrieve: (opts) => store.retrieve(opts),
          get: (id, opts) => store.get(id, opts),
          search: (opts) => searchKnowledgeEntries(store, opts),
        },
      },
      isVisible: (meta, space) => isVisible(meta, space),
    });
    const searchB = await broker.query({
      grant: issueGrant({ tenantId: TENANT_B, space: SPACE_META }),
      op: "search",
      domains: [DOMAIN_PL],
      queryText: "cross-tenant",
      limit: 20,
    });
    expect(searchB.ok).toBe(true);
    if (searchB.ok) {
      expect((searchB.entries as Array<{ id: string }>).some((e) => e.id === candidateId)).toBe(false);
    }

    // verify/promote：tenant B 找不到 tenant A 的 plan/candidate。
    const authDomain = { principalId: "tenant:tenant-a:domain-verifier", executionId: "task-d", roleId: "domain-verifier" };
    const authMk = { principalId: "worker:memory-keeper", executionId: "task-mk", roleId: "memory-keeper" };
    const verdictB = await recordKnowledgeVerdict(
      store, repo, planId, "domain-1", 1,
      {
        kind: "domain",
        verdict: "pass",
        reviewerRole: "domain:expert",
        note: "cross-tenant should not see plan",
        at: Date.now(),
        domainId: DOMAIN_PL,
      },
      authDomain,
      { tenantId: TENANT_B },
    );
    expect(verdictB).toMatchObject({ ok: false, error: expect.stringContaining("not found") });
    expect(await repo.listVerdictRows(planId, TENANT_B)).toEqual([]);

    const promoteB = await promoteKnowledgeEntry(
      store, repo, candidateId, planId, 1, authMk, { tenantId: TENANT_B },
    );
    expect(promoteB).toMatchObject({ ok: false, error: expect.stringContaining("not found") });
    // tenant A 的 candidate 仍为 draft——未被跨租户 promote 污染。
    expect((await store.get(candidateId, { tenantId: TENANT_A }))?.status).toBe("draft");
  });

  it("§4.2 stale verdict：计划创建后修改 candidate 内容 → 旧 plan/verdict 不能晋升新版本", async () => {
    const candidateId = "r6-stale-verdict-candidate";
    const contentV1 = "stale verdict candidate v1";
    const evidence = [{ sourceId: "pl-jls", locator: "JLS SE23" }];
    await store.write({
      id: candidateId,
      tenantId: TENANT_A,
      kind: "domain-fact",
      anchors: [DOMAIN_PL],
      content: contentV1,
      status: "draft",
      meta: {
        tenantId: TENANT_A,
        spaceScope: { space: SPACE_META, visibility: "private" as const },
        provenance: provenanceOf(contentV1, "task-stale-verdict"),
        evidence,
        domains: [DOMAIN_PL],
      },
    });

    const planId = "plan-r6-stale-verdict";
    const hashV1 = computeCandidateHash({ content: contentV1, domains: [DOMAIN_PL], evidence, effect: null });
    await pool.query(
      `INSERT INTO knowledge_verification_plans
         (id, tenant_id, candidate_id, candidate_revision, candidate_hash, required_domains, checks, source_bindings_digest, status)
       VALUES ($1, $2, $3, 1, $4, $5::jsonb, $6::jsonb, $7, 'open')`,
      [
        planId,
        TENANT_A,
        candidateId,
        hashV1,
        JSON.stringify([DOMAIN_PL]),
        JSON.stringify([
          {
            checkId: "domain-1",
            kind: "domain",
            domainId: DOMAIN_PL,
            quorum: 1,
            eligiblePrincipals: ["tenant:tenant-a:domain-verifier"],
            separationFrom: ["producer"],
          },
          {
            checkId: "adv-1",
            kind: "adversarial",
            quorum: 1,
            eligiblePrincipals: ["worker:controller:adversarial"],
            separationFrom: ["producer"],
          },
        ]),
        sourceBindingsDigestOf(evidence),
      ],
    );

    // 先让 plan 满足（旧版本 verdict 曾合法）。
    const authDomain = { principalId: "tenant:tenant-a:domain-verifier", executionId: "task-d", roleId: "domain-verifier" };
    const authAdv = { principalId: "worker:controller:adversarial", executionId: "task-a", roleId: "controller:adversarial" };
    expect((await recordKnowledgeVerdict(store, repo, planId, "domain-1", 1, {
      kind: "domain", verdict: "pass", reviewerRole: "domain:expert", note: "v1 verified", at: 1, domainId: DOMAIN_PL,
    }, authDomain, { tenantId: TENANT_A })).ok).toBe(true);
    expect((await recordKnowledgeVerdict(store, repo, planId, "adv-1", 1, {
      kind: "adversarial", verdict: "pass", reviewerRole: "controller:adversarial", note: "v1 verified", at: 2,
    }, authAdv, { tenantId: TENANT_A })).ok).toBe(true);
    expect((await repo.getPlan(planId, TENANT_A))?.status).toBe("satisfied");

    // 计划创建后修改 candidate 内容：version 1 → 2；旧 plan 仍绑定 revision 1 / hashV1。
    await store.update(candidateId, {
      content: "stale verdict candidate v2（修改后旧 verdict 必须失活）",
    }, { tenantId: TENANT_A, reason: "stale-verdict-probe" });
    expect((await store.get(candidateId, { tenantId: TENANT_A }))?.meta?.version).toBe(2);

    // 旧 plan/verdict 不能晋升新版本：promotion 严格 expectedRevision CAS 失败。
    const authMk = { principalId: "worker:memory-keeper", executionId: "task-mk", roleId: "memory-keeper" };
    const promoted = await promoteKnowledgeEntry(
      store, repo, candidateId, planId, 1, authMk, { tenantId: TENANT_A },
    );
    expect(promoted).toMatchObject({ ok: false, error: expect.stringContaining("expectedRevision") });
    // 未被晋升：仍 draft。
    expect((await store.get(candidateId, { tenantId: TENANT_A }))?.status).toBe("draft");

    // 新 revision 建立新计划后，verdict 必须重新按新 hash 签发——旧 verdict 行 hash 失配，canPromote 拒绝。
    const hashV2 = computeCandidateHash({
      content: "stale verdict candidate v2（修改后旧 verdict 必须失活）",
      domains: [DOMAIN_PL],
      evidence,
      effect: null,
    });
    await pool.query(
      `UPDATE knowledge_verification_plans
       SET candidate_revision = 2, candidate_hash = $3, status = 'open', updated_at = now()
       WHERE id = $1 AND tenant_id = $2`,
      [planId, TENANT_A, hashV2],
    );
    const stalePromote = await promoteKnowledgeEntry(
      store, repo, candidateId, planId, 2, authMk, { tenantId: TENANT_A },
    );
    expect(stalePromote.ok).toBe(false);
    // fail-closed：旧 provenance/contentHash 与修改后内容不一致，必须先于 plan.status 拒绝。
    if (!stalePromote.ok) {
      expect(stalePromote.error).toMatch(/provenance|candidateHash|plan\.status/);
    }
  });
});
