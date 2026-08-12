/**
 * extensions/index.ts —— ts REPL 标准扩展包（统一注册机制）。
 *
 * 设计（标准扩展包 SPEC 2026-08-09）：
 *   扩展 = { id, provide?, seed?, doc }——能力注入 + ts 核预置对象 + 文档自声明
 *   新扩展 = 一个模块 + 注册进 EXTENSIONS 表——能力与文档自动聚合
 * 成员：memory（查询/写入）/ context（工作台+results）/ model（会话模型状态）——
 *       perf/obs 为 Phase 3/4（SPEC 落地阶段）
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

import { memoryExtension } from "./memory.js";
import { manageExtension } from "./manage.js";
import { contextExtension } from "./context.js";
import { modelExtension } from "./model.js";
import { perfExtension } from "./perf.js";
import { obsExtension } from "./obs.js";

/** 注册表：新扩展 = 模块 + 加入此数组 */
export const EXTENSIONS: TsReplExtension[] = [memoryExtension, contextExtension, modelExtension, perfExtension, obsExtension, manageExtension];

export interface BuiltExtensions {
  /** 合并后的 vm 能力注入（provide 结果） */
  capabilities: Record<string, unknown>;
  /** ts 核预置对象（seed 结果——vm context 初始化） */
  seeds: Record<string, unknown>;
  /** 聚合能力文档（AGENT_CAPABILITY_DOC 数据源） */
  doc: string;
}

/** 构建扩展包：能力注入 + 预置对象 + 文档聚合 */
export function buildExtensions(ctx: ExtContext): BuiltExtensions {
  const capabilities: Record<string, unknown> = {};
  const seeds: Record<string, unknown> = {};
  const docs: string[] = [];
  for (const ext of EXTENSIONS) {
    if (ext.provide) Object.assign(capabilities, ext.provide(ctx));
    if (ext.seed) Object.assign(seeds, ext.seed());
    docs.push(ext.doc);
  }
  return { capabilities, seeds, doc: docs.join("\n") };
}

/** 仅 ts 核预置对象（ts-interpreter 构造用——不执行 provide） */
export function buildSeeds(): Record<string, unknown> {
  const seeds: Record<string, unknown> = {};
  for (const ext of EXTENSIONS) {
    if (ext.seed) Object.assign(seeds, ext.seed());
  }
  return seeds;
}

/** 仅聚合文档（agent-tools 的能力文档——不执行 provide） */
export function buildDoc(): string {
  return EXTENSIONS.map((e) => e.doc).join("\n");
}
