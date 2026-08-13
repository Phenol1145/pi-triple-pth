/**
 * extensions/types.ts —— 扩展包共享类型（2026-08-13 审计 P1：从 index.ts 抽出——杀 barrel 型循环依赖）。
 *
 * 子文件（memory/manage/context/model/perf/obs）与本 barrel 都从这里取类型——
 * 子文件不再 import index（运行时边 index→子文件 与类型边 子文件→index 的闭环断开）。
 */

import type { DataWorldAccess } from "../storage/index.js";
import type { Toolstore } from "../interpreter/toolstore.js";

export interface ExtContext {
  dataWorld: DataWorldAccess;
  toolstore?: Toolstore;
  /** 策略目录（perf.publish/apply/list——默认 toolstore/strategies） */
  strategiesDir?: string;
  /** ASP 会话空间引用（2026-08-10）：可见性盖章/过滤依赖当前空间——任务级会话状态（agent-loop cd 更新） */
  sessionRef?: { current: { currentSpace: string } | null };
}

export interface TsReplExtension {
  id: string;
  /** 注入 vm 的能力对象（键值合并进 capabilities——provide 返回空 = 无函数注入） */
  provide?(ctx: ExtContext): Record<string, unknown>;
  /** ts 核预置对象（vm context 初始化时创建——results/context/model 等会话状态） */
  seed?(): Record<string, unknown>;
  /** API 文档片段（自动聚合进 AGENT_CAPABILITY_DOC——LLM 可见） */
  doc: string;
}

export interface BuiltExtensions {
  /** 合并后的 vm 能力注入（provide 结果） */
  capabilities: Record<string, unknown>;
  /** ts 核预置对象（seed 结果——vm context 初始化） */
  seeds: Record<string, unknown>;
  /** 聚合能力文档（AGENT_CAPABILITY_DOC 数据源） */
  doc: string;
}
