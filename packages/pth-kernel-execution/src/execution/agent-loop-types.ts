/**
 * agent-loop-types.ts —— agent 循环输入/输出类型（模块专项 ② 大文件拆分：自 agent-loop.ts 抽出）。
 */
import type { LlmFn } from "@away_from/pth-kernel-interpreter";
import type { WorkerKernel } from "@away_from/pth-kernel-interpreter";
import type { WorkerRole } from "./worker-cluster.js";
import type { AgentToolResult } from "./agent-tools.js";
import type { CommandFeedback } from "./command-feedback.js";
import type { CommandAdapterRegistry } from "./tool-command-adapters.js";
import type { UnifiedExecutionDispatcher } from "./execution-command.js";
import { PTH_DONE_SIGNAL_CODE } from "./agent-tool-types.js";
export { PTH_DONE_SIGNAL_CODE };

export interface AgentTaskInput {
  task: { title: string; text: string };
  /** 生命周期 P0：根目标（入口盖章/逐字传播；system prompt 注入【根目标】段——模态无关） */
  goal?: string;
  /** 生命周期 P1：发布者澄清（pauseAnswer 内容；重跑时 system prompt 注入【发布者澄清】段） */
  publisherClarification?: string;
  /** 任务工作区（fs.task 落盘——ts 工具 cwd） */
  taskWorkspace?: string;
  /** 产物单元存储（生产核 dev.save/dev.list——batch-process 透传） */
  toolstore?: import("@away_from/pth-kernel-interpreter").Toolstore;
  role?: WorkerRole;
}

export interface AgentLoopOptions {
  llm: LlmFn;
  kernel: WorkerKernel;
  /** capability 白名单（web/state/fs/memory）——与 vm 注入同一份 */
  caps: Record<string, unknown>;
  /** W0：当前任务 id（停滞告警定位；缺省仅 role/step） */
  taskId?: string;
  maxSteps?: number;
  timeoutMs?: number;
  logger?: (msg: string) => void;
  onStep?: (step: { n: number; tool: string; durationMs: number; ok: boolean; args?: string }) => void;
  /** 运行过程保留（2026-08-09）：轨迹事件流——task-loop 收集写 transcript（审计/复现/续跑） */
  onTrace?: (event: AgentTraceEvent) => void;
  /** ASP 模式（动作空间协议——2026-08-10）：当前空间状态机（初始元空间——语言工具门控/done 仅元空间）。
   *  ASP 状态机：compose 默认 PTH_ASP_MODE=on（全件落地——2026-08-11）；测试按需显式 asp:true/off */
  asp?: boolean;
  /** ASP 会话空间引用（kernel.sessionRef——memory 可见性盖章/过滤读取同一状态） */
  sessionRef?: { current: { currentSpace: string } | null };
  /** 随身缓存（任务级——task-loop 注入并与 vm cache 对象同源；缺省 loop 自建） */
  cache?: import("./cache-store.js").CacheStore;
  /** 任务级能力装配（Phase 3 条目 12——cache 收敛）：透传 runner caps
   *  （task-loop 构建——每 ts 程序执行前统一注入 vm；与越界预检同一机制） */
  capabilityInject?: Record<string, unknown>;
  /** N14 P2：tool-reg 注册表快照（任务开始冻结——T3 防线；缺省 = 注册面关闭） */
  toolRegistry?: import("@away_from/pth-kernel-interpreter").ToolRegSnapshot;
  /** N28 T6：Frozen task tool face；schema 暴露与执行授权使用同一 canonicalize 集合。 */
  toolAllowlist?: readonly string[];
  /** N14 P2：注册工具 agent 态执行缝 + 调用方上下文（穿透 runChild 同款——深度限 1） */
  toolRegExec?: {
    runChild?: import("@away_from/pth-kernel-interpreter").ToolRegRunChild;
    caller?: import("@away_from/pth-contracts").TaskDispatchContext;
  };
  /** TCE P3：Command 层注入（语言工具先过 CommandGateway 授权；缺省 = legacy 直执行） */
  commandGateway?: import("./execution-command.js").CommandGateway;
  /** TCE P3：Command 安全上下文（任务身份盖章） */
  commandContext?: import("./execution-command.js").CommandSecurityContext;
  /** TCE P5：Tool 层生成器产物（per-tool 工具面；合并进当前空间工具面） */
  extraTools?: ReadonlyArray<{
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  }>;
  /** Wave 2：Tool-Reg v2 command adapter registry（缺省 = 回退旧 executor 路径） */
  adapterRegistry?: CommandAdapterRegistry;
  /** Wave 2：Execute 层统一分发器（adapter 授权后执行；缺省 = 回退旧 executor 路径） */
  executionDispatcher?: UnifiedExecutionDispatcher;
}

