/**
 * application/gateway/pth-gateway-facade.ts — gateway 唯一允许持有的 kernel 适配面（模块化 v2 P0-3）。
 *
 * gateway 路由不得 import KernelRuntime/DataWorldAccess，也不得访问 kernel.pool / kernel.dataWorld /
 * kernel.batchManager；所有数据访问经本 facade 的 route-shape 方法完成。
 * 本文件是唯一把 KernelRuntime 变换为 gateway 窄端口的 adapter。
 */

import type { KernelRuntime } from "../../kernel/assembly.js";
import type { BatchProfile } from "../../kernel/execution/worker-cluster.js";
import type { PublishInput, Task } from "../../kernel/storage/task-store-pg.js";
import { DEFAULT_TENANT_ID, withMemoryTenant, type MemoryEntry } from "@away_from/pth-memory";
import type { TaskCancelResult, TenantScope } from "../../contracts/index.js";
import { TaskControlService } from "../../tasking/task-control-service.js";
import { PgTaskQueries } from "../../tasking/task-queries.js";
import {
  createPgKnowledgeVerificationRepo,
  promoteKnowledgeEntry,
  recordKnowledgeVerdict,
  type KnowledgeServiceAuth,
  type KnowledgeVerificationRepo,
} from "../../execution/knowledge-promotion.js";
import { buildRestrictedKnowledgeQuery } from "../../execution/knowledge-broker.js";
import type { KnowledgeVerdict } from "../../execution/knowledge-verdicts.js";
import {
  RuntimeObservationFacade,
  type RuntimeObservationScope,
  type RuntimeObservationWindow,
  type RuntimeTimelinePage,
  type RuntimeTimelineQuery,
} from "../observation/runtime-observation-facade.js";

export type PthGatewayFacadeInput = KernelRuntime;

export interface TaskCounts {
  pending: number;
  claimed: number;
  submitted: number;
  completed: number;
  rejected: number;
  escalated: number;
  total: number;
}

export interface SpawnBatchesResult {
  spawned: number;
  mode: string;
  batches: Array<{ id: string; pid: number; workers: string[] }>;
}

export interface PthGatewayFacade {
  bridgeQuery(sql: string, tenantId: string, space: string): Promise<Array<Record<string, unknown> | null>>;
  bridgeRetrieve(anchors: string[], kinds: string[] | undefined, tenantId: string): Promise<MemoryEntry[]>;
  bridgeGet(id: string, tenantId: string): Promise<MemoryEntry | null>;
  execKernel(input: { code: string; mode: "stateless" | "repl"; sessionId?: string; timeoutMs?: number }): Promise<Record<string, unknown>>;
  /** P5b：jupyter 北向 notebook cell 执行（sessionId 持久；python/bash/ts） */
  execNotebook(input: { language: "python" | "bash" | "ts"; code: string; sessionId?: string; timeoutMs?: number }): Promise<Record<string, unknown>>;
  /** P5d：notebook session cancel（abort + dispose；不可恢复） */
  cancelNotebook(sessionId: string): Promise<boolean>;
  listTranscripts(taskId: string): Promise<Array<Record<string, unknown>>>;
  publishTask(input: PublishInput, scope?: TenantScope): Promise<Task>;
  listTasks(limit: number, scope?: TenantScope): Promise<Array<Record<string, unknown>>>;
  getTask(id: string, scope?: TenantScope): Promise<Record<string, unknown> | null>;
  /** N30 Task 3：tenant-scoped durable PTH 时间线只读投影。 */
  queryTimeline(
    scope: RuntimeObservationScope,
    window: RuntimeObservationWindow,
    cursorOrQuery?: string | RuntimeTimelineQuery | null,
  ): Promise<RuntimeTimelinePage>;
  /** W8 P2：取消任务（recursive=true 沿 delivery.parent 链传播到全部未终态子任务） */
  cancelTask(id: string, opts: { recursive?: boolean }, scope?: TenantScope): Promise<TaskCancelResult>;
  taskCounts(): Promise<TaskCounts>;
  /** N33 Task 5：优化建议列表可按 tenant 收窄（有 scope 时只列该 tenant 的可见建议）。 */
  optimizerSuggestions(scope?: TenantScope): Promise<unknown[]>;
  /** N33 Task 5：apply 按 tenant 收窄——有 scope 时 memory 读写被钉到该 tenant。 */
  applyOptimizer(id: string, scope?: TenantScope): Promise<unknown>;
  approveMemoryAdmin(id: string): Promise<unknown>;
  /** K4 Phase 4（N22 4）/R3：候选验证（监督通道）。auth 必填；verdict 绑定 planId+checkId+expectedCandidateRevision。 */
  verifyKnowledge(
    input: { planId: string; checkId: string; expectedCandidateRevision: number; verdict: KnowledgeVerdict },
    auth: KnowledgeServiceAuth,
    opts?: { tenantId?: string },
  ): Promise<unknown>;
  /** K4 Phase 4（N22 4）/R3：候选晋升 official（监督通道）。auth 必填；只接受 planId + expectedCandidateRevision。 */
  promoteKnowledge(
    input: { entryId: string; planId: string; expectedCandidateRevision: number },
    auth: KnowledgeServiceAuth,
    opts?: { tenantId?: string; promoterRole?: string; note?: string },
  ): Promise<unknown>;
  spawnBatches(count: number, profile?: BatchProfile): Promise<SpawnBatchesResult>;
  batchWorkers(id: string, action: "pause" | "resume" | "remove" | "add", role: string, copies: number): Promise<boolean>;
  /** N28 复核 Layer3：workerId 级副本控制（feasibility 模式）。 */
  batchReplica(id: string, action: "pause" | "resume" | "remove", workerId: string): Promise<boolean>;
  removeBatches(count: number): Promise<number>;
  listBatchesWithAlive(): Promise<Array<Record<string, unknown>>>;
  listJobs(): Promise<Array<Record<string, unknown>>>;
  getJob(id: string): Promise<Record<string, unknown>>;
  retrieveMemory(opts: { anchors?: string[]; kinds?: string[]; status?: string[] }): Promise<MemoryEntry[]>;
  writeMemory(entry: MemoryEntry, opts?: { force?: boolean }): Promise<void>;
  registerRoleToBatches(role: Record<string, unknown>): number;
  reloadTriggers(): Promise<number>;
  activityStream(): AsyncIterable<unknown>;
  crashLog(): Array<Record<string, unknown>>;
}

