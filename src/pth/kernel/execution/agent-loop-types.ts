/**
 * agent-loop-types.ts —— agent 循环输入/输出类型（模块专项 ② 大文件拆分：自 agent-loop.ts 抽出）。
 */
import type { LlmFn } from "../interpreter/llm-fn.js";
import type { WorkerKernel } from "../interpreter/index.js";
import type { WorkerRole } from "./worker-cluster.js";
import type { AgentToolResult } from "./agent-tools.js";

export interface AgentTaskInput {
  task: { title: string; text: string };
  /** 任务工作区（fs.task 落盘——ts 工具 cwd） */
  taskWorkspace?: string;
  /** 产物单元存储（生产核 dev.save/dev.list——batch-process 透传） */
  toolstore?: import("../interpreter/toolstore.js").Toolstore;
  role?: WorkerRole;
}

export interface AgentLoopOptions {
  llm: LlmFn;
  kernel: WorkerKernel;
  /** capability 白名单（web/state/fs/memory）——与 vm 注入同一份 */
  caps: Record<string, unknown>;
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
  toolRegistry?: import("./tool-registry.js").ToolRegSnapshot;
  /** N28 T6：Frozen task tool face；schema 暴露与执行授权使用同一 canonicalize 集合。 */
  toolAllowlist?: readonly string[];
  /** N14 P2：注册工具 agent 态执行缝 + 调用方上下文（穿透 runChild 同款——深度限 1） */
  toolRegExec?: {
    runChild?: import("./tool-registry.js").ToolRegRunChild;
    caller?: import("../../contracts/index.js").TaskDispatchContext;
  };
}

/** 运行过程轨迹事件（结构化——transcript body 事件数组） */
export type AgentTraceEvent =
  | { type: "llm-call"; step: number; toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>; contentPreview: string; thinking?: string; usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number } }
  | { type: "tool-call"; step: number; tool: string; args: Record<string, unknown> }
  | { type: "tool-result"; step: number; tool: string; ok: boolean; durationMs: number; resultPreview: string }
  | { type: "guard"; step: number; guard: "repeat-action" | "empty-done" | "empty-reply" | "unknown-tool" | "negative-loop"; kind: "hit" | "guide" | "soft" | "hard"; count: number; limit: number }
  | { type: "finish"; ok: boolean; steps: number; error?: string; warning?: string; valuePreview?: string }
  | { type: "cognitive-working-set"; phase: "start" | "finish"; taskId: string; directorySnapshotId: string; workerId: string; toolNames: string[]; memoryEntryIds: string[]; skillIndexIds: string[]; activeSkillIds: string[]; usage: { memoryEntries: number; memoryChars: number; skillIndexEntries: number; activeSkills: number; skillChars: number; tools: number }; omitted: Record<string, number>; retrievalTraceIds: string[] };

export type AgentTaskResult =
  | { ok: true; value: unknown; summary?: string; steps: number; warning?: string; compression?: import("./context-compaction.js").CompactionResult | null }
  | { ok: false; error: string; steps: number; compression?: import("./context-compaction.js").CompactionResult | null };

