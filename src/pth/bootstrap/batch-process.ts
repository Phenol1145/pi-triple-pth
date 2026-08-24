/**
 * batch-process.ts —— batch 子进程组合根（P2-9：按装配段抽 section-assembler 到 bootstrap/batch/）。
 *
 * 本文件只做编排：host-bootstrap → tool-face → dataWorld/catalog → professional runtime →
 * modelRouter → feasibility-runtime → ipc-control → intake → outbox-drainer → runchild-budget →
 * createWorker/runtime 组装 → 轮询宿主 → 心跳上报。业务语义与装配顺序与原单文件版一致。
 */

import { mkdir, readFile } from "node:fs/promises";
import { resolve as resolvePath, relative as relativePath, isAbsolute, sep } from "node:path";
import { createDataWorld } from "@away_from/pth-kernel-storage";
import { createDisciplineResolver } from "../catalog/index.js";
import { createWorkerKernelWithManager, createKernelManager } from "../impls/kernels/index.js";
import { parseRoleWeights, expandRoleWeights, registerWorkerRole, setDefaultRoles, setProfessionalRoles } from "@away_from/pth-kernel-execution";
import { setSpaceLookup } from "@away_from/pth-memory";
import { spaceRegistry } from "@away_from/pth-kernel-interpreter";
import { registerBuiltinSpaces } from "@away_from/pth-kernel-execution";
import { checkTaskRouting, routeTaskRole } from "@away_from/pth-kernel-execution";
import { DEFAULT_ROLES, MID_ROLES, GOVERNANCE_ROLES, PROFESSIONAL_ROLES } from "@away_from/pth-kernel-execution";
import { createKernelModelRouter } from "@away_from/pth-kernel-execution";
import { createLlmFn } from "@away_from/pth-kernel-interpreter";
import { Refiner, Optimizer } from "@away_from/pth-kernel-execution";
import { createToolstore } from "@away_from/pth-kernel-interpreter";
import { loadKernelConfig } from "@away_from/pth-kernel-interpreter";
import { pthConfig } from "@away_from/pth-config";
import type { WorkerRole, WorkerReplica } from "@away_from/pth-kernel-execution";
import {
  createPgTaskRepository,
  TaskControlService,
  PgTaskQueries,
  allowedDelegationTargets,
  createPenetrationRunner,
} from "../tasking/index.js";
import { DefaultTaskWorkspaceManager } from "@away_from/pth-kernel-execution";
import type { ArchiveDeps } from "@away_from/pth-kernel-execution";
import { assembleWorkerSlotIdentity } from "./worker-slot-assembly.js";
import { assembleBatchRuntime, runBatchHost } from "./batch-runtime-assembly.js";
import type { ProfessionalRuntimeLock } from "@away_from/pth-contracts";
import { assembleProfessionalRuntimeRegistry, createProfessionalArtifactPort } from "./professional-runtime-adapters.js";
import { buildMemoryDirectorySnapshot, createExecutionGrantService, createHmacGrantKeyProvider, createPlanGrantVerify } from "../execution/index.js";
import { bootstrapBatchHost } from "./batch/host-bootstrap.js";
import { assembleToolFace } from "./batch/tool-face.js";
import { assembleCognitiveResponsibility, buildAssemblyWorkerSpecs, makeWorkerSlot } from "./batch/feasibility-runtime.js";
import { createKernelDisposer, installBatchIpcControl, startBatchStatusReporter } from "./batch/ipc-control.js";
import { assembleKnowledgeIntake } from "./batch/intake.js";
import { assembleOutboxDrainer } from "./batch/outbox-drainer.js";
import { createPenetrationBudgetState, createPenetrationRunChild, type PenetrationRunChildSharedDeps } from "./batch/runchild-budget.js";
import type { AuthoritativeWorkingSets, BatchControlState, BatchLoopEntry, IntakeTrigger } from "./batch/context.js";
import type { RunBatchProcessDeps } from "./batch-process-types.js";
export type { RunBatchProcessDeps } from "./batch-process-types.js";
import { BatchTaskLoop, buildDisciplineCatalogSnapshot } from "./batch-process-helpers.js";


/**
 * 转录归档接线（Task 4 接入）——P1-6 改为组合：不再继承 TaskLoop，
 * 通过 archiveFn 注入完整转录归档（archiveTask = 转录入 pg + 产物 rename + 清理提示）。
 * 外部接口（runOnce/pause/resume/stop/isPaused/isStopped）与旧继承版一致。
 */
