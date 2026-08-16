import { createPgPool, applySchema, createDataWorld } from "./storage/index.js";
import { BatchManager } from "./execution/batch-manager.js";
import { getEventBus } from "./execution/event-bus.js";
import { toKernelActivityEvent } from "./execution/kernel-event-bridge.js";
import { parseRoleWeights, expandRoleWeights, registerWorkerRole, allWorkerRoles, allKnownRoles, setDefaultRoles } from "./execution/worker-cluster.js";
import { checkTaskRouting, routeTaskRole } from "./execution/role-router.js";
import { parseWorkerRoleRecovery, parseSpaceRecovery } from "./execution/recovery-validation.js";
import { ORIGIN_ROLE, DEFAULT_ROLES, MID_ROLES, GOVERNANCE_ROLES } from "./execution/builtin-roles.js";
import { TaskResolver } from "./execution/task-resolver.js";
import { evaluateAndScale, loadScalerConfig } from "./execution/batch-scaler.js";
import { registerSystemTriggers } from "./execution/system-triggers.js";
import { createKernelLogger } from "./logger.js";
import { pthConfig } from "../config/index.js";
import type pg from "pg";

export interface KernelRuntimeOptions {
  /** obs 观测请求解析器（batch obs-req → 主进程 metrics/batches 数据） */
  obsResolver?: (req: string, params: unknown) => Promise<unknown>;
  databaseUrl: string;
  basePath: string;       // 工作区根（workspaces）
  artifactPath: string;   // 产物归档根（artifacts）
  batchProcessPath?: string;  // batch-process 入口（默认按运行环境解析：dist 优先，src 兜底）
  execArgv?: string[];    // 生产 fork 透传（TS 源码模式：transform-types + resolve-hook loader）
  env?: Record<string, string>;  // 生产 fork 环境透传（PTH_BATCH_PROCESS/DATABASE_URL 等）
  toolstorePath?: string;  // toolstore 文件通道目录（默认继承主进程 env）
  watchdogIntervalMs?: number; // watchdog 探测周期（默认 30s）
  resolverIntervalMs?: number; // TaskResolver 解析轮询周期（默认 2s）
  /** 性能计量（SPEC L1）：batch kernel/llm 事件回调（main.ts 接 kernelMetrics） */
  onMetric?: (m: Record<string, unknown>) => void;
}

export interface KernelWatchdogEvent {
  batchId: string;
  pid: number;
  ts: number;
  /** H6（watchdog v2）：'hung-restarted' = 心跳陈旧挂死已自动重启；缺省 = 崩溃记录 */
  kind?: "hung-restarted";
}

/**
 * PTH kernel watchdog（装配层 Task 2）：
 * 周期探测 BatchManager 中 batch 子进程存活；崩溃（exit 且未 kill）→ 记录事件。
 * v1 约束：只记录不自动重启（plan Task 2「watchdog（batch 崩溃记录，不自动重启 v1）」）。
 */
export class KernelWatchdog {
  private timer: ReturnType<typeof setInterval> | null = null;
  private crashLog: KernelWatchdogEvent[] = [];
  /** H6（watchdog v2）：挂死判定阈值——心跳超过该时长未到即视为挂死（默认 3×status 上报周期 2s） */
  private static readonly HEARTBEAT_STALE_MS = 15_000;

  constructor(
    private batchManager: BatchManager,
    private logger: (msg: string) => void = () => {},
  ) {}

