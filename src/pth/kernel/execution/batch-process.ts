import { mkdir } from "node:fs/promises";
import { resolve as resolvePath, relative as relativePath, isAbsolute, sep } from "node:path";
import { createPgPool } from "../storage/pg.js";
import { applySchema } from "../storage/schema.js";
import { createDataWorld } from "../storage/index.js";
import { createWorkerKernel, createWorkerKernelWithManager, createKernelManager } from "../../impls/kernels/index.js";
import type { InterpreterResult } from "../interpreter/index.js";
import type { Task } from "../storage/task-store-pg.js";
import { parseRoleWeights, expandRoleWeights, registerWorkerRole, knownRoleById, allWorkerRoles, setDefaultRoles } from "./worker-cluster.js";
import { setSpaceLookup } from "@away_from/pth-memory";
import { spaceRegistry } from "./space-registry.js";
import { registerBuiltinSpaces } from "../../impls/spaces/builtin-spaces.js";
import { checkTaskRouting, routeTaskRole } from "./role-router.js";
import { ORIGIN_ROLE, DEFAULT_ROLES, MID_ROLES, GOVERNANCE_ROLES } from "../../impls/roles/default-roles.js";
import { getEventBus } from "./event-bus.js";
import { isForwardableKernelEvent, toKernelActivityEvent } from "./kernel-event-bridge.js";
import { TaskLoop, type TaskLoopDeps } from "./task-loop.js";
import { createPgTaskRepository } from "../../tasking/adapters/pg-task-repository.js";
import { DefaultTaskWorkspaceManager } from "./workspace.js";
import { archiveTask, type ArchiveDeps } from "./archive.js";
import { createKernelModelRouter } from "./model-router.js";
import { createLlmFn } from "../interpreter/llm-fn.js";
import { Refiner } from "./refiner.js";
import { Optimizer } from "./optimizer-loop.js";
import { createToolstore } from "../interpreter/toolstore.js";
import { createKernelLogger } from "../logger.js";
import { loadKernelConfig } from "../interpreter/kernel-config.js";
import { pthConfig } from "../../config/index.js";

