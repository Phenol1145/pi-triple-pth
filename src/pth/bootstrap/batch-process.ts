import { mkdir, readFile } from "node:fs/promises";
import { resolve as resolvePath, relative as relativePath, isAbsolute, sep } from "node:path";
import { createPgPool } from "../kernel/storage/pg.js";
import { applySchema } from "../kernel/storage/schema.js";
import { createDataWorld } from "../kernel/storage/index.js";
import { DISCIPLINE_DEFINITIONS, DisciplineCatalogBuilder, createDisciplineResolver, type DisciplineCatalogSnapshot } from "../catalog/index.js";
import { createWorkerKernel, createWorkerKernelWithManager, createKernelManager } from "../impls/kernels/index.js";
import type { InterpreterResult } from "../kernel/interpreter/index.js";
import type { Task } from "../kernel/storage/task-store-pg.js";
import { parseRoleWeights, expandRoleWeights, registerWorkerRole, knownRoleById, allWorkerRoles, setDefaultRoles } from "../kernel/execution/worker-cluster.js";
import { DEFAULT_TENANT_ID, isVisible, setSpaceLookup } from "@away_from/pth-memory";
import { spaceRegistry } from "../kernel/execution/space-registry.js";
import { registerBuiltinSpaces } from "../kernel/execution/builtin-spaces.js";
import { checkTaskRouting, routeTaskRole } from "../kernel/execution/role-router.js";
import { ORIGIN_ROLE, DEFAULT_ROLES, MID_ROLES, GOVERNANCE_ROLES } from "../kernel/execution/builtin-roles.js";
import { getEventBus } from "../kernel/execution/event-bus.js";
import { isForwardableKernelEvent, toKernelActivityEvent } from "../kernel/execution/kernel-event-bridge.js";
import { TaskLoop, type TaskLoopDeps } from "./task-loop.js";
import { createKnowledgeContextProvider } from "../runner/index.js";
import {
  createPgTaskRepository,
  TaskControlService,
  PgTaskQueries,
  allowedDelegationTargets,
  childBudgetFor,
  createPenetrationRunner,
  penetrationBudgetError,
  recordPenetrationUse,
  PgSideEffectOutbox,
  createSideEffectDrainer,
  type PenetrationBudgetConfig,
  type PenetrationLedger,
} from "../tasking/index.js";
import { DefaultTaskWorkspaceManager } from "../kernel/execution/workspace.js";
import { archiveTask, type ArchiveDeps } from "../kernel/execution/archive.js";
import { createKernelModelRouter } from "../kernel/execution/model-router.js";
import { createLlmFn } from "../kernel/interpreter/llm-fn.js";
import { Refiner, type RefineInput } from "../kernel/execution/refiner.js";
import { Optimizer } from "../kernel/execution/optimizer-loop.js";
import { createToolstore } from "../kernel/interpreter/toolstore.js";
import { createKernelLogger } from "../kernel/logger.js";
import { loadKernelConfig } from "../kernel/interpreter/kernel-config.js";
import { pthConfig } from "../config/index.js";
import { runAgentTask } from "../kernel/execution/agent-loop.js";
import { assembleWorkerSlotIdentity } from "./worker-slot-assembly.js";
import { assembleBatchRuntime, runBatchHost } from "./batch-runtime-assembly.js";
import type { WorkerReplica } from "../kernel/execution/worker-replica.js";
import type { WorkerControlMessage, WorkerSlot } from "./worker-slot-runtime.js";
import { N28_FEASIBILITY_BUDGET, type CognitiveBudget, type WorkerReplicaRef } from "../contracts/index.js";
import { assertMemoryDirectoryResponsibilityCapacity, buildMemoryDirectorySnapshot, createExecutionGrantService, createHmacGrantKeyProvider, createKnowledgeBroker, createLayeredKnowledgeRetriever, createVerifiedTaskReadScopeFactory, filterKnowledgeEntriesByQueryText, rankKnowledgeEntries, regionEntryIds, type DirectoryEntryInput, type KnowledgeMemoryEntry, type LayeredSearchWaveInput, type LayeredSearchWaveResult, type MemoryDirectorySnapshot, type VerifiedTaskReadScopeFactory } from "../execution/index.js";
import { KNOWLEDGE_CONTEXT_KINDS } from "../runner/index.js";
import { createAuthorizedStateReadPort, createAuthorizedTaskReadFactory, createCognitiveWorkingSetProvider, createScopedSkillPort, expandTaskReadGrantCapabilities, type AuthorizedTaskReadFactory } from "../runner/index.js";
import type { SkillStoreLike } from "@away_from/pth-memory";
import type { RoleDefinition } from "../kernel/execution/worker-cluster.js";

export interface RunBatchProcessDeps {
  databaseUrl: string;
  basePath: string;       // 工作区根（workspaces）
  artifactPath: string;   // 产物归档根（artifacts）
  intervalMs?: number;
  /** N28 T6：feasibility 依赖（正常 CLI 入口全部 undefined → off 模式）。 */
  memoryDirectory?: MemoryDirectorySnapshot;
  /** N28 复核修复 Layer2：Directory 完整性源（entries + catalog 域）——feasibility 必填。 */
  directoryEntries?: readonly DirectoryEntryInput[];
  knownDomainIds?: ReadonlySet<string>;
  authorizedTaskReadFactory?: AuthorizedTaskReadFactory;
  verifiedReadScopeFactory?: VerifiedTaskReadScopeFactory;
  resolveRoleBudget?: (loadPolicyRef: string) => Partial<CognitiveBudget> | undefined;
  workerSpecs?: readonly {
    role: RoleDefinition;
    requestedReplica?: WorkerReplicaRef;
  }[];
  replicaFactory?: (input: {
    role: RoleDefinition;
    batchId: string;
    index: number;
    requestedReplica?: WorkerReplicaRef;
  }) => WorkerReplica;
}

/**
 * 转录归档接线（Task 4 接入）——P1-6 改为组合：不再继承 TaskLoop，
 * 通过 archiveFn 注入完整转录归档（archiveTask = 转录入 pg + 产物 rename + 清理提示）。
 * 外部接口（runOnce/pause/resume/stop/isPaused/isStopped）与旧继承版一致。
 */
class BatchTaskLoop {
  private inner: TaskLoop;

  constructor(deps: TaskLoopDeps, archiveDeps: ArchiveDeps) {
    this.inner = new TaskLoop({
      ...deps,
      archiveFn: async (task: Task, ws: { dir: string; tenant: string }, result: unknown) => {
        await archiveTask(task, ws, result as InterpreterResult, archiveDeps);
      },
    });
  }

  runOnce(): Promise<boolean> { return this.inner.runOnce(); }
  pause(): void { this.inner.pause(); }
  resume(): void { this.inner.resume(); }
  stop(): void { this.inner.stop(); }
  get isPaused(): boolean { return this.inner.isPaused; }
  get isStopped(): boolean { return this.inner.isStopped; }
}

/** K2 Phase 2：从同一份生成数据构建 catalog 快照（与 assembly 同源同版本）。 */
function buildDisciplineCatalogSnapshot(): DisciplineCatalogSnapshot {
  const builder = new DisciplineCatalogBuilder();
  for (const def of DISCIPLINE_DEFINITIONS) builder.add(def);
  return builder.build();
}