export async function runBatchProcess(deps: RunBatchProcessDeps): Promise<void> {
  // ── 装配段：host-bootstrap（P1：runner Host 与 API Host 共用同一 bootstrap manifest +
  // 执行后端注册表；sandbox 接线；PG 池 + schema）──────────────────────────────────
  const { host, batchLogger, sandboxKernelUrl, sandboxKernelSecret, pool } = await bootstrapBatchHost({
    databaseUrl: deps.databaseUrl,
  });

  // ── 装配段：tool-face（TCE P5 tool manifest + TCE P3 worker 侧 CommandGateway）────────
  const { extraTools, commandGateway } = await assembleToolFace({ host, pool, batchLogger });

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
  // P1-6：batch 子进程启用 tasking dispatcher 路径（真实 lease claim/CAS commit）
  const taskRepository = createPgTaskRepository(pool);
  // W8 P1：任务投递服务（worker 工具面 tasks.delegate/await 的服务器端实现）
  const taskControl = new TaskControlService({ store: dataWorld.tasks, pool, queries: new PgTaskQueries(pool) });
  const workspaceMgr = new DefaultTaskWorkspaceManager({ basePath: deps.basePath, artifactPath: deps.artifactPath });
  // 产物根必须先存在：archive 用 rename 而非 mkdir——父目录缺失时 rename 抛 ENOENT
  await mkdir(deps.artifactPath, { recursive: true });

  // Task 4：专业计算执行宿主——committed lock + adapter factories 唯一组装点。
  // 只注册 probe 成功且版本匹配 committed lock 的 adapter；artifact 端口按租户隔离。
  const professionalRuntimeLock = JSON.parse(
    await readFile(new URL("../../../deploy/professional-runtime-lock.json", import.meta.url), "utf8"),
  ) as ProfessionalRuntimeLock;
  const professionalRuntimeRegistry = await assembleProfessionalRuntimeRegistry({
    lock: professionalRuntimeLock,
    factories: deps.professionalRuntimeFactories,
    // P1.0：artifactPath 必传——默认 factory 全部以此为前置（生产装配空洞修复）
    artifactPath: deps.artifactPath,
    // T4：生产 asm-kernel index 路径（Dockerfile 把 toolstore 拷到 /data/toolstore）
    ...(pthConfig().str("PTH_ASM_KERNEL_INDEX_PATH")
      ? { asmKernelIndexPath: pthConfig().str("PTH_ASM_KERNEL_INDEX_PATH") }
      : {}),
    // P1.4/P1.5：执行后端路由 + legacy 前缀硬切（无 backend/prefix → 不注册 runtime）
    executionBackends: host.backends,
    backendRoutes: host.routes,
  });
  const registeredProfessionalRuntimes = professionalRuntimeRegistry.list();
  batchLogger.info(`professional runtimes registered: ${registeredProfessionalRuntimes.length === 0 ? "(none)" : registeredProfessionalRuntimes.join(", ")}`, {
    runtimes: registeredProfessionalRuntimes,
  });
  const professionalArtifacts = createProfessionalArtifactPort({ artifactPath: deps.artifactPath });
  let professionalGrantService: ReturnType<typeof createExecutionGrantService> | undefined;
  try {
    professionalGrantService = createExecutionGrantService({
      keyProvider: createHmacGrantKeyProvider({ secret: pthConfig().str("PTH_EXECUTION_GRANT_SECRET") }),
    });
  } catch (error) {
    // 无有效 grant 签名密钥时 professional.execute 不注入（LLM 面关闭），不阻塞普通任务。
    professionalGrantService = undefined;
  }
  // W2：plan grant 校验闭包（与 professional grant 同密钥——manage 即时生效工具用）
  const planGrantVerify = createPlanGrantVerify(professionalGrantService);

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
        const { createToolstore } = await import("@away_from/pth-kernel-interpreter");
        const { ExtRegistry } = await import("@away_from/pth-kernel-interpreter");
        const reg = new ExtRegistry({ toolstore: createToolstore(extPath), extContext: { log: () => {} }, roleRegistrar: registerWorkerRole });
        await reg.loadAll();
      } catch (e) {
        batchLogger?.warn?.(`[ext] fork 内扩展装载失败（放行）: ${(e as Error).message}`);
      }
    }
  }

  // 控制面共享状态（ipc-control 段写入，tick/worker 装配读取）。
  const controlState: BatchControlState = { paused: false };
  const intakeTrigger: IntakeTrigger = {};
  // N28 T2：认知责任模式（默认 off=legacy 逐字节兼容）；feasibility 由确定性装配/harness 显式开启。
  const mode = pthConfig().str("PTH_COGNITIVE_RESPONSIBILITY_MODE") === "feasibility" ? "feasibility" as const : "off" as const;
  const batchId = pthConfig().str("PTH_BATCH_ID") || `batch:${process.pid}`;
  // N28 复核 Layer3：role 批量 remove 的最终回执聚合（全部 worker-removed 后发唯一 role removed）。
  const pendingRoleRemovals = new Map<string, Set<string>>();
  // N33 复验收 P1-2：feasibility worker 最近一次认知工作集账本快照（心跳时有界投影）。
  const authoritativeWorkingSets: AuthoritativeWorkingSets = new Map();

  // ── 装配段：feasibility-runtime（N28 T6 provider + 启动前责任容量硬闸；
  // off 模式返回 legacy 默认 knowledgeContextProvider）────────────────────────────
  const {
    knowledgeContextProvider,
    cognitiveWorkingSetProvider,
    authorizedTaskReadFactory,
    verifiedReadScopeFactory,
  } = assembleCognitiveResponsibility({ deps, mode, dataWorld, catalog, authoritativeWorkingSets });

  // ── 装配段：ipc-control（进程级兜底/优雅退出/控制面 message handler/EventBus 桥）。
  // 注意：runtime/loops/createWorker 在下方才完成装配——accessor 惰性求值，TDZ 语义不变。 ──
  const disposer = createKernelDisposer({ mode, getRuntime: () => runtime, getLoops: () => loops });
  installBatchIpcControl({
    mode,
    batchLogger,
    controlState,
    intakeTrigger,
    pendingRoleRemovals,
    disposer,
    getRuntime: () => runtime,
    getLoops: () => loops,
    createWorker: (role) => createWorker(role),
    makeSlot: (w) => makeWorkerSlot(w),
  });

  const archiveDeps: ArchiveDeps = {
    transcriptStore: dataWorld.transcripts,
    workspaceMgr,
    emitCleanup: (info) => process.send?.({ type: "cleanup", taskId: info.taskId, artifactPath: info.artifactPath }),
  };

  // ── 装配段：intake（N29 Task 6 内环；off 时完全不实例化——handler 集合保持 N28 形状）──
  const { stageHandlers: intakeStageHandlers, dueScanner: intakeDueScanner } = await assembleKnowledgeIntake({
    pool, dataWorld, modelRouter, batchLogger,
  });

  // ── 装配段：outbox-drainer（F5 durable outbox + drainer；refine/intake handler 注册）──
  const { sideEffectOutbox, refineRefiners, kickSideEffectDrainer } = assembleOutboxDrainer({
    pool, batchLogger, intakeStageHandlers,
  });

  /**
   * N29 Task 6：due scanner 唤醒（trigger 统一化——主进程 `intake.due-scan` 经 IPC 下行）。
   * Trigger **只**唤醒 scanner；`Subscription.nextCrawlAt` 是唯一调度真相。scanner 只建 run
   * 与 `intake.fetch` outbox 行，随后由上面的 drainer 接管阶段推进。
   */
  const runIntakeDueScan = async (): Promise<number> => {
    if (!intakeDueScanner) return 0;
    const created = await intakeDueScanner.scanOnce();
    if (created.length > 0) kickSideEffectDrainer();
    return created.length;
  };
  if (intakeDueScanner) intakeTrigger.run = runIntakeDueScan;

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
  const loops: BatchLoopEntry[] = [];

  // ── 装配段：runchild-budget（N15 B2 穿透预算账本 + runChild 嵌套子 agent 执行缝工厂）──
  const runChildShared: PenetrationRunChildSharedDeps = {
    budget: createPenetrationBudgetState(),
    sandboxKernelUrl,
    sandboxKernelSecret,
    modelRouter,
    dataWorld,
    toolstore,
    batchLogger,
    planGrantVerify,
  };

  /** 创建并注册一个角色 worker（P3 动态 add 复用；remove 后 dispose kernel 回收 python 进程） */
  const createWorker = (role: WorkerRole, forcedReplica?: WorkerReplica) => {
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
    const taskContext: { current: import("@away_from/pth-contracts").TaskDispatchContext | null } = { current: null };
    // 穿透 runChild 执行缝（runchild-budget 段）：穿透 runner 与 tool-reg agent 态执行缝共用同一实现。
    const parentKernelRef: { current?: { ts: unknown } } = {};
    const runChildImpl = createPenetrationRunChild(runChildShared, { replica, parentKernelRef });
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
        url: sandboxKernelUrl,
        secret: sandboxKernelSecret,
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
      produces: role.produces,
      planGrantVerify,
      taskControl: canDelegate ? taskControl : undefined,
      penetration,
      // L2：能力面活动事件上报（skill.proposal.created——与 loop 同一 IPC 转发通道）
      onActivity: (e) => { try { process.send?.({ kind: "activity", activity: { ...e, batchPid: process.pid } }); } catch { /* IPC 不可用 */ } },
      taskContext,
      registerKernel: (language, interpreter) => manager.registerKernel(language, interpreter as never),
      readSource: pthConfig().str("PTH_SOURCE_ROOT")
        ? (relPath) => import("@away_from/pth-kernel-interpreter").then((m) => m.createReadSource(pthConfig().str("PTH_SOURCE_ROOT"))(relPath))
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
            const { applyOptimizerSuggestion } = await import("@away_from/pth-kernel-execution");
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
      // 生命周期 P1：publisher-question 落 paused 状态（human suspension 留待 W3 接线）
      onSuspension: async ({ lease, work, suspension }) => {
        if (suspension.kind === "human") {
          // TCE P3：等待人工批准——释放 lease，任务进入 waiting-human（human_requests 已由 CommandGateway 创建）。
          await pool.query(
            `UPDATE tasks SET
               status = 'waiting-human',
               claimed_by = NULL,
               claimed_at = NULL,
               lease_id = NULL,
               lease_expires_at = NULL,
               updated_at = now()
             WHERE id = $1 AND lease_id = $2 AND lease_generation = $3 AND status = 'claimed'`,
            [lease.taskId, lease.leaseId, lease.generation],
          );
          return;
        }
        if (suspension.kind !== "publisher-question") return;
        const ok = await taskControl.pause({ lease, work, suspension });
        if (!ok) {
          batchLogger.warn(`[taskloop] pause 落库失败（认领已被回收/跨租户？task=${lease.taskId}）`);
          return;
        }
        try {
          process.send?.({ kind: "activity", activity: {
            kind: "task.pause", taskId: lease.taskId, role: effectiveRole.id,
            detail: suspension.question.slice(0, 100), batchPid: process.pid, at: Date.now(),
          } });
        } catch { /* IPC 不可用 */ }
      },
      // TCE P3：语言工具先过 CommandGateway 授权
      commandGateway,
      // TCE P5：per-tool 工具面（manifest 策展）
      extraTools,
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
      // Task 4：同一 registry + artifact 端口供给所有 specialist Worker Replica。
      professionalRuntimeRegistry,
      professionalArtifacts,
      professionalGrantService,
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
      (loop as unknown as { role?: WorkerRole }).role = role;  // remove 寻址用
      loops.push(loop as BatchLoopEntry);
    }
    return { loop, kernel, optimizer, replica, role: effectiveRole };
  };

  // N28 T2：feasibility 模式唯一 slot 运行时（off 模式完全不实例化新控制面）。
  const assemblyWorkerSpecs = buildAssemblyWorkerSpecs({ mode, deps, workerRoles });
  const runtime = assembleBatchRuntime({
    mode,
    batchId,
    workerSpecs: assemblyWorkerSpecs,
    buildSlot: ({ role, replica }) => makeWorkerSlot(createWorker(role, replica)),
    emit: (event) => {
      try {
        process.send?.(event);
        // 聚合 role remove 最终回执：最后一个 worker-removed 到达时发 role removed。
        if (event.type === "worker-removed") {
          for (const [role, remaining] of pendingRoleRemovals) {
            remaining.delete(event.workerId);
            if (remaining.size === 0) {
              pendingRoleRemovals.delete(role);
              process.send?.({ type: "worker-status", batchPid: process.pid, role, state: "removed" });
            }
          }
        }
      } catch { /* IPC 不可用 */ }
    },
  });

  if (mode !== "feasibility") {
    workerRoles.forEach((role) => createWorker(role));
  }

  // 每轮：各 worker runOnce（并发）；didWork=true（有任务执行完）→ 立即自驱动下一轮
  // （吞吐优化：串行任务零轮询等待——0.58s/任务 的轮询延迟消除）；
  // 空闲（无候选）退避回 intervalMs timer，避免空转查询 PG。
  const tick = async (): Promise<void> => {
    if (controlState.paused) return;
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
  // ── 装配段：ipc-control（心跳上报——2s status timer；keep-alive 见模块注释）─────────
  void startBatchStatusReporter({
    mode,
    getRuntime: () => runtime,
    memoryDirectory: deps.memoryDirectory,
    authoritativeWorkingSets,
  });
}

// 入口判断：env 标志为主（strip-types/transform-types 下 argv[1] 是绝对路径，endsWith 不可靠），
// argv 兜底兼容直接 node 运行。
if (pthConfig().str("PTH_BATCH_PROCESS") === "1" || process.argv[1]?.endsWith("batch-process.ts")) {
  // 2026-08-13 审计 P2：fork 子进程独立入口——自注入内置角色（父进程注入不跨进程）
  setDefaultRoles(DEFAULT_ROLES, MID_ROLES, GOVERNANCE_ROLES);
  // Task 3：专业角色进入 known lineage/显式权重解析（不进缺省单副本循环）
  setProfessionalRoles(PROFESSIONAL_ROLES);
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