  start(intervalMs = 30_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.probe(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * 探测一轮（watchdog v2——审计 H6）：
   * - 崩溃（进程退出）→ 记录事件（v1 语义保留）
   * - 存活但心跳陈旧（事件循环挂死——ts 死循环/单任务 DoS）→ kill + 自动重启 + 记录事件
   * 返回本轮新增事件数（崩溃 + 挂死重启）。
   */
  async probe(): Promise<number> {
    let events = 0;
    for (const status of await this.batchManager.listBatches()) {
      if (!this.batchManager.isBatchAlive(status.id)) {
        const evt: KernelWatchdogEvent = { batchId: status.id, pid: status.pid, ts: Date.now() };
        this.crashLog.push(evt);
        this.logger(`[watchdog] batch ${status.id} crashed (pid ${status.pid}) — recorded`);
        events++;
        continue;
      }
      // H6：存活但心跳陈旧 → 挂死（进程在，事件循环被阻塞——kill + 重启恢复）
      const lastBeat = this.batchManager.lastHeartbeatOf(status.id);
      if (Date.now() - lastBeat > KernelWatchdog.HEARTBEAT_STALE_MS) {
        try {
          await this.batchManager.killBatch(status.id);
          await this.batchManager.spawnBatch();
          const evt: KernelWatchdogEvent = { batchId: status.id, pid: status.pid, ts: Date.now(), kind: "hung-restarted" };
          this.crashLog.push(evt);
          this.logger(`[watchdog] batch ${status.id} hung (no heartbeat ${Date.now() - lastBeat}ms) — killed & restarted`);
          events++;
        } catch (e) {
          this.logger(`[watchdog] batch ${status.id} hung but restart failed: ${(e as Error).message}`);
        }
      }
    }
    return events;
  }

  getCrashLog(): KernelWatchdogEvent[] {
    return [...this.crashLog];
  }
}

export interface KernelRuntime {
  pool: pg.Pool;
  dataWorld: ReturnType<typeof createDataWorld>;
  batchManager: BatchManager;
  /** 活动事件流聚合器（console --follow / SSE /api/v1/kernel/events 数据源） */
  activityHub: import("./execution/activity-hub.js").ActivityHub;
  /** trigger 引擎（事件触发任务——订阅 activityHub——trigger 定义存 memory kind='trigger'） */
  triggerEngine: import("./execution/trigger-engine.js").TriggerEngine;
  /** W8 P2 任务派发回流 notifier（子终态 → 父 childResult） */
  taskDispatchNotifier: import("../tasking/index.js").TaskDispatchNotifier;
  watchdog: KernelWatchdog;
  /** TaskResolver（任务池即工作流 T3）：独立解析循环 */
  resolver: import("./execution/task-resolver.js").TaskResolver;
  /** kernel 直连执行通道（任务池纯化 D2——调试/运维代码执行不占任务池——stateless/repl 双模式） */
  execChannel: import("./exec-channel.js").KernelExecChannel;
  shutdown: () => Promise<void>;
}

/**
 * PTH kernel 统一装配（装配层 Task 2）：
 * pg 连接池 → applySchema → dataWorld（tasks/memory/transcripts/audit）
 * → BatchManager（fork batch-process 子进程）+ watchdog（崩溃记录，不自动重启 v1）。
 */
/**
 * 按运行环境解析 batch-process 入口：PTH_BATCH_TS=1（dev 源码模式——tsx watch 热更新）
 * → src TS；否则（生产）→ dist 编译产物。execArgv 配套（PTH_BATCH_TS 时 tsx loader）。
 */
function resolveBatchProcessPath(explicit: string | undefined): string {
  if (explicit) return explicit;
  if (pthConfig().str("PTH_BATCH_TS") === "1") return "src/pth/bootstrap/batch-process.ts";
  return "dist/pth/bootstrap/batch-process.js";
}

/**
 * Claim 超时默认值解析（审计 H5 修复）：长任务执行期间不得被误回收重领（双执行/结果丢失）。
 * - 显式 PTH_CLAIM_TIMEOUT_MS → 优先
 * - 未显式配置但任务超时 PTH_AGENT_TIMEOUT_MS 已设 → 任务超时 + 10min 余量（保证 claim 阈值 > 任务最长时长）
 * - 均未配置 → 600s 下限（本地默认任务超时 120s 场景足够）
 */
export function resolveClaimTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const explicit = Number(env.PTH_CLAIM_TIMEOUT_MS);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const agentTimeout = Number(env.PTH_AGENT_TIMEOUT_MS);
  if (Number.isFinite(agentTimeout) && agentTimeout > 0) return agentTimeout + 600_000;
  return 600_000;
}

export async function createKernelRuntime(opts: KernelRuntimeOptions): Promise<KernelRuntime> {
  const pool = await createPgPool({ connectionString: opts.databaseUrl });
  await applySchema(pool);

  // 2026-08-13 审计 P2：内置角色在装配层注入（核心 worker-cluster 不再 import 实现层）
  setDefaultRoles(ORIGIN_ROLE, DEFAULT_ROLES, MID_ROLES, GOVERNANCE_ROLES);
  // 2026-08-15 拆分：记忆包不 import core——空间查询由装配层注入；
  // 内置空间注册移出 space-registry 模块（断 core 实现层环）
  const { setSpaceLookup } = await import("@away_from/pth-memory");
  const { spaceRegistry } = await import("./execution/space-registry.js");
  const { registerBuiltinSpaces } = await import("./execution/builtin-spaces.js");
  registerBuiltinSpaces(spaceRegistry);
  setSpaceLookup({ get: (id) => spaceRegistry.get(id) });

  // 2026-08-13 审计 P2：路由策略在装配层注入（存储层纯化——task-store 只存不判）
  // P0-4：createDataWorld 是 legacy assembly-only 装配点——唯一合法生产构造入口（batch-process 同源）。
  const dataWorld = createDataWorld(pool, { validate: checkTaskRouting, assign: routeTaskRole });
  const assemblyLogger = createKernelLogger();
  const { ActivityHub } = await import("./execution/activity-hub.js");
  const activityHub = new ActivityHub();
  // trigger 统一化（事件桥）：主进程 EventBus 的 batch 生命周期事件 → ActivityHub（trigger 事件源统一）
  const offMainBus = getEventBus().on("*", (evt) => {
    if (evt.type !== "batch.spawn" && evt.type !== "batch.kill") return;
    activityHub.publish(toKernelActivityEvent(evt, process.pid));
  });
  const { TriggerEngine } = await import("./execution/trigger-engine.js");
  const triggerEngine = new TriggerEngine({
    activityHub,
    tasks: dataWorld.tasks,
    memory: dataWorld.memory,
    logger: (m) => assemblyLogger.info(m),
  });
  // W8 P2：任务派发回流 notifier（子任务终态事件 → 父任务 payload.childResult）
  const { TaskDispatchNotifier } = await import("../tasking/index.js");
  const taskDispatchNotifier = new TaskDispatchNotifier({
    pool,
    activityHub,
    logger: (m) => assemblyLogger.info(m),
  });
  taskDispatchNotifier.start();
  const batchManager = new BatchManager({
    batchProcessPath: resolveBatchProcessPath(opts.batchProcessPath),
    // batch 构成参数化：PTH_WORKER_ROLES 展开（副本重复）——与子进程自身解析一致
    workers: expandRoleWeights(parseRoleWeights(opts.env?.PTH_WORKER_ROLES ?? pthConfig().str("PTH_WORKER_ROLES"))).map((r) => r.id),
    // dev 源码模式（PTH_BATCH_TS=1——batch-process.ts）→ fork 用 tsx loader（execArgv 未显式时默认注入）
    execArgv: opts.execArgv ?? (pthConfig().str("PTH_BATCH_TS") === "1" ? ["--import", "tsx"] : undefined),
    logger: createKernelLogger(),
    onMetric: opts.onMetric,
    obsResolver: opts.obsResolver,
    onActivity: (e) => activityHub.publish(e),
    // 自动注入 kernel 子进程 env（试运行发现：main.ts 只传 databaseUrl 不传 env，
    // fork 的子进程没有 PTH_BATCH_PROCESS/DATABASE_URL → 不进入 batch 入口 → 立即退出）。
    // 调用方显式传 env 时覆盖（后进覆盖先进）。
    env: {
      PTH_BATCH_PROCESS: "1",
      PTH_TEST_DATABASE_URL: opts.databaseUrl,
      DATABASE_URL: opts.databaseUrl,
      PTH_WORKSPACES_PATH: opts.basePath,
      PTH_ARTIFACTS_PATH: opts.artifactPath,
      // toolstore 文件通道：继承主进程 env（默认 <dataDir>/toolstore）
      PTH_TOOLSTORE_PATH: opts.toolstorePath ?? pthConfig().str("PTH_TOOLSTORE_PATH"),
      // 自修改（v1）：源码根（worker readSource 只读面——容器 /app/src）
      PTH_SOURCE_ROOT: pthConfig().str("PTH_SOURCE_ROOT"),
      ...opts.env,
    },
  });
  const watchdog = new KernelWatchdog(batchManager);
  // trigger 统一化：watchdog 不再自起定时器——batch-watchdog schedule trigger 驱动 probe()

  // 自修改（v1）：注入源码指南到公共记忆区（developer 单步修改用——幂等）
  try {
    const { injectSelfModifyGuide } = await import("./self-modify.js");
    await injectSelfModifyGuide(dataWorld.memory);
  } catch (e) {
    assemblyLogger?.warn?.(`[self-modify] 指南注入失败（放行）: ${(e as Error).message}`);
  }
  // Prompt 框架化（2026-08-09）：角色文档 + 能力索引入 memory（prompt 数据源——
  // eager 注入 / lazy 指针——新核/新角色零 prompt 改动）
  try {
    const { injectPromptDocs } = await import("./prompt-docs.js");
    await injectPromptDocs(dataWorld.memory);
  } catch (e) {
    assemblyLogger?.warn?.(`[prompt-docs] 文档注入失败（放行）: ${(e as Error).message}`);
  }

  // TaskResolver（任务池即工作流 T3）：trigger 统一化——flow-resolver schedule trigger 驱动
  // resolveLoop（有产出 → 快周期；空转 → 2s→5s→10s→15s 动态退避——注册见 system-triggers）。
  const resolver = new TaskResolver({ taskStore: dataWorld.tasks, pool });
  // kernel 直连通道（任务池纯化 D2）：调试/运维代码执行——不占任务池
  const { KernelExecChannel } = await import("./exec-channel.js");
  const execChannel = new KernelExecChannel({ dataWorld });

  // 兼容性扩展装载（2026-08-09）：toolstore/extensions 扫描 → 角色注册到谱系——
  // 主进程路由（publish 时 routeTaskRole）与 fork 内认领共用 allWorkerRoles。扩展角色
  // 的 worker spawn 由 PTH_WORKER_ROLES/worker-add 配置（默认构成不含扩展角色）。
  const toolstorePath = opts.toolstorePath ?? pthConfig().str("PTH_TOOLSTORE_PATH");
  if (toolstorePath) {
    try {
      const { createToolstore } = await import("./interpreter/toolstore.js");
      const { ExtRegistry } = await import("./extensions/ext-registry.js");
      const reg = new ExtRegistry({
        toolstore: createToolstore(toolstorePath),
        extContext: { log: (m: unknown) => assemblyLogger?.info?.(`[ext] ${String(m)}`) },
        roleRegistrar: registerWorkerRole,
      });
      const loaded = await reg.loadAll();
      if (loaded.length > 0) assemblyLogger?.info?.(`[assembly] 扩展装载完成（${loaded.join(",")}）`);
    } catch (e) {
      assemblyLogger?.warn?.(`[assembly] 扩展装载失败（放行——不影响 kernel 启动）: ${(e as Error).message}`);
    }
  }

  // 官方 proposal 恢复（2026-08-13 补录：持久化机制建立前 approve 的角色——重启丢失历史债务）。
  // 已 approved 的 differentiation-proposal → suggestedRole 缺省构造（与 routes-lineage 批准缺省逻辑一致：
  // tags=[roleId]、capabilities/thinking 继承 parent）→ registerWorkerRole + 落 worker-role 条目（幂等）。
  const recoveredRoles: Array<{ id: string }> = [];   // 恢复角色清单（spawnBatch 后热上线）
  try {
    const approved = await dataWorld.memory.retrieve({ kinds: ["differentiation-proposal"], status: ["official"] });
    let rebuilt = 0;
    for (const e of approved) {
      try {
        if ((e.meta as Record<string, unknown> | undefined)?.["approved"] !== true) continue;
        const content = JSON.parse(e.content) as { suggestedRole?: { id?: string; parent?: string; specialization?: string; rationale?: string } };
        const sug = content.suggestedRole;
        if (!sug?.id || !sug.parent) continue;
        const already = allWorkerRoles().some((r) => r.id === sug.id);
        if (already) continue;   // 已恢复（worker-role 恢复段）或内置
        const parentRole = allKnownRoles().find((r) => r.id === sug.parent);
        const role = {
          id: sug.id,
          tags: [sug.id],   // 缺省唯一 tag（历史 overrides 不可考——roleId 路由等价）
          prompt: `你是 ${sug.id}——${sug.specialization ?? "专门"}角色（从 ${sug.parent} 分化）。分化理由：${sug.rationale ?? "任务分化诱导"}。按 PTC 模式用 ts 程序组合能力完成——done 提交实际产物。`,
          description: sug.specialization ?? `${sug.id}（分化自 ${sug.parent}）`,
          thinking: parentRole?.thinking ?? "medium",
          capabilities: [...(parentRole?.capabilities ?? []), "ext"],   // 扩展通道是执行面基础（developer 同款）——spider 需 ext.use(agent-reach)
          acceptanceRole: "writer",
          parent: sug.parent,
          generation: (parentRole?.generation ?? 0) + 1,
          differentiation: sug.rationale ?? `proposal ${e.id} 分化诱导（重建）`,
        };
        registerWorkerRole(role as never);
        recoveredRoles.push(role);
        await dataWorld.memory.write({
          id: `worker-role:${sug.id}`,
          kind: "worker-role",
          anchors: ["worker-role", sug.id],
          content: JSON.stringify(role),
          status: "official",
          meta: { source: "proposal-rebuild", role: sug.id, proposalId: e.id, rebuiltAt: Date.now() },
        }, { force: true });
        rebuilt++;
      } catch (e2) {
        assemblyLogger?.warn?.(`[assembly] proposal 重建失败 ${e.id}: ${(e2 as Error).message}`);
      }
    }
    if (rebuilt > 0) assemblyLogger?.info?.(`[assembly] proposal 重建角色 ${rebuilt} 个`);
  } catch { /* 容忍 */ }

  // 持久化扩展角色恢复（2026-08-12 审计 MEDIUM-8 修复：approve 注册的角色重启后恢复——
  // DB 谱系与源码谱系一致；registerWorkerRole 自动重建标签注册）
  try {
    const persisted = await dataWorld.memory.retrieve({ kinds: ["worker-role"], status: ["official"] });
    for (const e of persisted) {
      try {
        // H7：来源校验 + 结构校验——伪造 official 条目不得驱动装配注册
        const parsed = parseWorkerRoleRecovery({ content: e.content, meta: e.meta });
        if (!parsed.ok) {
          assemblyLogger?.warn?.(`[assembly] worker-role 恢复拒绝 ${e.id}: ${parsed.reason}`);
          continue;
        }
        if (allWorkerRoles().some((r) => r.id === parsed.value.id)) continue;
        registerWorkerRole(parsed.value as never);
        recoveredRoles.push(parsed.value as { id: string });
      } catch (e2) {
        assemblyLogger?.warn?.(`[assembly] worker-role 恢复失败 ${e.id}: ${(e2 as Error).message}`);
      }
    }
    if (persisted.length > 0) assemblyLogger?.info?.(`[assembly] 恢复持久化角色 ${persisted.length} 个（${persisted.map((e) => e.id.replace("worker-role:", "")).join(",")}）`);
  } catch { /* 表未就绪容忍——首次启动无表 */ }

  // worker-index 条目维护（2026-08-13：planner 的 worker 类型获取通道——ts 程序内可查；
  // eager prompt 注入走内存渲染——本条目供 memory.query 自助/lazy 模式）
  try {
    const { renderWorkerIndex } = await import("./execution/worker-cluster.js");
    await dataWorld.memory.write({
      id: "worker-index",
      kind: "worker-index",
      anchors: ["worker-index", "角色清单"],
      content: renderWorkerIndex(),
      status: "official",
      meta: { source: "assembly", updatedAt: Date.now() },
    }, { force: true });
  } catch { /* 容忍 */ }

  // 持久化子空间恢复（2026-08-13 鲁棒性：asp.create 注册的子空间重启后恢复——
  // 与 worker-role 对称——空间树不因重启丢失）
  try {
    const { spaceRegistry } = await import("./execution/space-registry.js");
    const spaces = await dataWorld.memory.retrieve({ kinds: ["space-reg"], status: ["official"] });
    let restored = 0;
    for (const e of spaces) {
      try {
        // H7：父空间必须存在 + execTool 白名单 + 结构校验
        const parsed = parseSpaceRecovery({ content: e.content, meta: e.meta }, (id) => !!spaceRegistry.get(id));
        if (!parsed.ok) {
          assemblyLogger?.warn?.(`[assembly] space-reg 恢复拒绝 ${e.id}: ${parsed.reason}`);
          continue;
        }
        const def = parsed.value;
        if (!spaceRegistry.get(def.id)) {
          spaceRegistry.register({
            id: def.id, kind: "action", parent: def.parent, execTool: def.execTool,
            extraTools: def.extraTools, memoryScope: def.memoryScope, description: def.description ?? "（恢复）",
            // 治理继承：从父空间继承（与 asp.create 同步）
            allowChildren: spaceRegistry.get(def.parent)?.allowChildren,
            maxDepth: spaceRegistry.get(def.parent)?.maxDepth,
            // 2026-08-14 N8：绑定透传（生成即绑定）——存量条目缺字段 → 继承父绑定（兼容）
            bindRoles: def.bindRoles ?? spaceRegistry.get(def.parent)?.bindRoles,
          });
          restored++;
        }
      } catch (e2) {
        assemblyLogger?.warn?.(`[assembly] space-reg 恢复失败 ${e.id}: ${(e2 as Error).message}`);
      }
    }
    if (restored > 0) assemblyLogger?.info?.(`[assembly] 恢复持久化子空间 ${restored} 个`);
  } catch { /* 容忍 */ }

  // 单大 batch 默认（2026-08-09）：启动即拉 1 个全量构成 batch——worker 级控制为主，
  // batch add/remove 降级为特殊手段。构成 = PTH_WORKER_ROLES 展开（不设置 = 7×1）。
  try {
    const handle = await batchManager.spawnBatch();
    assemblyLogger?.info?.(`[assembly] 默认 batch 已启动（pid=${handle.pid} workers=${handle.workers.length}）`);
    // 恢复角色热上线（2026-08-13：proposal 重建/worker-role 恢复的角色不在默认构成——
    // 同 approve 流程 batchesSent——广播 role-register 即刻接任务）
    // 延迟 1s：spawnBatch resolve 时子进程 IPC 监听可能未就绪（启动竞态——消息丢失实测）
    await new Promise((r) => setTimeout(r, 1000));
    for (const role of recoveredRoles) {
      try {
        const sent = batchManager.registerRoleToBatches(role as unknown as Record<string, unknown>);
        if (sent > 0) assemblyLogger?.info?.(`[assembly] 恢复角色热上线 ${role.id}（${sent} batch）`);
      } catch { /* 容忍 */ }
    }
  } catch (e) {
    assemblyLogger?.error?.(`[assembly] 默认 batch 启动失败（可手动 batch add）: ${(e as Error).message}`);
  }

  // trigger 统一化（2026-08-16）：全部系统控制环收编为 trigger 调度指令（原生 action）。
  // claim-reaper / batch-watchdog / flow-resolver / optimizer-deopt-sweep / batch-scaler /
  // origin-escalation / memory-sweep 在此集中注册；PerfAutopilot 在 main.ts 注册（依赖 metrics registry）。
  // 周期 env 语义与旧硬定时器一致：PTH_CLAIM_REAP_MS / PTH_WATCHDOG_INTERVAL_MS /
  // PTH_RESOLVER_INTERVAL_MS / PTH_VERIFY_SWEEP_MS / PTH_BATCH_SCALE_INTERVAL_MS。
  const claimTimeoutMs = resolveClaimTimeoutMs();
  const claimReapMs = pthConfig().num("PTH_CLAIM_REAP_MS");
  const scalerCfg = loadScalerConfig(process.env);
  const autoscaleMode = pthConfig().str("PTH_AUTOSCALE_MODE") as "balanced" | "reinforced";
  const scalerLogger = createKernelLogger();
  registerSystemTriggers(triggerEngine, {
    env: opts.env ?? process.env,
    recoverStaleClaims: (timeoutMs) => dataWorld.tasks.recoverStaleClaims(timeoutMs),
    claimTimeoutMs,
    claimReapMs,
    watchdogProbe: () => watchdog.probe(),
    watchdogIntervalMs: opts.watchdogIntervalMs ?? 30_000,
    resolverResolve: () => resolver.resolveLoop(),
    resolverIntervalMs: opts.resolverIntervalMs ?? 2_000,
    optimizerSweep: {
      enabled: pthConfig().str("PTH_OPTIMIZER") !== "off",
      intervalMs: pthConfig().num("PTH_VERIFY_SWEEP_MS"),
      broadcast: () => batchManager.broadcastOptimizerSweep(),
    },
    scaler: {
      enabled: scalerCfg.enabled,
      intervalMs: scalerCfg.intervalMs,
      evaluate: () => evaluateAndScale(
        {
          countPending: () => dataWorld.tasks.countPending(),
          batchCount: async () => (await batchManager.listBatches()).length,
          avgIdleRatio: async () => {
            const bs = await batchManager.listBatches();
            if (bs.length === 0) return 1;
            return bs.reduce((s, b) => s + (b.idleRatio ?? 1), 0) / bs.length;
          },
          spawnBatch: () => batchManager.spawnBatch(),
          countPendingByRole: () => dataWorld.tasks.countPendingByRole(),
          spawnReinforced: (role, copies) => batchManager.spawnBatch({ mode: "reinforced", role, copies }),
          killOneIdle: async () => {
            const bs = await batchManager.listBatches();
            const idle = bs.find((b) => (b.idleRatio ?? 1) >= 1);
            if (!idle) return false;
            await batchManager.killBatch(idle.id);
            return true;
          },
          logger: (msg) => scalerLogger?.info(msg),
        },
        { min: scalerCfg.min, max: scalerCfg.max, upThreshold: scalerCfg.upThreshold, mode: autoscaleMode, roleThreshold: pthConfig().num("PTH_AUTOSCALE_ROLE_THRESHOLD"), reinforceCopies: pthConfig().num("PTH_AUTOSCALE_REINFORCE_COPIES") },
      ),
    },
    log: (m) => assemblyLogger.info(m),
  });

  // trigger 引擎启动（任务池就绪后——订阅活动事件流）
  await triggerEngine.start().catch((e) => assemblyLogger.warn(`trigger engine start failed: ${(e as Error).message}`));

  return {
    pool,
    dataWorld,
    batchManager,
    activityHub,
    triggerEngine,
    taskDispatchNotifier,
    watchdog,
    resolver,
    execChannel,
    shutdown: async () => {
      triggerEngine.stop();
      taskDispatchNotifier.stop();
      watchdog.stop();
      offMainBus();
      // resolver 由 flow-resolver trigger 驱动——stop() 终止 resolveLoop（无自调度链）
      (resolver as unknown as { stop?: () => void }).stop?.();
      await execChannel.shutdown();
      await pool.end();
    },
  };
}