/** K2 Phase 2：从同一份生成数据构建 catalog 快照 + resolver（与 assembly 同源同版本）。 */
function buildDisciplineResolver(): ReturnType<typeof createDisciplineResolver> {
  return createDisciplineResolver(buildDisciplineCatalogSnapshot());
}

/** F5：outbox payload → RefineInput 重建（payload 不存大 trace——traceEvents 已截断 60 条；
 *  snapshot 可省略——缺失回退空快照，refiner.refine 输入保持现有形状）。 */
function refineInputFromPayload(payload: unknown): RefineInput {
  const p = (payload ?? {}) as Record<string, unknown>;
  const taskFromPayload = p.task as RefineInput["task"] | undefined;
  const roleId = typeof p.roleId === "string" ? p.roleId : undefined;
  const taskId = taskFromPayload?.id ?? (typeof p.taskId === "string" ? p.taskId : "unknown");
  const domains = Array.isArray(p.domains) ? (p.domains as string[]) : undefined;
  const domainBinding = (p.domainBinding && typeof p.domainBinding === "object")
    ? (p.domainBinding as RefineInput["domainBinding"])
    : undefined;
  const outcome = (p.outcome && typeof p.outcome === "object")
    ? (p.outcome as RefineInput["outcome"])
    : undefined;
  const artifactRefs = Array.isArray(p.artifactRefs) ? (p.artifactRefs as string[]) : undefined;
  return {
    task: taskFromPayload ?? {
      id: taskId,
      title: typeof p.taskTitle === "string" ? p.taskTitle : "",
      tags: Array.isArray(p.tags) ? (p.tags as string[]) : [],
      claimed_by: roleId ?? null,
    },
    snapshot: (p.snapshot ?? { variables: [], functions: [], oversized: [] }) as RefineInput["snapshot"],
    scope: { tenantId: typeof p.tenantId === "string" ? p.tenantId : "default", space: "meta" },
    trace: Array.isArray(p.traceEvents) ? (p.traceEvents as unknown[]).slice(0, 60) as RefineInput["trace"] : undefined,
    role: roleId,
    ...(domains ? { domains } : {}),
    ...(domainBinding ? { domainBinding } : {}),
    ...(outcome ? { outcome } : {}),
    ...(artifactRefs ? { artifactRefs } : {}),
  };
}

/**
 * batch 子进程主函数（方案 C，裁决 15）：pth 主进程 fork 本文件。
 * 自驱动：轮询 taskStore → 全角色 worker 各跑 TaskLoop.runOnce。
 * IPC：收 shutdown → 立即退出；收 pause/resume → 暂停/恢复认领。
 * 不 resolve：子进程长驻（pg 连接池维持存活），主进程通过 IPC 终止。
 */