export class PthGatewayFacadeImpl implements PthGatewayFacade {
  #kernel: KernelRuntime;
  #control: TaskControlService;
  #verificationRepo: KnowledgeVerificationRepo;
  #observation: RuntimeObservationFacade;

  constructor(kernel: PthGatewayFacadeInput, verificationRepo?: KnowledgeVerificationRepo) {
    this.#kernel = kernel;
    this.#control = new TaskControlService({
      store: kernel.dataWorld.tasks,
      pool: kernel.pool,
      queries: new PgTaskQueries(kernel.pool),
    });
    this.#verificationRepo = verificationRepo ?? createPgKnowledgeVerificationRepo(kernel.pool);
    this.#observation = new RuntimeObservationFacade(kernel.pool);
  }

  bridgeQuery(sql: string, tenantId: string, space: string): Promise<Array<Record<string, unknown> | null>> {
    // R2（P0-2）：bridgeQuery 不再忽略 tenant；server 注入 tenant/status/space 谓词后才执行。
    // platform-admin 跨租户默认 deny：调用方只能按路由 auth 传来的 tenantId 查询自身租户，
    // 不提供隐式全局查询路径（跨租户诊断需另行裁决：显式目标租户 + 独立审计）。
    if (!tenantId) throw new Error("bridgeQuery: tenantId required（fail-closed）");
    if (!space) throw new Error("bridgeQuery: space required（fail-closed）");
    const restricted = buildRestrictedKnowledgeQuery(sql, tenantId, space);
    if (!restricted.ok) throw new Error(restricted.error);
    return this.#kernel.dataWorld.queryReadOnly(restricted.sql) as Promise<Array<Record<string, unknown> | null>>;
  }

  bridgeRetrieve(anchors: string[], kinds: string[] | undefined, tenantId: string): Promise<MemoryEntry[]> {
    return this.#kernel.dataWorld.memory.retrieve({ anchors, ...(kinds ? { kinds } : {}), status: ["official"], tenantId });
  }

  bridgeGet(id: string, tenantId: string): Promise<MemoryEntry | null> {
    return this.#kernel.dataWorld.memory.get(id, { tenantId }).then((e) => (e && e.status === "official" ? e : null));
  }

  async execKernel(input: { code: string; mode: "stateless" | "repl"; sessionId?: string; timeoutMs?: number }): Promise<Record<string, unknown>> {
    const result = await this.#kernel.execChannel.execute(input);
    return result as unknown as Record<string, unknown>;
  }

  async execNotebook(input: { language: "python" | "bash" | "ts"; code: string; sessionId?: string; timeoutMs?: number }): Promise<Record<string, unknown>> {
    const result = await this.#kernel.execChannel.executeNotebookCell(input);
    return result as unknown as Record<string, unknown>;
  }

  async cancelNotebook(sessionId: string): Promise<boolean> {
    return this.#kernel.execChannel.cancelNotebook(sessionId);
  }

  async listTranscripts(taskId: string): Promise<Array<Record<string, unknown>>> {
    const list = await this.#kernel.dataWorld.transcripts.listByTask(taskId);
    return list as unknown as Array<Record<string, unknown>>;
  }

  publishTask(input: PublishInput, scope?: TenantScope): Promise<Task> {
    return scope ? this.#control.publish(input, scope) : this.#kernel.dataWorld.tasks.publish(input);
  }

  async listTasks(limit: number, scope?: TenantScope): Promise<Array<Record<string, unknown>>> {
    if (scope) return this.#control.list(scope, limit);
    const res = await this.#kernel.pool.query(
      "SELECT id, title, text, tags, status, claimed_by, claims_count, created_at, payload FROM tasks ORDER BY created_at DESC LIMIT $1",
      [limit],
    );
    return res.rows as Array<Record<string, unknown>>;
  }

  async getTask(id: string, scope?: TenantScope): Promise<Record<string, unknown> | null> {
    if (scope) return this.#control.get(scope, id);
    const res = await this.#kernel.pool.query("SELECT * FROM tasks WHERE id = $1", [id]);
    return (res.rows[0] as Record<string, unknown> | undefined) ?? null;
  }

  queryTimeline(
    scope: RuntimeObservationScope,
    window: RuntimeObservationWindow,
    cursorOrQuery?: string | RuntimeTimelineQuery | null,
  ): Promise<RuntimeTimelinePage> {
    return this.#observation.queryTimeline(scope, window, cursorOrQuery);
  }

  cancelTask(id: string, opts: { recursive?: boolean }, scope?: TenantScope): Promise<TaskCancelResult> {
    const effectiveScope = scope ?? { tenantId: "default", principalId: "ptl", roles: ["ptl"], traceId: `cancel:${id}` };
    return this.#control.cancel(id, effectiveScope, opts);
  }

  async taskCounts(): Promise<TaskCounts> {
    const res = await this.#kernel.pool.query("SELECT status, count(*)::int AS n FROM tasks GROUP BY status");
    const counts: Record<string, number> = {};
    let total = 0;
    for (const row of res.rows as Array<{ status: string; n: number }>) {
      counts[row.status] = row.n;
      total += row.n;
    }
    return {
      pending: counts.pending ?? 0,
      claimed: counts.claimed ?? 0,
      submitted: counts.submitted ?? 0,
      completed: counts.completed ?? 0,
      rejected: counts.rejected ?? 0,
      escalated: counts.escalated ?? 0,
      total,
    };
  }

  async optimizerSuggestions(scope?: TenantScope): Promise<unknown[]> {
    // N33 Task 5：tenant-scoped 时走参数化查询（queryReadOnly 无参，不能内插 tenantId）。
    if (scope) {
      const res = await this.#kernel.pool.query(
        `SELECT id, status, kind, left(content::text, 200) AS preview, created_at FROM memory_entries WHERE kind = 'optimizer-suggestion' AND tenant_id = $1 ORDER BY created_at DESC LIMIT 20`,
        [scope.tenantId],
      );
      return res.rows as unknown[];
    }
    const rows = await this.#kernel.dataWorld.queryReadOnly(
      `SELECT id, status, kind, left(content::text, 200) AS preview, created_at FROM memory_entries WHERE kind = 'optimizer-suggestion' ORDER BY created_at DESC LIMIT 20`,
    );
    return rows as unknown[];
  }

  async applyOptimizer(id: string, scope?: TenantScope): Promise<unknown> {
    const { applyOptimizerSuggestion } = await import("../../kernel/execution/optimizer-apply.js");
    // N33 Task 5：有 scope 时把 memory store 钉到调用方 tenant（optimizer-apply 内部
    // 的 DEFAULT_TENANT_ID 会被 withMemoryTenant 覆盖）；canary/deopt 护栏保持不变。
    const memory = scope
      ? withMemoryTenant(this.#kernel.dataWorld.memory, scope.tenantId)
      : this.#kernel.dataWorld.memory;
    return applyOptimizerSuggestion(
      memory,
      id,
      this.#kernel.dataWorld.queryReadOnly,
      (t) => this.#kernel.dataWorld.tasks.publish({ title: t.title, text: t.text, createdBy: "optimizer", tags: t.tags, payload: t.payload }),
    );
  }

  async approveMemoryAdmin(id: string): Promise<unknown> {
    const memory = withMemoryTenant(this.#kernel.dataWorld.memory, DEFAULT_TENANT_ID);
    const proposal = await memory.get(id);
    if (proposal?.kind === "skill-maintain-proposal") {
      const { approveSkillProposal, executeApprovedSkillProposal } = await import("@away_from/pth-memory");
      const approved = await approveSkillProposal(memory, id);
      if (!approved.ok) return approved;
      const executed = await executeApprovedSkillProposal(memory, id);
      if (!executed.ok) return executed;
      return executed;
    }
    // N14 P3：工具注册提案同流（提案 → adversarial pass → 监督批准 → 注册生效）
    if (proposal?.kind === "tool-proposal") {
      const { approveToolProposal, executeApprovedToolProposal } = await import("@away_from/pth-memory");
      const approved = await approveToolProposal(memory, id);
      if (!approved.ok) return approved;
      const executed = await executeApprovedToolProposal(memory, id);
      if (!executed.ok) return executed;
      return executed;
    }
    // N15 B1：穿透稳定边提案同流（draft → 监督批准 → 执行注册 skill:penetrate:<child>）
    if (proposal?.kind === "penetration-proposal") {
      const { approvePenetrationProposal, executeApprovedPenetrationProposal } = await import("../../tasking/penetration-discovery.js");
      const approved = await approvePenetrationProposal(memory, id);
      if (!approved.ok) return approved;
      const executed = await executeApprovedPenetrationProposal(memory, id);
      if (!executed.ok) return executed;
      return executed;
    }
    const { applyMemoryAdminProposal } = await import("@away_from/pth-memory");
    return applyMemoryAdminProposal(memory, id);
  }

  verifyKnowledge(
    input: { planId: string; checkId: string; expectedCandidateRevision: number; verdict: KnowledgeVerdict },
    auth: KnowledgeServiceAuth,
    opts?: { tenantId?: string },
  ): Promise<unknown> {
    return recordKnowledgeVerdict(
      this.#kernel.dataWorld.memory,
      this.#verificationRepo,
      input.planId,
      input.checkId,
      input.expectedCandidateRevision,
      input.verdict,
      auth,
      { tenantId: opts?.tenantId ?? DEFAULT_TENANT_ID },
    );
  }

  promoteKnowledge(
    input: { entryId: string; planId: string; expectedCandidateRevision: number },
    auth: KnowledgeServiceAuth,
    opts?: { tenantId?: string; promoterRole?: string; note?: string },
  ): Promise<unknown> {
    return promoteKnowledgeEntry(
      this.#kernel.dataWorld.memory,
      this.#verificationRepo,
      input.entryId,
      input.planId,
      input.expectedCandidateRevision,
      auth,
      {
        tenantId: opts?.tenantId ?? DEFAULT_TENANT_ID,
        ...(opts?.promoterRole !== undefined ? { promoterRole: opts.promoterRole } : {}),
        ...(opts?.note !== undefined ? { note: opts.note } : {}),
      },
    );
  }

  async spawnBatches(count: number, profile?: BatchProfile): Promise<SpawnBatchesResult> {
    const handles: Array<{ id: string; pid: number; workers: string[] }> = [];
    for (let i = 0; i < count; i++) {
      const h = await this.#kernel.batchManager.spawnBatch(profile);
      handles.push({ id: h.id, pid: h.pid, workers: h.workers });
    }
    return { spawned: handles.length, mode: profile?.mode ?? "balanced", batches: handles };
  }

  async batchWorkers(id: string, action: "pause" | "resume" | "remove" | "add", role: string, copies: number): Promise<boolean> {
    if (action === "pause") return this.#kernel.batchManager.pauseWorker(id, role);
    if (action === "resume") return this.#kernel.batchManager.resumeWorker(id, role);
    if (action === "remove") return this.#kernel.batchManager.removeWorker(id, role);
    return this.#kernel.batchManager.addWorker(id, role, copies);
  }

  async batchReplica(id: string, action: "pause" | "resume" | "remove", workerId: string): Promise<boolean> {
    if (action === "pause") return this.#kernel.batchManager.pauseReplica(id, workerId);
    if (action === "resume") return this.#kernel.batchManager.resumeReplica(id, workerId);
    return this.#kernel.batchManager.removeReplica(id, workerId);
  }

  async removeBatches(count: number): Promise<number> {
    const batches = await this.#kernel.batchManager.listBatches();
    const targets = batches.slice(0, count);
    for (const b of targets) await this.#kernel.batchManager.killBatch(b.id);
    return targets.length;
  }

  async listBatchesWithAlive(): Promise<Array<Record<string, unknown>>> {
    const batches = await this.#kernel.batchManager.listBatches();
    return batches.map((b) => ({ ...b, alive: this.#kernel.batchManager.isBatchAlive(b.id) }));
  }

  async listJobs(): Promise<Array<Record<string, unknown>>> {
    const res = await this.#kernel.pool.query(
      `SELECT job_id,
              count(*)::int AS total,
              count(*) FILTER (WHERE status = 'completed')::int AS completed,
              count(*) FILTER (WHERE status IN ('rejected','escalated'))::int AS failed,
              min(created_at) AS created_at
       FROM tasks WHERE job_id IS NOT NULL
       GROUP BY job_id ORDER BY min(created_at) DESC LIMIT 50`,
    );
    return res.rows.map((r: any) => ({
      jobId: r.job_id,
      total: r.total,
      completed: r.completed,
      failed: r.failed,
      status: Number(r.completed) + Number(r.failed) >= Number(r.total) ? "completed" : "running",
      createdAt: r.created_at,
    }));
  }

  async getJob(id: string): Promise<Record<string, unknown>> {
    const res = await this.#kernel.pool.query(
      `SELECT id, title, text, tags, status, assigned_role, claimed_by,
              payload, created_at, completed_at,
              (rejects->-1->>'reason') AS last_reject
       FROM tasks WHERE job_id = $1 ORDER BY created_at`,
      [id],
    );
    const tasks = res.rows.map((r: any) => {
      const payload = (r.payload ?? {}) as Record<string, unknown>;
      return {
        id: r.id,
        title: r.title,
        text: String(r.text).slice(0, 200),
        tags: r.tags,
        status: r.status,
        role: r.assigned_role,
        error: r.last_reject ?? null,
        result: (payload.outputRef as { ref?: unknown } | undefined)?.ref ?? null,
        createdAt: r.created_at,
        completedAt: r.completed_at,
      };
    });
    const completed = tasks.filter((t: { status: string }) => t.status === "completed").length;
    const failed = tasks.filter((t: { status: string }) => t.status === "rejected" || t.status === "escalated").length;
    return {
      jobId: id,
      status: completed + failed >= tasks.length ? "completed" : "running",
      total: tasks.length,
      completed,
      failed,
      tasks,
    };
  }

  retrieveMemory(opts: { anchors?: string[]; kinds?: string[]; status?: string[] }): Promise<MemoryEntry[]> {
    return this.#kernel.dataWorld.memory.retrieve({ ...opts, tenantId: DEFAULT_TENANT_ID });
  }

  writeMemory(entry: MemoryEntry, opts?: { force?: boolean }): Promise<void> {
    return this.#kernel.dataWorld.memory.write({ ...entry, tenantId: entry.tenantId ?? DEFAULT_TENANT_ID }, opts);
  }

  registerRoleToBatches(role: Record<string, unknown>): number {
    return this.#kernel.batchManager.registerRoleToBatches(role);
  }

  reloadTriggers(): Promise<number> {
    return this.#kernel.triggerEngine.reload();
  }

  activityStream(): AsyncIterable<unknown> {
    return this.#kernel.activityHub.stream();
  }

  crashLog(): Array<Record<string, unknown>> {
    return this.#kernel.watchdog.getCrashLog() as unknown as Array<Record<string, unknown>>;
  }
}

export function createPthGatewayFacade(kernel: PthGatewayFacadeInput, verificationRepo?: KnowledgeVerificationRepo): PthGatewayFacade {
  return new PthGatewayFacadeImpl(kernel, verificationRepo);
}
