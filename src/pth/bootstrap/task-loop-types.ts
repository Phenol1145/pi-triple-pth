/**
 * task-loop-types.ts —— TaskLoop 依赖类型（模块专项 ② 大文件拆分：自 task-loop.ts 抽出）。
 */
import type { WorkerKernel } from "@away_from/pth-kernel-interpreter";
import type { Task, TaskStore } from "@away_from/pth-kernel-storage";
import type { WorkerRole, TaskWorkspaceManager, NetworkExecuteClient } from "@away_from/pth-kernel-execution";
import type { TaskRepository } from "@away_from/pth-contracts";
import type { KnowledgeContextProvider } from "../runner/index.js";
import type { SideEffectOutboxPort } from "@away_from/pth-kernel-storage";

export interface TaskLoopDeps {
  kernel: WorkerKernel;
  role: WorkerRole;
  taskStore: TaskStore;
  workspaceMgr: TaskWorkspaceManager;
  /** Refine 钩子（T4）：任务完成后快照+提炼+持久化。默认 undefined = 不 refine。 */
  refiner?: Pick<import("@away_from/pth-kernel-execution").Refiner, "refine">;
  /** 优化循环（2026-08-12 大项）：任务完成点收集 scorecard → 窗口检测 → 建议（draft）。默认 undefined = 不启用。 */
  optimizer?: Pick<import("@away_from/pth-kernel-execution").Optimizer, "collect">;
  /** 日志（日志体系 T2）：链路 ctx（taskId/role）自动携带 */
  logger?: import("@away_from/pth-kernel-execution").KernelLogger;
  /** 性能计量（SPEC L2）：任务事件 → IPC 转发主进程 */
  onTaskMetric?: (m: Record<string, unknown>) => void;
  /** 活动事件流（console --follow 数据源）：任务接取/agent step（含 token 用量）/完成——实时上报 */
  onActivity?: (e: { kind: string; taskId?: string; role?: string; workerId?: string; step?: number; tool?: string; ok?: boolean; usage?: { inputTokens?: number; outputTokens?: number }; detail?: string; chainDepth?: number; triggerId?: string }) => void;
  /** 运行过程保留（2026-08-09）：transcript store（agent 轨迹持久化） */
  transcripts?: { create(input: { taskId?: string; agentId: string; body: unknown[]; summary?: string }): Promise<string> };
  /** 自然语言任务转译（NL→代码）；undefined = 不转译（NL 任务直接 reject） */
  llm?: import("@away_from/pth-kernel-interpreter").LlmFn;
  /** agent 循环的 capability 白名单（web/state/fs/memory——与 vm 注入同一份） */
  agentCaps?: Record<string, unknown>;
  /** P1-6：注入即启用 tasking dispatcher 路径（claim→run→commit）；缺省走 legacy 兼容路径 */
  repository?: TaskRepository;
  /** 生命周期 P1：TaskSuspension 处理钩子（dispatcher 装配点注入；缺省仅跳过） */
  onSuspension?: (input: {
    lease: import("@away_from/pth-contracts").TaskLease;
    work: import("@away_from/pth-contracts").TaskWorkItem;
    suspension: import("@away_from/pth-contracts").TaskSuspension;
  }) => void | Promise<void>;
  /** TCE 网络 V1 Wave 2：Execute 客户端（透传 AgentTaskRunner）。 */
  networkExecute?: NetworkExecuteClient;
  /** TCE P3：Command 层注入（语言工具先过 CommandGateway 授权）。 */
  commandGateway?: import("@away_from/pth-kernel-execution").CommandGateway;
  /** TCE P5：Tool 层生成器产物（per-tool 工具面）。 */
  extraTools?: ReadonlyArray<{ name: string; description: string; parameters: Record<string, unknown> }>;
  /** Wave 2：Tool-Reg v2 command adapter registry（缺省 = 回退旧 executor 路径）。 */
  adapterRegistry?: import("@away_from/pth-kernel-execution").CommandAdapterRegistry;
  /** Wave 2：Execute 层统一分发器（adapter 授权后执行；缺省 = 回退旧 executor 路径）。 */
  executionDispatcher?: import("@away_from/pth-kernel-execution").UnifiedExecutionDispatcher;
  /** P1-6：归档钩子注入（BatchTaskLoop 组合用；缺省用 protected archive 默认实现） */
  archiveFn?: (task: Task, ws: { dir: string; tenant: string }, result: unknown) => Promise<void>;
  /** N14 P2：tool-reg 注册表读取口（任务开始冻结快照——T3 防线）；缺省 = 注册面关闭 */
  toolRegStore?: import("@away_from/pth-kernel-interpreter").ToolRegStoreLike;
  /** N14 P2：agent 态注册工具执行缝（穿透 runChild 同一闭包——深度限 1 由实现保证） */
  toolRegRunChild?: import("@away_from/pth-kernel-interpreter").ToolRegRunChild;
  /** K3：任务知识上下文 provider（batch-process 装配注入；缺省 = 关闭知识上下文） */
  knowledgeContextProvider?: KnowledgeContextProvider;
  /** F5：durable side-effect outbox（post-commit observer enqueue 用；缺省 = 关闭 outbox）。 */
  sideEffectOutbox?: SideEffectOutboxPort;
  /** F5：每轮 claim 前 kick 一次 side-effect drain（生产注入 drainer 回调；不阻塞 claim）。 */
  drainSideEffects?: () => void;
  /** N28 T2：运行时副本（仅在 feasibility 模式注入）；缺省 = 无副本身份（legacy 形状不变）。 */
  replica?: import("@away_from/pth-kernel-execution").WorkerReplica;
  /** N28 T6：feasibility 依赖透传（off 全部 undefined）。 */
  memoryDirectory?: import("../execution/index.js").MemoryDirectorySnapshot;
  cognitiveWorkingSetProvider?: import("../runner/index.js").CognitiveWorkingSetProvider;
  authorizedReads?: import("../runner/index.js").AuthorizedTaskReadFactory;
  verifiedReadScopeFactory?: import("../execution/index.js").VerifiedTaskReadScopeFactory;
  cognitiveResponsibilityMode?: "off" | "feasibility";
  /** Task 4：professional runtime registry / artifact port / grant service（注入后透传 AgentTaskRunner）。 */
  professionalRuntimeRegistry?: import("../execution/index.js").ProfessionalRuntimeRegistry;
  professionalArtifacts?: import("../runner/index.js").ProfessionalArtifactPort;
  professionalGrantService?: import("../execution/index.js").ExecutionGrantService;
  professionalGrantTtlMs?: number;
}

/**
 * 任务循环：peek → claim → 执行 → submit → 转录归档。
 * 语义（裁决 10/11）：peek 只读不锁定先于 claim；claim 即承诺（认领后必 execute 或 reject）；
 *   逐条判别式失败不中断；认领竞态（claimed-by-other）为正常。
 *
 * v1 裁剪（Spec B §5 标注）：机械认领全部候选，无 assess 智能判断——assess（llm.complete
 *   自检候选是否可完成）留 v2 注入。
 * 任务分配正交化（2026-08-08）：candidates 只返回 assigned_role = 自己的任务——
 *   零竞速抢票；零认领 = 自己队列空或全不可认领（坏任务），直接 return 下一轮
 *   （不再 reject assessed-as-unfit——正交化后不存在"更适合的角色"，放回池无意义）。
 */
