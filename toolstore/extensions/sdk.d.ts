/**
 * 扩展开发 SDK 类型面（2026-08-12 完善）。
 *
 * 用法：扩展 index.ts 顶部加
 *   /// <reference path="./sdk.d.ts" />
 *   // @ts-check
 * 获得类型提示与检查（scripts/ext-check.ts 会做类型检查 + 装载冒烟）。
 *
 * 注意：index.ts 运行于 JS 环境（new Function eval）——禁止 TS 语法（as/interface/类型标注）——
 * 类型只用 JSDoc 注释标注（类型检查用、运行期剥离）。
 */

/** 子进程执行结果 */
interface PthExecResult {
  ok: boolean;
  stdout?: string;
  stderr?: string;
  error?: string;
  code?: number;
}

/** HTTP 获取结果 */
interface PthHttpResult {
  ok: boolean;
  status?: number;
  text?: string;
  bytes?: number;
  contentType?: string;
  error?: string;
}

/** 扩展上下文（能力白名单——2026-08-12 补标准通道 exec/http/db） */
interface PthExtContext {
  /** 记忆查询/写入（只读 SQL / 知识层自由写） */
  memory?: {
    query: (sql: string) => Promise<unknown>;
    write: (kind: string, content: string, opts?: unknown) => Promise<unknown>;
  };
  /** 文件读取（toolstore 内——路径受限） */
  fs?: {
    readText: (name: string) => Promise<string>;
    writeText?: (name: string, content: string) => Promise<void>;
  };
  /** LLM 补全 */
  llm?: { complete: (opts: unknown) => Promise<unknown> };
  /** C 执行核 */
  c?: { execute: (code: string, opts?: unknown) => Promise<unknown>; executeUnit?: (name: string) => Promise<unknown> };
  /** 子进程执行（受控：超时/输出上限——不要裸 import child_process） */
  exec?: (command: string, args?: string[], opts?: { cwd?: string; timeoutMs?: number; maxOutputBytes?: number }) => Promise<PthExecResult>;
  /** HTTP 只读获取（协议约束 https/本地——大小上限） */
  http?: { get: (url: string, opts?: { maxBytes?: number; timeoutMs?: number; headers?: Record<string, string> }) => Promise<PthHttpResult> };
  /** 只读数据库查询（白名单表 tasks/memory_entries/transcripts——键值对过滤防注入） */
  db?: {
    query: (table: "tasks" | "memory_entries" | "transcripts" | (string & {}), opts?: { where?: Record<string, string | number>; limit?: number }) => Promise<{ ok: boolean; rows?: unknown; error?: string }>;
  };
  /** 日志（batch 日志通道） */
  log?: (msg: string) => void;
}

/** 扩展工厂返回（contracts 实现） */
interface PthExtFactoryResult {
  /** 工具（agent 可用动作——名字建议 kebab-case 前缀域） */
  tools?: Record<string, (args: Record<string, unknown>, ctx?: unknown) => Promise<{ ok: boolean; result?: unknown; error?: string; rows?: unknown; meta?: unknown }>>;
  /** 能力（ts 程序内可用函数） */
  capabilities?: Record<string, (args: unknown) => Promise<unknown>>;
  /** 事件订阅（task.claim/task.submit/task.done/task.rejected） */
  events?: Record<string, (e: { payload?: Record<string, unknown>; taskId?: string; role?: string }) => void | Promise<void>>;
  /** 角色注册（谱系——registerWorkerRole 装载） */
  roles?: Array<{ id: string; tags: string[]; prompt: string; capabilities?: string[]; memoryScope?: "own" | "all" }>;
  /** 语言核 */
  kernels?: Array<{ language: string; create: (opts: unknown) => unknown }>;
  /** 调试适配器 */
  debugAdapters?: Array<{ language: string; create: (opts: unknown) => unknown }>;
}

/** 扩展工厂形态（module.exports = factory 或 export default factory）
 *  注意：只允许 Promise 返回（async 函数不能标注 union 返回类型——TS1065） */
type PthExtFactory = (ctx: PthExtContext) => Promise<PthExtFactoryResult>;