export interface RunBatchProcessDeps {
  databaseUrl: string;
  basePath: string;       // 工作区根（workspaces）
  artifactPath: string;   // 产物归档根（artifacts）
  intervalMs?: number;
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

/**
 * batch 子进程主函数（方案 C，裁决 15）：pth 主进程 fork 本文件。
 * 自驱动：轮询 taskStore → 全角色 worker 各跑 TaskLoop.runOnce。
 * IPC：收 shutdown → 立即退出；收 pause/resume → 暂停/恢复认领。
 * 不 resolve：子进程长驻（pg 连接池维持存活），主进程通过 IPC 终止。
 */
export async function runBatchProcess(deps: RunBatchProcessDeps): Promise<void> {
  // P3-4：runner Host 与 API Host 共用同一 bootstrap manifest（fork worker 前 fail-closed）
  {
    const { loadBootstrapConfig } = await import("../../bootstrap/bootstrap-config.js");
    const { buildPthHost } = await import("../../bootstrap/pth-host.js");
    await buildPthHost(loadBootstrapConfig().manifest);
  }
  // 内存优化：连接池收紧（7 角色 worker 并发 ≤7——max 8 够；默认 10 冗余）
  // PTH_PG_POOL_MAX 可覆盖（batch 数多时 PG 连接总量 = pool_max × batches 需核算）
  const pool = await createPgPool({ connectionString: deps.databaseUrl, max: pthConfig().num("PTH_PG_POOL_MAX") });
  await applySchema(pool);
  // 2026-08-13 审计 P2：路由策略在装配层注入（存储层纯化）
  // P0-4：createDataWorld 是 legacy assembly-only 装配点——batch 子进程与 assembly 同源。
  const dataWorld = createDataWorld(pool, { validate: checkTaskRouting, assign: routeTaskRole });
  // P1-6：batch 子进程启用 tasking dispatcher 路径（真实 lease claim/CAS commit）
  const taskRepository = createPgTaskRepository(pool);
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
        const { createToolstore } = await import("../interpreter/toolstore.js");
        const { ExtRegistry } = await import("../extensions/ext-registry.js");
        const reg = new ExtRegistry({ toolstore: createToolstore(extPath), extContext: { log: () => {} } });
        await reg.loadAll();
      } catch (e) {
        batchLogger?.warn?.(`[ext] fork 内扩展装载失败（放行）: ${(e as Error).message}`);
      }
    }
  }

  let paused = false;

  /** 退出前释放全部 worker kernel（sandbox acquire 归还——防池泄漏）——幂等 */
  let disposed = false;
  async function disposeAllKernels(): Promise<void> {
    if (disposed) return;
    disposed = true;
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

  process.on("message", (msg: any) => {
    if (msg?.type === "set-param" && typeof msg.key === "string") {
      // 性能自持（v0.8）：主进程 autopilot 下发调参 → batch 进程内 config（perf 扩展同源）
      try {
        const { config } = require("../extensions/perf-params.js") as typeof import("../extensions/perf-params.js");
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
      getEventBus().emit("worker.pause", { role: msg.role, batchPid: process.pid });
      for (const l of loops) if (l.role.id === msg.role) l.pause();
      process.send?.({ type: "worker-status", batchPid: process.pid, role: msg.role, state: "paused" });
    } else if (msg?.type === "worker-resume" && typeof msg.role === "string") {
      getEventBus().emit("worker.resume", { role: msg.role, batchPid: process.pid });
      for (const l of loops) if (l.role.id === msg.role) l.resume();
      process.send?.({ type: "worker-status", batchPid: process.pid, role: msg.role, state: "active" });
    } else if (msg?.type === "worker-remove" && typeof msg.role === "string") {
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
          createWorker(roleDef);
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
        for (let i = 0; i < copies; i++) createWorker(roleDef);
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
  const loops: Array<BatchTaskLoop & { role: import("./worker-cluster.js").WorkerRole }> = [];

  /** 创建并注册一个角色 worker（P3 动态 add 复用；remove 后 dispose kernel 回收 python 进程） */
  const createWorker = (role: import("./worker-cluster.js").WorkerRole) => {
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
          principalId: `worker:${role.id}`,
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
      roleFilter: role.capabilities,
      memoryScope: role.memoryScope ? { role: role.id, scope: role.memoryScope } : undefined,
      roleId: role.id,
      registerKernel: (language, interpreter) => manager.registerKernel(language, interpreter as never),
      readSource: pthConfig().str("PTH_SOURCE_ROOT")
        ? (relPath) => import("../interpreter/read-source.js").then((m) => m.createReadSource(pthConfig().str("PTH_SOURCE_ROOT"))(relPath))
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
            const { applyOptimizerSuggestion } = await import("./optimizer-apply.js");
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
      kernel, role, taskStore: dataWorld.tasks, workspaceMgr, refiner, optimizer, logger: batchLogger,
      repository: taskRepository,
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
    (loop as unknown as { kernel?: unknown }).kernel = kernel;   // remove 时 dispose 用
    (loop as unknown as { optimizer?: { stop?: () => void } }).optimizer = optimizer;   // remove 时停复测巡检表
    (loop as unknown as { role?: import("./worker-cluster.js").WorkerRole }).role = role;  // remove 寻址用
    loops.push(loop as BatchTaskLoop & { role: import("./worker-cluster.js").WorkerRole });
    return loop;
  };

  workerRoles.forEach((role) => createWorker(role));

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

  await tick();   // 立即跑一轮
  const timer = setInterval(tick, intervalMs);
  // 每轮后发 status 给主进程（v1：tasks 占位空——BatchManager 消费 {type,tasks} 契约）
  // H6（watchdog v2）：ts 字段 = 心跳时间戳（主进程 watchdog 据此探测挂死）
  const statusTimer = setInterval(() => {
    process.send?.({ type: "status", tasks: [], ts: Date.now() });
  }, 2000);
  // keep-alive（试运行发现修正）：pg 连接池在 Node 24 下不 hold 事件循环（socket 默认 unref），
  // 空闲且仅剩 unref 定时器时进程会立即退出——batch 必须保持存活直到主进程显式 shutdown。
  // 保持定时器引用（不 unref）：进程生命周期与 batch 运行绑定，由 killBatch 的 shutdown 消息
  // 优雅终止（或 5s SIGKILL 兜底）。
  void timer;
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
  runBatchProcess({ databaseUrl, basePath, artifactPath }).catch((e) => {
    console.error("batch process fatal:", e);
    process.exit(1);
  });
}
