/**
 * extensions/index.ts —— ts REPL 标准扩展包（统一注册机制）。
 *
 * 设计（标准扩展包 SPEC 2026-08-09）：
 *   扩展 = { id, provide?, seed?, doc }——能力注入 + ts 核预置对象 + 文档自声明
 *   新扩展 = 一个模块 + 注册进 EXTENSIONS 表——能力与文档自动聚合
 * 成员：memory（查询/写入）/ context（工作台+results）/ model（会话模型状态）——
 *       perf/obs 为 Phase 3/4（SPEC 落地阶段）
 */

// 共享类型抽出至 types.ts（2026-08-13 审计 P1——子文件从 types 取类型，杀 barrel 型循环）
import type { ExtContext, TsReplExtension, BuiltExtensions } from "./types.js";
export type { ExtContext, TsReplExtension, BuiltExtensions } from "./types.js";

import { memoryExtension } from "./memory.js";
import { manageExtension } from "./manage.js";
import { contextExtension } from "./context.js";
import { modelExtension } from "./model.js";
import { perfExtension } from "./perf.js";
import { obsExtension } from "./obs.js";

/** 注册表：新扩展 = 模块 + 加入此数组 */
export const EXTENSIONS: TsReplExtension[] = [memoryExtension, contextExtension, modelExtension, perfExtension, obsExtension, manageExtension];

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
