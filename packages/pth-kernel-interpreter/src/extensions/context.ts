/**
 * extensions/context.ts —— context 扩展（标准扩展包成员）。
 * ts 核内工作台对象（跨步骤 KV）+ results 结果注册表（agent 状态——内部管理语言语义）。
 */

import type { TsReplExtension } from "./types.js";

export const contextExtension: TsReplExtension = {
  id: "context",
  seed: () => ({
    // 任务工作台：跨步骤 KV（context.my_key = ...；后续程序直接读）
    context: {},
    // 结果注册表：每步工具结果自动注册（results.result_N = {tool, value, stdout}）；程序可读写
    results: {},
  }),
  doc: `- results: ts 核内结果注册表对象——每步工具结果自动注册（results["result_N"] = {tool, value, stdout}）；程序内可读写（results.my_key = ...）
- context: ts 核内任务工作台对象——跨步骤 KV（context.my_key = ...；后续程序直接读）`,
};
