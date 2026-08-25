/**
 * runner/exec-modes/types.ts —— agent-task-runner 执行模式模块共享类型。
 */
import type { TaskLease, TaskOutcome, TaskWorkItem, WorkerReplicaRef } from "@away_from/pth-contracts";
import type { WorkerKernel, LlmFn } from "@away_from/pth-kernel-interpreter";
import type { WorkerRole } from "@away_from/pth-kernel-execution";
import type { AgentTraceEvent } from "@away_from/pth-kernel-execution";
import type { RunnerConfig } from "../runner-config.js";
import type { TaskWorkspace } from "../task-workspace.js";
import type { KnowledgeContextProvider } from "../knowledge-context.js";
import type { MemoryDirectorySnapshot, VerifiedTaskReadScopeFactory } from "../../execution/index.js";
import type { CognitiveWorkingSetProvider } from "../cognitive-working-set.js";
import type { AuthorizedTaskReadFactory } from "../authorized-task-reads.js";
import type { ExecutionGrantService, ProfessionalRuntimeRegistry } from "../../execution/index.js";
import type { ProfessionalArtifactPort } from "../professional-task-capability.js";

export interface AgentTaskRunnerDeps {
  kernel: WorkerKernel;
  role: WorkerRole;
  workspace: TaskWorkspace;
  /** 无 llm → 任务 rejected（与 task-loop 纯化语义一致） */
  llm?: LlmFn;
  /** agent 循环 capability 白名单（缺省空——agent 路径不可用，走降级通道） */
  caps?: Record<string, unknown>;
  config?: Partial<RunnerConfig>;
  /** 调用方持有的轨迹收集（runner 只写事件，不持久化） */
  onTrace?: (event: AgentTraceEvent) => void;
  onStep?: (step: { n: number; tool: string; durationMs: number; ok: boolean; args?: string }) => void;
  logger?: (msg: string) => void;
  /** N14 P2：tool-reg 注册表读取口（任务开始冻结快照——T3 防线）；缺省 = 注册面关闭 */
  toolRegStore?: import("@away_from/pth-kernel-interpreter").ToolRegStoreLike;
  /** N14 P2：agent 态注册工具执行缝（穿透 runChild 同一闭包——深度限 1 由实现保证） */
  toolRegRunChild?: import("@away_from/pth-kernel-interpreter").ToolRegRunChild;
  /** K3：任务知识上下文 provider（claim 后一次性快照；抛错 → logger warn + 原文执行，降级不阻塞） */
  knowledgeContextProvider?: KnowledgeContextProvider;
  /** N28 T4：本任务副本身份（feasibility 模式注入）。 */
  replica?: WorkerReplicaRef;
  /** N28 T4：每任务 mint 一次 verified scope 的 authority（缺失=legacy 路径）。 */
  verifiedReadScopeFactory?: VerifiedTaskReadScopeFactory;
  /** N28 T6：冻结 MemoryDirectory（feasibility 模式必填）。 */
  memoryDirectory?: MemoryDirectorySnapshot;
  /** N28 T6：working-set provider（feasibility 模式必填）。 */
  cognitiveWorkingSetProvider?: CognitiveWorkingSetProvider;
  /** N28 T6：认知责任模式（off=legacy 默认；feasibility=切片）。 */
  cognitiveResponsibilityMode?: "off" | "feasibility";
  /** N28 T6：grant-bound 任务读取工厂（feasibility 模式必填）。 */
  authorizedReads?: AuthorizedTaskReadFactory;
  /** Task 4：professional runtime registry（注入后任务内可用 professional.* capability）。 */
  professionalRegistry?: ProfessionalRuntimeRegistry;
  /** Task 4：artifact 端口（租户隔离输入读取/输出落盘）。 */
  professionalArtifacts?: ProfessionalArtifactPort;
  /** Task 4：签发 professional.execute grant 的服务（服务端签名/过期/replay）。 */
  professionalGrantService?: ExecutionGrantService;
  /** Task 4：professional grant TTL（缺省 120s）。 */
  professionalGrantTtlMs?: number;
  /** TCE P3：Command 层注入（语言工具先过 CommandGateway 授权；缺省 = legacy 直执行）。 */
  commandGateway?: import("@away_from/pth-kernel-execution").CommandGateway;
  /** TCE P5：Tool 层生成器产物（per-tool 工具面）。 */
  extraTools?: ReadonlyArray<{ name: string; description: string; parameters: Record<string, unknown> }>;
  /** Wave 2：Tool-Reg v2 command adapter registry（缺省 = 回退旧 executor 路径） */
  adapterRegistry?: import("@away_from/pth-kernel-execution").CommandAdapterRegistry;
  /** Wave 2：Execute 层统一分发器（adapter 授权后执行；缺省 = 回退旧 executor 路径） */
  executionDispatcher?: import("@away_from/pth-kernel-execution").UnifiedExecutionDispatcher;
  /** 2026-08-25 W-d：任务上下文快照汇集槽（runner 写入 AgentContextCapture；task-loop 持有并随 transcript 落盘） */
  contextSink?: unknown[];
  /** W-c：实时上下文注册钩子——调用方经 getter 惰性读取 agent 循环消息数组（__messages）。 */
  onContextReady?: (getter: () => unknown) => void;
}

export interface ExecModeContext {
  deps: AgentTaskRunnerDeps;
  lease: TaskLease;
  work: TaskWorkItem;
  config: RunnerConfig;
  traceId: string;
  ref: TaskOutcome["lease"];
  aborted: () => boolean;
}