/** 运行过程轨迹事件（结构化——transcript body 事件数组） */
export type AgentTraceEvent =
  | { type: "llm-call"; step: number; toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>; contentPreview: string; thinking?: string; usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number } }
  | { type: "tool-call"; step: number; tool: string; args: Record<string, unknown> }
  | { type: "tool-result"; step: number; tool: string; ok: boolean; durationMs: number; resultPreview: string; adapterId?: string; execKind?: "language" | "external" | "internal" | "agent"; target?: string; errorClass?: string; errorCode?: string; retryable?: boolean; feedback?: CommandFeedback; capabilityId?: string }
  | { type: "guard"; step: number; guard: "repeat-action" | "empty-done" | "empty-reply" | "unknown-tool" | "negative-loop" | "route-drift"; kind: "hit" | "guide" | "soft" | "hard"; count: number; limit: number }
  | { type: "finish"; ok: boolean; steps: number; error?: string; warning?: string; valuePreview?: string }
  | { type: "compression"; inputChars: number; outputChars: number }
  | { type: "cognitive-working-set"; phase: "start" | "finish"; taskId: string; directorySnapshotId: string; workerId: string; toolNames: string[]; memoryEntryIds: string[]; skillIndexIds: string[]; activeSkillIds: string[]; usage: { memoryEntries: number; memoryChars: number; skillIndexEntries: number; activeSkills: number; skillChars: number; tools: number }; omitted: Record<string, number>; retrievalTraceIds: string[] }
  | { type: "pulse-translate"; step: number; ok: boolean; error?: string; codeLength?: number }
  | { type: "pulse-result"; step: number; ok: boolean; error?: string; code?: string; durationMs: number; valuePreview?: string }
  | { type: "ptc-program"; step: number; iteration: number; program: string; reason?: string }
  | { type: "ptc-result"; step: number; iteration: number; ok: boolean; error?: string; errorClass?: string; errorCode?: string; retryable?: boolean; valuePreview?: string; stdoutPreview?: string; durationMs: number };

/**
 * 任务上下文快照（2026-08-25 上下文持久化 W-d）：system 常量在顶层只存一次；
 * snapshots 内 messages 已剔除 system 消息。reason=compaction 是压缩前的完整历史
 * （修补"循环内压缩 messages.length=0 后历史彻底丢失"的洞）；reason=final 是任务结束时的最终上下文。
 */
export interface AgentContextCapture {
  system?: string;
  snapshots: Array<{
    at: string;
    reason: "compaction" | "final";
    step?: number;
    messages: Array<{
      role: string;
      content: string;
      toolCallId?: string;
      toolName?: string;
      thinking?: string;
      toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
    }>;
  }>;
}

export type AgentTaskResult =
  | {
      ok: true;
      value: unknown;
      summary?: string;
      steps: number;
      warning?: string;
      compression?: import("./context-compaction.js").CompactionResult | null;
      /** 上下文快照（PTH_TRANSCRIPT_CONTEXT=off 时缺省） */
      contextCapture?: AgentContextCapture;
      /** pause 循环控制信号：agent 向发布者提问，任务进入 paused 状态等待回答。 */
      pause?: { question: string; context?: Record<string, unknown> };
      /** TCE P3：人类批准挂起信号（CommandGateway await-approval） */
      humanApproval?: { requestId: string };
    }
  | { ok: false; error: string; steps: number; compression?: import("./context-compaction.js").CompactionResult | null; contextCapture?: AgentContextCapture };