export async function runBatchProcess(deps: RunBatchProcessDeps): Promise<void> {
  // P3-4：runner Host 与 API Host 共用同一 bootstrap manifest（fork worker 前 fail-closed）
  {
    const { loadBootstrapConfig } = await import("./bootstrap-config.js");
    const { buildPthHost } = await import("./pth-host.js");
    await buildPthHost(loadBootstrapConfig().manifest);
  }
  // 内存优化：连接池收紧（7 角色 worker 并发 ≤7——max 8 够；默认 10 冗余）
  // PTH_PG_POOL_MAX 可覆盖（batch 数多时 PG 连接总量 = pool_max × batches 需核算）
  const pool = await createPgPool({ connectionString: deps.databaseUrl, max: pthConfig().num("PTH_PG_POOL_MAX") });
  await applySchema(pool);
  // 2026-08-13 审计 P2：路由策略在装配层注入（存储层纯化）
  // P0-4：createDataWorld 是 legacy assembly-only 装配点——batch 子进程与 assembly 同源。
  // K3：catalog 快照与 K2 resolver 同源（同一 builder 产物），供 KnowledgeContextProvider ancestors 展开。
  const catalog = buildDisciplineCatalogSnapshot();
  const dataWorld = createDataWorld(
    pool,
    { validate: checkTaskRouting, assign: routeTaskRole },
    createDisciplineResolver(catalog),
    { requireTenant: true },
  );
  let knowledgeContextProvider = createKnowledgeContextProvider({
    memory: dataWorld.memory,
    catalog,
    // K1a 同款可见性判定：pth-memory isVisible（spaceScope 沿空间树向下可见）。
    isVisible: (meta, space) => isVisible(meta, space),
  });
  // P1-6：batch 子进程启用 tasking dispatcher 路径（真实 lease claim/CAS commit）
  const taskRepository = createPgTaskRepository(pool);
  // W8 P1：任务投递服务（worker 工具面 tasks.delegate/await 的服务器端实现）
  const taskControl = new TaskControlService({ store: dataWorld.tasks, pool, queries: new PgTaskQueries(pool) });
  const workspaceMgr = new DefaultTaskWorkspaceManager({ basePath: deps.basePath, artifactPath: deps.artifactPath });
  // 产物根必须先存在：archive 用 rename 而非 mkdir——父目录缺失时 rename 抛 ENOENT
  await mkdir(deps.artifactPath, { recursive: true });

  // 日志（日志体系 T2/T3）：IPC 转发主进程统一打标；stdio 兜底
  const logger = createKernelLogger({
    ipcSend: (msg) => { try { process.send?.(msg); } catch { /* IPC 不可用 */ } },
  });
  const batchLogger = logger.child("batch", { pid: process.pid });

  // modelRouter：SDK ModelRuntime（自动加载 pi auth.json/models-store——deepseek 已配置）。
  // 真实 LLM 能力（转写/记忆任务依赖）；失败时不阻塞——v1 机械认领仍可用。
  let modelRouter: any;
  try {
    modelRouter = await createKernelModelRouter({
      provider: pthConfig().str("PTH_MODEL_PROVIDER"),
      model: pthConfig().str("PTH_MODEL"),
    });
  } catch (err) {
    batchLogger.warn("model router init failed (falling back to stub)", { err: String(err) });
    modelRouter = { resolve: () => ({ id: "none", api: "none" }), getRuntime: () => ({}) } as any;
  }

  // 兼容性扩展装载（fork 内注册角色——扩展角色任务可认领/worker-add）——toolstore 路径 env 注入
  {
    const extPath = pthConfig().str("PTH_TOOLSTORE_PATH");
    if (extPath) {
      try {
        const { createToolstore } = await import("../kernel/interpreter/toolstore.js");
        const { ExtRegistry } = await import("../kernel/extensions/ext-registry.js");
        const reg = new ExtRegistry({ toolstore: createToolstore(extPath), extContext: { log: () => {} }, roleRegistrar: registerWorkerRole });
        await reg.loadAll();
      } catch (e) {
        batchLogger?.warn?.(`[ext] fork 内扩展装载失败（放行）: ${(e as Error).message}`);
      }
    }
  }

  let paused = false;

  // N28 T2：认知责任模式（默认 off=legacy 逐字节兼容）；feasibility 由确定性装配/harness 显式开启。
  const mode = pthConfig().str("PTH_COGNITIVE_RESPONSIBILITY_MODE") === "feasibility" ? "feasibility" as const : "off" as const;
  const batchId = pthConfig().str("PTH_BATCH_ID") || `batch:${process.pid}`;

  // N28 T6 + 复核 Layer2：feasibility 模式 provider + 启动前责任容量硬闸（缺依赖=启动错误，绝不省略）。
  let authorizedTaskReadFactory = deps.authorizedTaskReadFactory;
  let verifiedReadScopeFactory = deps.verifiedReadScopeFactory;
  const cognitiveWorkingSetProvider = mode === "feasibility"
    ? (() => {
        if (!deps.memoryDirectory || !deps.directoryEntries || !deps.knownDomainIds) {
          throw new Error("feasibility mode requires memoryDirectory/directoryEntries/knownDomainIds");
        }
        assertMemoryDirectoryResponsibilityCapacity(deps.memoryDirectory, N28_FEASIBILITY_BUDGET.responsibility);
        // P0-2 修复：生产 batch 构造并注入同一 layeredRetriever + layeredSearchWave，
        // Broker 与 Context 共用同一 wave port/trace 语义；factory 未注入时用生产 grant service 自建。
        const directory = deps.memoryDirectory;
        const clock = () => new Date();
        const layeredRetriever = createLayeredKnowledgeRetriever<KnowledgeMemoryEntry>(directory, {
          knownDomainIds: deps.knownDomainIds,
          entries: deps.directoryEntries,
        }, { clock });
        const layeredSearchWave = async (input: LayeredSearchWaveInput): Promise<LayeredSearchWaveResult<KnowledgeMemoryEntry>> => {
          const regionSet = new Set(input.regionIds.flatMap((id) => regionEntryIds(directory, id)));
          const all = await dataWorld.memory.retrieve({
            anchors: [],
            kinds: [...KNOWLEDGE_CONTEXT_KINDS],
            status: ["official"],
            tenantId: input.authorization.tenantId,
          });
          const authorized = all.filter((e) => isVisible(e.meta, input.authorization.space));
          const inWave = input.candidateScope === "global" ? authorized : authorized.filter((e) => regionSet.has(e.id));
          const matching = filterKnowledgeEntriesByQueryText(inWave, input.queryText, { strict: true });
          const ranked = rankKnowledgeEntries(matching, { queryText: input.queryText, domains: [] });
          return {
            entries: ranked.slice(0, input.limit),
            candidateCount: inWave.length,
            visibleCount: inWave.length,
            scannedCount: all.length,
            completeForQuery: true,
          };
        };
        knowledgeContextProvider = createKnowledgeContextProvider({
          memory: dataWorld.memory,
          catalog,
          isVisible: (meta, space) => isVisible(meta, space),
          layeredRetriever,
          layeredSearchWave,
          clock,
        });
        const grantService = createExecutionGrantService({
          keyProvider: createHmacGrantKeyProvider({ secret: pthConfig().str("PTH_EXECUTION_GRANT_SECRET") }),
          clock,
        });
        verifiedReadScopeFactory ??= createVerifiedTaskReadScopeFactory({
          grantService,
          grantForTask: ({ lease, work, space, worker }) => {
            const roleDef = knownRoleById(worker.role.roleId);
            return grantService.issue({
              lease,
              scope: { ...work.scope, principalId: `worker:${worker.workerId}`, roles: [worker.role.roleId], space },
              workspace: lease.workspace,
              language: "ts",
              capabilities: expandTaskReadGrantCapabilities(roleDef?.capabilities ?? []),
              ttlMs: 120_000,
            });
          },
        });
        authorizedTaskReadFactory ??= createAuthorizedTaskReadFactory({
          broker: createKnowledgeBroker({
            grantService,
            dataWorld: { queryReadOnly: dataWorld.queryReadOnly, memory: dataWorld.memory },
            isVisible: (meta, space) => isVisible(meta, space),
            layeredRetriever,
            layeredSearchWave,
            verifiedReadScopeAuthority: verifiedReadScopeFactory,
            clock,
          }),
          skills: createScopedSkillPort({ store: dataWorld.memory as unknown as SkillStoreLike, isVisible: (meta, space) => isVisible(meta, space), clock }),
          state: createAuthorizedStateReadPort({ memory: dataWorld.memory, isVisible: (meta, space) => isVisible(meta, space), clock }),
          clock,
        });
        return createCognitiveWorkingSetProvider({ budget: N28_FEASIBILITY_BUDGET, resolveRoleBudget: deps.resolveRoleBudget });
      })()
    : undefined;

  /** 退出前释放全部 worker kernel（sandbox acquire 归还——防池泄漏）——幂等 */
  let disposed = false;
  async function disposeAllKernels(): Promise<void> {
    if (disposed) return;
    disposed = true;
    if (mode === "feasibility") {
      // 共享 runtime 拥有唯一 slot/dispose 生命周期（包括 busy-remove 后置清理）。
      await runtime.disposeAll();
      return;
    }
    for (const l of loops) {
      const k = (l as unknown as { kernel?: { dispose?: () => Promise<void> | void; abort?: () => Promise<void> } }).kernel;
      // Phase 3 条目 11：先 abort in-flight 程序（程序级制动）再 dispose 资源——DSH 对照 ③
      try { await k?.abort?.(); } catch { /* abort 容错 */ }
      try { await k?.dispose?.(); } catch { /* dispose 容错 */ }
    }
  }
  // 进程级兜底（2026-08-09 端到端：refine snapshot abort 未 catch 处杀 batch → watchdog 30s 循环）。
  // 异步异常记日志不崩——sandbox 瞬时故障不应终止 batch（降级容忍——后续调用自动恢复）。
  process.on("unhandledRejection", (reason) => {
    batchLogger?.error(`[batch] unhandledRejection（容忍——不终止）: ${reason instanceof Error ? reason.message : String(reason)}`);
  });
  process.on("uncaughtException", (err) => {
    batchLogger?.error(`[batch] uncaughtException（容忍——不终止）: ${err.message}`);
  });

  // 优雅退出：SIGTERM/SIGINT/disconnect/exit-message 统一先释放 kernel 再 exit（防 sandbox 池泄漏）
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => { void disposeAllKernels().finally(() => process.exit(0)); });
  }
  const exitNow = (code: number) => () => process.exit(code);
  process.on("exit", (code) => { if (!disposed) void disposeAllKernels().finally(() => exitNow(code)); });

  process.on("message", async (msg: any) => {
    if (msg?.type === "set-param" && typeof msg.key === "string") {
      // 性能自持（v0.8）：主进程 autopilot 下发调参 → batch 进程内 config（perf 扩展同源）
      try {
        const { config } = require("../kernel/extensions/perf-params.js") as typeof import("../kernel/extensions/perf-params.js");
        config().set(msg.key, msg.value);
        batchLogger?.info?.(`[autopilot] set-param ${msg.key}=${msg.value}`);
        process.send?.({ type: "param-status", batchPid: process.pid, key: msg.key, ok: true });
      } catch (e) {
        process.send?.({ type: "param-status", batchPid: process.pid, key: msg.key, ok: false, error: (e as Error).message });
      }
    } else if (msg?.type === "shutdown") {
      void disposeAllKernels().finally(() => process.exit(0));
    } else if (msg?.type === "pause") {
      paused = true;
    } else if (msg?.type === "resume") {
      paused = false;
    } else if (msg?.type === "worker-pause" && typeof msg.role === "string") {
      if (mode === "feasibility") {
        // 显式命名的 role 批量兼容操作：展开为逐 worker 控制，状态/事件仍由共享 runtime 产出。
        for (const status of runtime.list().filter((s) => s.role.roleId === msg.role)) {
          void runtime.handleControl({ type: "worker-pause", workerId: status.workerId });
        }
        process.send?.({ type: "worker-status", batchPid: process.pid, role: msg.role, state: "paused" });
      } else {
        getEventBus().emit("worker.pause", { role: msg.role, batchPid: process.pid });
        for (const l of loops) if (l.role.id === msg.role) l.pause();
        process.send?.({ type: "worker-status", batchPid: process.pid, role: msg.role, state: "paused" });
      }
    } else if (msg?.type === "worker-resume" && typeof msg.role === "string") {
      if (mode === "feasibility") {
        for (const status of runtime.list().filter((s) => s.role.roleId === msg.role)) {
          void runtime.handleControl({ type: "worker-resume", workerId: status.workerId });
        }
        process.send?.({ type: "worker-status", batchPid: process.pid, role: msg.role, state: "active" });
      } else {
        getEventBus().emit("worker.resume", { role: msg.role, batchPid: process.pid });
        for (const l of loops) if (l.role.id === msg.role) l.resume();
        process.send?.({ type: "worker-status", batchPid: process.pid, role: msg.role, state: "active" });
      }
    } else if (msg?.type === "worker-remove" && typeof msg.role === "string") {
      if (mode === "feasibility") {
        for (const status of runtime.list().filter((s) => s.role.roleId === msg.role)) {
          void runtime.handleControl({ type: "worker-remove", workerId: status.workerId });
        }
      } else {
        getEventBus().emit("worker.remove", { role: msg.role, batchPid: process.pid });

        // 防御：tick 自驱动链与 splice 并发——map 回调可能拿到已移除的 undefined（竞态窗口）
        const idxs = loops.map((l, i) => (l && l.role?.id === msg.role ? i : -1)).filter((i) => i >= 0);
        for (const i of idxs.reverse()) {
          const l = loops[i]!;
          l.stop();
          // Phase 3 条目 11：先 abort in-flight（角色移除时跑飞的程序立即制动）再 dispose 资源
          const k = (l as unknown as { kernel?: { dispose?: () => void; abort?: () => Promise<void> } }).kernel;
          try { void k?.abort?.(); } catch { /* abort 容错 */ }
          try { k?.dispose?.(); } catch { /* dispose 容错 */ }
          // 停复测巡检表（2026-08-14 N6——Optimizer.stop）
          const opt = (l as unknown as { optimizer?: { stop?: () => void } }).optimizer;
          try { opt?.stop?.(); } catch { /* 停表容错 */ }
          loops.splice(i, 1);
        }
        process.send?.({ type: "worker-status", batchPid: process.pid, role: msg.role, state: "removed" });
      }
    } else if (msg?.type === "worker-pause" && typeof msg.workerId === "string" && mode === "feasibility") {
      const ack = await runtime.handleControl({ type: "worker-pause", workerId: msg.workerId });
      process.send?.({ type: "worker-status", ...ack });
    } else if (msg?.type === "worker-resume" && typeof msg.workerId === "string" && mode === "feasibility") {
      const ack = await runtime.handleControl({ type: "worker-resume", workerId: msg.workerId });
      process.send?.({ type: "worker-status", ...ack });
    } else if (msg?.type === "worker-remove" && typeof msg.workerId === "string" && mode === "feasibility") {
      const ack = await runtime.handleControl({ type: "worker-remove", workerId: msg.workerId });
      process.send?.({ type: "worker-status", ...ack });
    } else if (msg?.type === "role-register" && msg.role && typeof msg.role === "object") {
      // 分化上线（lineage approve）：batch 内注册新角色 + 创建 worker（树生长——即刻接任务）。
      // 2026-08-13 幂等修复：fork 子进程继承主进程 extraRoles——恢复角色热上线时已在——
      // 直接 createWorker（旧逻辑 registerWorkerRole 抛"已存在"被 catch 吞——worker 不创建）
      try {
        const roleId = (msg.role as { id: string }).id;
        if (!allWorkerRoles().some((r) => r.id === roleId)) {
          registerWorkerRole(msg.role as never);
        }
        const roleDef = knownRoleById(roleId);
        if (roleDef) {
          const w = createWorker(roleDef);
          if (mode === "feasibility") runtime.add(makeSlot(w));
          process.send?.({ type: "worker-status", batchPid: process.pid, role: roleDef.id, state: "added", copies: 1, registered: true });
        }
      } catch (e) {
        process.send?.({ type: "worker-status", batchPid: process.pid, role: (msg.role as { id?: string })?.id ?? "?", state: "error", error: (e as Error).message });
      }
    } else if (msg?.type === "worker-add" && typeof msg.role === "string") {
      getEventBus().emit("worker.add", { role: msg.role, copies: msg.copies ?? 1, batchPid: process.pid });
      const roleDef = knownRoleById(msg.role);
      if (roleDef) {
        const copies = Number(msg.copies ?? 1);
        for (let i = 0; i < copies; i++) {
          const w = createWorker(roleDef);
          if (mode === "feasibility") runtime.add(makeSlot(w));
        }
        process.send?.({ type: "worker-status", batchPid: process.pid, role: msg.role, state: "added", copies });
      } else {
        process.send?.({ type: "worker-status", batchPid: process.pid, role: msg.role, state: "error", error: "unknown role" });
      }
    } else if (msg?.type === "optimizer-sweep") {
      // trigger 统一化：主进程 optimizer.deopt-sweep 下行——每 batch 只跑一次（checkDeopt 读共享 memory，无实例态）
      const opt = loops
        .map((l) => (l as unknown as { optimizer?: { sweep?: () => Promise<void> } }).optimizer)
        .find((o) => Boolean(o?.sweep));
      void opt?.sweep?.().catch((e: Error) => {
        batchLogger?.warn?.(`[optimizer-sweep] 巡检失败: ${e.message}`);
      });
      process.send?.({ type: "optimizer-sweep-status", batchPid: process.pid, ran: Boolean(opt) });
    }
  });
  // 父进程退出（IPC 通道关闭）→ 自杀：不留孤儿 batch 继续轮询 DB（先释放 kernel）
  process.on("disconnect", () => { void disposeAllKernels().finally(() => process.exit(0)); });

  // trigger 统一化（事件桥上行）：子进程 EventBus → 主进程 ActivityHub（kernel-event IPC）。
  // 白名单去重：task.claim/task.done/task.failed 已走既有 activity 通道，不重复转发（防 trigger 双触发）。
  getEventBus().on("*", (evt) => {
    if (!isForwardableKernelEvent(evt.type)) return;
    try {
      process.send?.({ kind: "kernel-event", event: toKernelActivityEvent(evt, process.pid) });
    } catch { /* IPC 不可用——静默（活动流非关键路径） */ }
  });

  const archiveDeps: ArchiveDeps = {
    transcriptStore: dataWorld.transcripts,
    workspaceMgr,
    emitCleanup: (info) => process.send?.({ type: "cleanup", taskId: info.taskId, artifactPath: info.artifactPath }),
  };

  // F5（6.1）：durable side-effect outbox + drainer。refine observer 只 enqueue 到 outbox；
  // drainer 轮询消费（unref timer + task-loop claim 前 kick）。refineRefiners 在 createWorker
  // 里按 roleId 注册各 worker 的 refiner，handler 按 payload.roleId 选取。
  const sideEffectOutbox = new PgSideEffectOutbox(pool);
  const refineRefiners = new Map<string, Pick<Refiner, "refine">>();
  const sideEffectDrainer = createSideEffectDrainer({
    outbox: sideEffectOutbox,
    handlers: {
      async refine(payload) {
        const p = (payload ?? {}) as Record<string, unknown>;
        const roleId = typeof p.roleId === "string" ? p.roleId : "";
        const refiner = refineRefiners.get(roleId) ?? refineRefiners.values().next().value;
        if (!refiner) throw new Error("refiner not available for outbox refine");
        await refiner.refine(refineInputFromPayload(p));
      },
    },
    logger: (m) => batchLogger.warn(m),
    tickMs: pthConfig().num("PTH_OUTBOX_TICK_MS") || 2000,
  });
  sideEffectDrainer.start();
  const kickSideEffectDrainer = (): void => {
    void sideEffectDrainer.drainOnce().catch((e) => {
      batchLogger.warn(`side-effect drain kick failed: ${e instanceof Error ? e.message : String(e)}`);
    });
  };

  const intervalMs = deps.intervalMs ?? pthConfig().num("PTH_BATCH_TICK_MS");
  // 多语言持久 REPL（T1-T3）：KernelManager 路由——python/bash 用持久 kernel
  // （实测 230x vs spawn）；sandbox 生产模式可用 env 切换（PTH_PYTHON_MODE/PTH_BASH_MODE）
  // toolstore 文件通道（§0.5）：PTH_TOOLSTORE_PATH 或默认 toolstore/（相对工作目录）
  const toolstoreDir = pthConfig().str("PTH_TOOLSTORE_PATH") || "toolstore";
  await mkdir(toolstoreDir, { recursive: true }).catch(() => {});
  const toolstore = createToolstore(toolstoreDir);
  // batch 构成参数化（PTH_WORKER_ROLES）：任意角色子集 + 副本数（0 禁用）；
  // 不设置 → 默认 7 角色 ×1（原行为）。启动时解析一次——运行时改权重需 batch remove+add。
  const workerRoles = expandRoleWeights(parseRoleWeights(pthConfig().str("PTH_WORKER_ROLES")));
  // worker 注册表（worker 级控制面：pause/resume/remove/add——IPC 指令寻址）
  const loops: Array<BatchTaskLoop & { role: import("../kernel/execution/worker-cluster.js").WorkerRole }> = [];

  // N15 B2：穿透执行预算账本（key = req.caller.taskId，单 batch 进程生命周期；
  // 任务不跨 batch 进程迁移——与现有「穿透共享父任务工作区」假设一致）。
  // 预算配置与 PTH_AGENT_MAX_STEPS 同语义：batch 进程配置中心快照，不逐调用热读。
  const penetrationLedgers = new Map<string, PenetrationLedger>();
  const penetrationBudgetCfg: PenetrationBudgetConfig = {
    maxSteps: pthConfig().num("PTH_PENETRATION_MAX_STEPS"),
    taskBudgetSteps: pthConfig().num("PTH_PENETRATION_TASK_BUDGET_STEPS"),
    timeoutMs: pthConfig().num("PTH_PENETRATION_TIMEOUT_MS"),
  };

  /** 创建并注册一个角色 worker（P3 动态 add 复用；remove 后 dispose kernel 回收 python 进程） */
  const createWorker = (role: import("../kernel/execution/worker-cluster.js").WorkerRole, forcedReplica?: WorkerReplica) => {
    // N28 T2：身份装配（off=legacy 双 principal；feasibility=worker:<uuid> 双面统一）。
    // feasibility 下经 assembleBatchRuntime 组合时传入其校验过的 replica；动态 add 用 helper 新建。
    const identity = assembleWorkerSlotIdentity({ mode, role, batchId });
    const replica = mode === "feasibility" ? (forcedReplica ?? identity.replica) : undefined;
    const sandboxPrincipalId = replica ? `worker:${replica.ref.workerId}` : identity.sandboxPrincipalId;
    // W8 P1：组织权矩阵派生能力授予——有投递权的角色追加 tasks capability（缺省全量角色不受影响）
    const canDelegate = allowedDelegationTargets(role.id).length > 0;
    const effectiveRole = role.capabilities
      ? { ...role, capabilities: [...new Set([...role.capabilities, ...(canDelegate ? ["tasks"] : [])])] }
      : role;
    // W8 P1：任务身份引用（task-loop 每任务盖章；delegate/await 调用者上下文）
    const taskContext: { current: import("../contracts/index.js").TaskDispatchContext | null } = { current: null };
    // 0.16.3 穿透执行面（2026-08-18 用户裁决：显式原语 tasks.penetrate / 深度限 1 /
    // 失败报错由父决策 / 本批只做执行面）。runChild = 嵌套子 agent 执行缝：
    // 建子 kernel（子角色能力面，无 taskControl/penetration——深度限 1）→ 嵌套
    // runAgentTask（共享父任务工作区）→ dispose。校验编排在 tasking/penetration-runner。
    // N14 P2：runChild 提取为独立闭包——穿透 runner 与 tool-reg agent 态执行缝共用同一实现
    // （toolRegRunChild 进 TaskLoop deps；agent 态工具的授权 = tool-reg 条目治理审批本身）。
    const parentKernelRef: { current?: { ts: unknown } } = {};
    const runChildImpl: import("../tasking/index.js").PenetrationRunChild = async (req) => {
            const started = Date.now();
            // N15 B2：每次穿透调用前先过预算闸——累计耗尽立即失败（父可回退 tasks.delegate）
            const ledgerKey = req.caller?.taskId ?? "unknown-task";
            const ledger = penetrationLedgers.get(ledgerKey) ?? { calls: 0, steps: 0 };
            const budgetResult = childBudgetFor(ledger, penetrationBudgetCfg);
            if (!budgetResult.ok) {
              return {
                ok: false,
                steps: ledger.steps,
                error: `${budgetResult.error}（父任务 ${ledgerKey}）`,
                durationMs: 0,
              };
            }
            const budget = budgetResult.budget!;
            const childRole = knownRoleById(req.childRoleId);
            if (!childRole) {
              return { ok: false, steps: 0, error: `穿透目标角色未注册: ${req.childRoleId}`, durationMs: 0 };
            }
            const childManager = createKernelManager({
              pythonMode: pthConfig().str("PTH_PYTHON_MODE") as any,
              bashMode: pthConfig().str("PTH_BASH_MODE") as any,
              sandboxKernel: {
                url: pthConfig().str("PTH_SANDBOX_KERNEL_URL"),
                secret: pthConfig().str("SANDBOX_SHARED_SECRET"),
                grantSecret: pthConfig().str("PTH_EXECUTION_GRANT_SECRET"),
                grantIdentity: {
                  principalId: `worker:${childRole.id}`,
                  roleId: childRole.id,
                  capabilities: childRole.capabilities ?? [],
                },
              },
              kernelConfig: loadKernelConfig(process.env),
              onKernelStderr: (language, line) => batchLogger.child(language === "python" ? "pykernel" : "bashkernel")?.warn(line.trim()),
              onKernelMetric: (metric) => {
                try { process.send?.({ kind: "metric", metric: { ...metric, domain: "penetration" } }); } catch { /* IPC 不可用 */ }
              },
            });
            const childLlm = createLlmFn({
              modelRouter,
              onMetric: (m) => {
                try { process.send?.({ kind: "metric", metric: { ...m, kind: "llm", domain: "penetration" } }); } catch { /* IPC 不可用 */ }
              },
            });
            const childKernel = createWorkerKernelWithManager({
              llm: childLlm, dataWorld, manager: childManager, toolstore,
              roleFilter: childRole.capabilities,
              memoryScope: childRole.memoryScope ? { role: childRole.id, scope: childRole.memoryScope } : undefined,
              roleId: childRole.id,
              // 深度限 1：不传 taskControl/penetration——嵌套子 agent 纯执行，不再派发/穿透
              registerKernel: (language, interpreter) => childManager.registerKernel(language, interpreter as never),
              readSource: pthConfig().str("PTH_SOURCE_ROOT")
                ? (relPath) => import("../kernel/interpreter/read-source.js").then((m) => m.createReadSource(pthConfig().str("PTH_SOURCE_ROOT"))(relPath))
                : undefined,
              taskWorkspaceResolve: (relPath) => {
                const cwd = (childKernel.ts as unknown as { currentCwd?: string | null }).currentCwd;
                if (!cwd || !cwd.includes("/tasks/")) throw new Error("fs.task: 任务工作区未就绪（非任务上下文）");
                if (typeof relPath !== "string" || relPath.trim() === "" || relPath.includes("\0")) {
                  throw new Error(`fs.task: 仅允许相对路径（拒绝: ${String(relPath).slice(0, 60)}）`);
                }
                const base = resolvePath(cwd);
                const abs = resolvePath(base, relPath);
                const rel = relativePath(base, abs);
                if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
                  throw new Error(`fs.task: 路径越出任务工作区（拒绝: ${relPath.slice(0, 60)}）`);
                }
                return abs;
              },
            });
            try {
              // 共享父任务工作区（父 kernel ts.currentCwd——穿透调用发生在父任务程序内）
              const parentCwd = (parentKernelRef.current?.ts as { currentCwd?: string | null } | undefined)?.currentCwd;
              const r = await runAgentTask({
                llm: childLlm, kernel: childKernel, caps: childKernel.capabilities,
                task: { title: req.title, text: req.text },
                taskWorkspace: parentCwd ?? undefined,
                toolstore,
                role: childRole,
                // N15 B2：单次穿透预算（步数取 min(单次上限, 剩余累计额度)；超时取预算超时）
                maxSteps: budget.maxSteps,
                timeoutMs: budget.timeoutMs,
                asp: pthConfig().str("PTH_ASP_MODE") === "on",
                onTrace: (e) => {
                  if (e.type === "finish") {
                    try {
                      process.send?.({
                        kind: "activity",
                        activity: {
                          kind: "task.penetrate", taskId: req.caller.taskId, role: req.caller.roleId,
                          ok: e.ok, step: e.steps,
                          // N15 B2：软限命中标记（累计耗尽走预算闸失败路径，不进这里）
                          budgetUsed: e.steps,
                          budgetExceeded: e.steps >= budget.maxSteps,
                          detail: `穿透 ${req.caller.roleId}→${req.childRoleId}（${req.skillId}）${e.ok ? "完成" : `失败: ${(e.error ?? "").slice(0, 80)}`}`,
                          batchPid: process.pid, at: Date.now(),
                        },
                      });
                    } catch { /* IPC 不可用 */ }
                  }
                },
              });
              const durationMs = Date.now() - started;
              // N15 B2：无论成败都按实际 steps 结算（防重试放大）；单次命中 maxSteps 不额外扣满
              penetrationLedgers.set(ledgerKey, recordPenetrationUse(ledger, r.steps));
              const budgetExceeded = r.steps >= budget.maxSteps;
              // 调用级成败（r.ok 是 agent-loop 层；done.result 缺失时父任务仍收失败——
              // 边级 okCalls 与父任务最终语义一致，防 B1 成功率口径虚高）
              const childOk = r.ok && r.value !== undefined && r.value !== null;
              // N15 B2：边级计量聚合（B1 地基）——成功/失败都计；incrementAggregate 缺失时 skip 不报错
              try {
                await dataWorld.memory.incrementAggregate?.(
                  `penetration-edge:${req.caller.roleId}->${req.childRoleId}`,
                  "penetration-edge",
                  [req.caller.roleId, req.childRoleId, "penetration-edge"],
                  {
                    calls: 1,
                    okCalls: childOk ? 1 : 0,
                    sumSteps: r.steps,
                    sumDurationMs: durationMs,
                    sumBudgetExceeded: budgetExceeded ? 1 : 0,
                  },
                  { parent: req.caller.roleId, child: req.childRoleId, ts: Date.now() },
                  { tenantId: req.caller.tenantId ?? DEFAULT_TENANT_ID },
                );
              } catch {
                /* 计量聚合容错（降级：预算照常结算，聚合行缺失不阻断穿透） */
              }
              if (!r.ok) return { ok: false, steps: r.steps, error: r.error ?? "子 agent 执行失败", durationMs };
              if (r.value === undefined || r.value === null) {
                return { ok: false, steps: r.steps, error: r.warning ? `soft-terminated: ${r.warning}` : "子 agent 未产出结果（done 未带 result）", durationMs };
              }
              return { ok: true, value: r.value, summary: r.summary, steps: r.steps, durationMs };
            } finally {
              childKernel.dispose();
            }
    };
    const penetration = canDelegate
      ? createPenetrationRunner({
          memory: dataWorld.memory,
          runChild: runChildImpl,
        })
      : undefined;
    const manager = createKernelManager({
      pythonMode: pthConfig().str("PTH_PYTHON_MODE") as any,
      bashMode: pthConfig().str("PTH_BASH_MODE") as any,
      // kernel sandbox 接线：sandbox-kernel 模式连宿主（url/secret 与 bash 转发同源）
      sandboxKernel: {
        url: pthConfig().str("PTH_SANDBOX_KERNEL_URL"),
        secret: pthConfig().str("SANDBOX_SHARED_SECRET"),
        // P2-2 接线（Side B 补）：由 kernel-manager 按 language 签发 worker 级 grant。
        grantSecret: pthConfig().str("PTH_EXECUTION_GRANT_SECRET"),
        grantIdentity: {
          principalId: sandboxPrincipalId,
          roleId: role.id,
          capabilities: role.capabilities ?? [],
        },
      },
      // kernel 参数化（PTH_KERNEL_* env）：懒 spawn / 空闲回收 / reset 模式
      kernelConfig: loadKernelConfig(process.env),
      // 日志体系 T4：kernel stderr 转发 warn（component=pykernel/bashkernel）
      onKernelStderr: (language, line) => batchLogger.child(language === "python" ? "pykernel" : "bashkernel")?.warn(line.trim()),
      // 性能计量（SPEC L1）：kernel 执行事件 → IPC 转发主进程
      onKernelMetric: (metric) => {
        try { process.send?.({ kind: "metric", metric }); } catch { /* IPC 不可用 */ }
      },
    });
    const llm = createLlmFn({
      modelRouter,
      // 性能计量（SPEC L0-④）：llm 事件 → IPC 转发主进程
      onMetric: (m) => {
        try { process.send?.({ kind: "metric", metric: { ...m, kind: "llm" } }); } catch { /* IPC 不可用 */ }
      },
    });
    // 权限分层（P3——注入面收窄）：角色声明的 capabilities/memoryScope 传给能力构建
    const kernel = createWorkerKernelWithManager({
      llm, dataWorld, manager, toolstore,
      roleFilter: effectiveRole.capabilities,
      memoryScope: role.memoryScope ? { role: role.id, scope: role.memoryScope } : undefined,
      roleId: role.id,
      taskControl: canDelegate ? taskControl : undefined,
      penetration,
      // L2：能力面活动事件上报（skill.proposal.created——与 loop 同一 IPC 转发通道）
      onActivity: (e) => { try { process.send?.({ kind: "activity", activity: { ...e, batchPid: process.pid } }); } catch { /* IPC 不可用 */ } },
      taskContext,
      registerKernel: (language, interpreter) => manager.registerKernel(language, interpreter as never),
      readSource: pthConfig().str("PTH_SOURCE_ROOT")
        ? (relPath) => import("../kernel/interpreter/read-source.js").then((m) => m.createReadSource(pthConfig().str("PTH_SOURCE_ROOT"))(relPath))
        : undefined,
      // 任务工作区（fs.task——白名单：仅 tasks/<taskId>/——kernel.ts.currentCwd 动态定位 + 防穿越）
      // 2026-08-15 筛查 H4：词法归一化 + 包含校验——`sub/../../etc/passwd` 不再逃逸工作区
      taskWorkspaceResolve: (relPath) => {
        const cwd = (kernel.ts as unknown as { currentCwd?: string | null }).currentCwd;
        if (!cwd || !cwd.includes("/tasks/")) throw new Error("fs.task: 任务工作区未就绪（非任务上下文）");
        if (typeof relPath !== "string" || relPath.trim() === "" || relPath.includes("\0")) {
          throw new Error(`fs.task: 仅允许相对路径（拒绝: ${String(relPath).slice(0, 60)}）`);
        }
        const base = resolvePath(cwd);
        const abs = resolvePath(base, relPath);
        const rel = relativePath(base, abs);
        if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
          throw new Error(`fs.task: 路径越出任务工作区（拒绝: ${relPath.slice(0, 60)}）`);
        }
        return abs;
      },
    });
    parentKernelRef.current = kernel;   // 穿透 runChild 共享父任务工作区（ts.currentCwd）
    // Refine 钩子（T4，裁决 P6：默认 auto——任务完成后自动提炼；PTH_REFINE=off 关闭）
    const refineEnabled = pthConfig().str("PTH_REFINE") !== "off";
    const refiner = refineEnabled ? new Refiner({
      llm: createLlmFn({
        modelRouter,
        onMetric: (m) => { try { process.send?.({ kind: "metric", metric: { ...m, kind: "llm" } }); } catch { /* IPC 不可用 */ } },
      }),
      memory: dataWorld.memory,
      onMetric: (m) => { try { process.send?.({ kind: "metric", metric: { ...m, domain: "refine" } }); } catch { /* IPC 不可用 */ } },
    }) : undefined;
    // F5：drainer handler 按 payload.roleId 选 refiner（同角色多副本时最后一个注册生效）。
    if (refiner) refineRefiners.set(role.id, refiner);
    // 优化循环（2026-08-12 大项 §10.3）：窗口聚合检测 → 建议 draft（PTH_OPTIMIZER=off 关闭）
    const optimizerEnabled = pthConfig().str("PTH_OPTIMIZER") !== "off";
    // 2026-08-14 T4 分层闸门：PTH_APPLY_POLICY=auto-reversible 时可逆微调建议自动 apply（deopt 兜底）；
    // 缺省 manual——全部走人工 API 通道（routes-kernel /optimizer/apply）。
    const autoApply = pthConfig().str("PTH_APPLY_POLICY") === "auto-reversible";
    const optimizer = optimizerEnabled ? new Optimizer({
      memory: dataWorld.memory,
      windowSize: pthConfig().num("PTH_OPTIMIZER_WINDOW"),
      autoApplyReversible: autoApply,
      applySuggestion: autoApply
        ? async (id) => {
            const { applyOptimizerSuggestion } = await import("../kernel/execution/optimizer-apply.js");
            // 复测任务派发（2026-08-14 N6 一等化）：flow 路由到目标角色——受控复现
            return applyOptimizerSuggestion(dataWorld.memory, id, dataWorld.queryReadOnly, (t) =>
              dataWorld.tasks.publish({ title: t.title, text: t.text, createdBy: "optimizer", tags: t.tags, payload: t.payload }));
          }
        : undefined,
      // 复测一等化参数（N6——PTH_VERIFY_* 配置中心可调）
      verifyTasksCount: pthConfig().num("PTH_VERIFY_TASKS"),
      verifyTimeoutMs: pthConfig().num("PTH_VERIFY_TIMEOUT_MS"),
      // trigger 统一化（2026-08-16）：子进程不再自巡检——主进程 optimizer.deopt-sweep trigger 经 IPC 下行驱动
      verifySweepMs: 0,
    }) : undefined;
    const loop = new BatchTaskLoop({
      kernel, role: effectiveRole, taskStore: dataWorld.tasks, workspaceMgr, refiner, optimizer, logger: batchLogger,
      repository: taskRepository,
      // N28 T2/T6：feasibility 依赖透传（off 全部 undefined）。
      replica,
      memoryDirectory: deps.memoryDirectory,
      cognitiveWorkingSetProvider,
      authorizedReads: authorizedTaskReadFactory,
      verifiedReadScopeFactory,
      cognitiveResponsibilityMode: mode,
      // F5：post-commit refine 走 durable outbox；每轮 claim 前 kick 一次 drain。
      sideEffectOutbox,
      drainSideEffects: kickSideEffectDrainer,
      // K3：任务知识上下文 provider（memory + catalog + isVisible 同源装配）。
      knowledgeContextProvider,
      // N14 P2：tool-reg 注册面——任务开始冻结快照 + agent 态执行缝（穿透 runChild 同一闭包）
      toolRegStore: dataWorld.memory,
      toolRegRunChild: runChildImpl,
      // 自然语言任务转译（NL→代码）：复用角色自身的 llm（与 refine 同源）
      llm,
      // agent 循环的 capability 白名单（与 vm 注入同一份）
      agentCaps: kernel.capabilities,
      // 性能计量（SPEC L2）：任务事件 → IPC 转发主进程
      onTaskMetric: (m) => { try { process.send?.({ kind: "metric", metric: { ...m, domain: "task" } }); } catch { /* IPC 不可用 */ } },
      // 活动事件流（console --follow 数据源——batch→主进程 IPC）
      onActivity: (e) => { try { process.send?.({ kind: "activity", activity: { ...e, batchPid: process.pid, at: Date.now() } }); } catch { /* IPC 不可用 */ } },
      // 运行过程保留（2026-08-09）：agent 轨迹 transcript 持久化
      transcripts: dataWorld.transcripts,
    }, archiveDeps);
    if (mode !== "feasibility") {
      (loop as unknown as { kernel?: unknown }).kernel = kernel;   // remove 时 dispose 用
      (loop as unknown as { optimizer?: { stop?: () => void } }).optimizer = optimizer;   // remove 时停复测巡检表
      (loop as unknown as { role?: import("../kernel/execution/worker-cluster.js").WorkerRole }).role = role;  // remove 寻址用
      loops.push(loop as BatchTaskLoop & { role: import("../kernel/execution/worker-cluster.js").WorkerRole });
    }
    return { loop, kernel, optimizer, replica, role: effectiveRole };
  };

  // N28 T2：feasibility 模式唯一 slot 运行时（off 模式完全不实例化新控制面）。
  const makeSlot = (w: ReturnType<typeof createWorker>): WorkerSlot => {
    if (!w.replica) throw new Error("feasibility slot requires replica");
    return {
      replica: w.replica,
      role: w.role,
      loop: {
        runOnce: () => w.loop.runOnce(),
        pause: () => w.loop.pause(),
        resume: () => w.loop.resume(),
        stop: () => w.loop.stop(),
      },
      dispose: async () => {
        try { w.optimizer?.stop?.(); } catch { /* 停表容错 */ }
        try { await w.kernel.abort?.(); } catch { /* abort 容错 */ }
        try { await w.kernel.dispose?.(); } catch { /* dispose 容错 */ }
      },
    };
  };

  const runtime = assembleBatchRuntime({
    mode,
    batchId,
    workerSpecs: workerRoles.map((role) => ({ role })),
    buildSlot: ({ role, replica }) => makeSlot(createWorker(role, replica)),
    emit: (event) => { try { process.send?.(event); } catch { /* IPC 不可用 */ } },
  });

  if (mode !== "feasibility") {
    workerRoles.forEach((role) => createWorker(role));
  }

  // 每轮：各 worker runOnce（并发）；didWork=true（有任务执行完）→ 立即自驱动下一轮
  // （吞吐优化：串行任务零轮询等待——0.58s/任务 的轮询延迟消除）；
  // 空闲（无候选）退避回 intervalMs timer，避免空转查询 PG。
  const tick = async (): Promise<void> => {
    if (paused) return;
    // 快照遍历（worker-remove 的 splice 并发安全——过滤已移除项）
    const snapshot = loops.filter((l): l is typeof l => Boolean(l));
    const did = await Promise.all(snapshot.map((l) => l.runOnce()));
    if (did.some(Boolean)) void tick();   // 忙时自驱动（串行链——防风暴）
    else return;                          // 空闲：等 timer 下一轮
  };

  if (mode === "feasibility") {
    // N28 T2：feasibility 模式唯一轮询宿主 = 共享 runBatchHost（同一生产组合根）。
    void runBatchHost(runtime, { continuous: true, tickMs: intervalMs });
  } else {
    await tick();   // 立即跑一轮
    const timer = setInterval(tick, intervalMs);
    void timer;
  }
  // 每轮后发 status 给主进程（v1：tasks 占位空——BatchManager 消费 {type,tasks} 契约）
  // H6（watchdog v2）：ts 字段 = 心跳时间戳（主进程 watchdog 据此探测挂死）
  // 2026-08-18 L3：资源自报随心跳（rss/cpu——主进程 listBatches/obs.batches 健康面数据源）
  // N28 T2：feasibility 模式心跳投影必须来自共享 runtime（不读第二份 slots 数组）；off 保持旧形状。
  const statusTimer = setInterval(() => {
    const mem = process.memoryUsage();
    const cpu = process.cpuUsage();
    if (mode === "feasibility") {
      process.send?.(runtime.heartbeat({ ts: Date.now(), rss: mem.rss, cpuU: cpu.user, cpuS: cpu.system }));
    } else {
      process.send?.({ type: "status", tasks: [], ts: Date.now(), rss: mem.rss, cpuU: cpu.user, cpuS: cpu.system });
    }
  }, 2000);
  // keep-alive（试运行发现修正）：pg 连接池在 Node 24 下不 hold 事件循环（socket 默认 unref），
  // 空闲且仅剩 unref 定时器时进程会立即退出——batch 必须保持存活直到主进程显式 shutdown。
  // 保持定时器引用（不 unref）：进程生命周期与 batch 运行绑定，由 killBatch 的 shutdown 消息
  // 优雅终止（或 5s SIGKILL 兜底）。
  void statusTimer;
}

// 入口判断：env 标志为主（strip-types/transform-types 下 argv[1] 是绝对路径，endsWith 不可靠），
// argv 兜底兼容直接 node 运行。
if (pthConfig().str("PTH_BATCH_PROCESS") === "1" || process.argv[1]?.endsWith("batch-process.ts")) {
  // 2026-08-13 审计 P2：fork 子进程独立入口——自注入内置角色（父进程注入不跨进程）
  setDefaultRoles(ORIGIN_ROLE, DEFAULT_ROLES, MID_ROLES, GOVERNANCE_ROLES);
  // 2026-08-15 拆分：fork 子进程同样注册内置空间 + 注入空间查询（记忆包不 import core）
  registerBuiltinSpaces(spaceRegistry);
  setSpaceLookup({ get: (id) => spaceRegistry.get(id) });
  const databaseUrl = pthConfig().str("PTH_TEST_DATABASE_URL") || pthConfig().str("DATABASE_URL");
  if (!databaseUrl) {
    console.error("batch process fatal: missing database url (PTH_TEST_DATABASE_URL or DATABASE_URL)");
    process.exit(1);
  }
  const basePath = pthConfig().str("PTH_WORKSPACES_PATH");
  const artifactPath = pthConfig().str("PTH_ARTIFACTS_PATH");
  void (async () => {
    let extras: Partial<RunBatchProcessDeps> = {};
    if (pthConfig().str("PTH_COGNITIVE_RESPONSIBILITY_MODE") === "feasibility") {
      const dirPath = pthConfig().str("PTH_N28_FEASIBILITY_DIRECTORY");
      if (!dirPath) throw new Error("PTH_N28_FEASIBILITY_DIRECTORY required in feasibility mode（Directory JSON 路径）");
      const raw = JSON.parse(await readFile(dirPath, "utf8")) as {
        tenantId: string; epoch: number; knownDomainIds: string[];
        regions: unknown; responsibilities: unknown; workers: unknown; entries: unknown;
      };
      const directory = buildMemoryDirectorySnapshot({
        tenantId: raw.tenantId,
        epoch: raw.epoch,
        knownDomainIds: new Set(raw.knownDomainIds),
        workers: raw.workers as never,
        regions: raw.regions as never,
        responsibilities: raw.responsibilities as never,
        entries: raw.entries as never,
      });
      extras = {
        memoryDirectory: directory,
        directoryEntries: raw.entries as never,
        knownDomainIds: new Set(raw.knownDomainIds),
      };
    }
    await runBatchProcess({ databaseUrl, basePath, artifactPath, ...extras });
  })().catch((e) => {
    console.error("batch process fatal:", e);
    process.exit(1);
  });
}
