/**
 * agent-tools —— agent 循环的工具执行器表（工具面收敛 2026-08-09）。
 *
 * 终态双层结构（用户裁决）：
 *   动作工具（元工具）= ts / python.execute / bash.execute / done
 *   能力函数（ts 程序内注入——capability 白名单）= memory.query/write · sql ·
 *     context/results（ts 核内对象）· llm.complete · web · fs
 *
 * 所有组合/联动在 ts 程序内完成（程序内一体化——零跨工具文本往返）；
 * 结果自动注册 ts 核内 results 对象（agent-loop 执行后调用 kernel.ts.registerResult）。
 */

import type { WorkerKernel } from "../interpreter/index.js";
import type { AgentToolId } from "./parse-agent-action.js";

export interface AgentToolResult {
  ok: boolean;
  value?: unknown;
  stdout?: string;
  stderr?: string;
  error?: string;
  truncated?: boolean;
}

export interface AgentToolCtx {
  kernel: WorkerKernel;
  /** capability 白名单（web/state/fs/memory/llm/sql）——与 vm 注入同一份 */
  caps: Record<string, unknown>;
}

export type AgentTool = (ctx: AgentToolCtx, args: Record<string, unknown>) => Promise<AgentToolResult>;

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string") throw new Error(`agent tool: 参数 ${key} 需为字符串`);
  return v;
}

function truncate(s: string, max = 2000): { text: string; truncated: boolean } {
  if (s.length <= max) return { text: s, truncated: false };
  return { text: s.slice(0, max) + `…(截断 ${s.length - max} 字符)`, truncated: true };
}

/** 工具表（元工具——id → 执行器） */
export const AGENT_TOOLS: Record<AgentToolId, AgentTool> = {
  "python.execute": async ({ kernel }, args) => {
    const r = await kernel.python.execute(str(args, "code"));
    if (!r.ok) return { ok: false, error: r.error?.message ?? "python execute failed" };
    const value = JSON.stringify(r.value ?? null);
    return { ok: true, value: r.value, stdout: truncate(value, 2000).text };
  },

  "bash.execute": async ({ kernel }, args) => {
    const r = await kernel.bash.execute(str(args, "command"));
    const out = truncate(r.stdout ?? "", 4000);
    return { ok: r.ok, value: r.ok ? r.stdout : undefined, stdout: out.text, stderr: r.stderr, truncated: out.truncated || (r as { truncated?: boolean }).truncated };
  },

  ts: async ({ kernel }, args) => {
    const r = await kernel.ts.execute(str(args, "code"), { cwd: "/tmp" });
    if (!r.ok) return { ok: false, error: r.error?.message ?? "ts execute failed" };
    // PTC 程序模式：回填 return 值 + stdout（含中间输出——LLM 可诊断多步组合）
    const out = truncate(r.stdout ?? "", 4000);
    const value = JSON.stringify(r.value ?? null);
    const combined = [out.text, value !== "null" ? `返回值: ${value}` : ""].filter(Boolean).join("\n");
    return { ok: true, value: r.value, stdout: truncate(combined, 4000).text, truncated: out.truncated || (r as { truncated?: boolean }).truncated };
  },

  // done 由 agent-loop 拦截（不执行）
  done: async () => ({ ok: true, value: null, stdout: "done" }),
};

/**
 * 能力函数文档（ts 程序内可用——喂给 LLM 的 system prompt）。
 * 元工具动作 → ts 程序；能力函数 → 程序内 await 调用。
 */
export const AGENT_CAPABILITY_DOC = `ts 程序内的能力函数（await 调用；组合/联动在程序内完成——结果自动注册 results 对象）：
- python.execute: {code} —— Python REPL（设 _result = 值 作为返回值；返回 { ok, value, stdout }）
- bash.execute: {command} —— Bash REPL（返回 { ok, stdout, stderr }）
- memory.query: {sql} —— 只读 SQL 查记忆库（仅 SELECT；自动 LIMIT）。memory_entries 表：id text, kind text('tool-function'|'task-insight'|'refine-report'|'dev-artifact'|'memory'), anchors jsonb, content text, status text('draft'|'official'|'archived'), version int, hit_count int, ttl_expires_at timestamptz, created_at timestamptz, updated_at timestamptz
- memory.write: {id?, kind, anchors, content} —— 写入记忆（沉淀）
- llm.complete: {user, system?, model?} —— 调用子 LLM
- web.fetchText: {url} —— 只读获取网页文本
- fs.readText: {path} / fs.list: {dir?} —— 工具文件只读
- results: ts 核内结果注册表对象——每步工具结果自动注册（results["result_N"] = {tool, value, stdout}）；程序内可读写（results.my_key = ...）
- context: ts 核内任务工作台对象——跨步骤 KV（context.my_key = ...；后续程序直接读）`;

/** 工具动作描述（元工具面） */
export const AGENT_TOOLS_DESCRIPTION = `可用工具（每次输出一个 JSON 动作 {"thought":"...","action":{"tool":"<tool>","args":{...}}}）：
- ts: {code} —— 【程序模式（优先）】执行 TypeScript 程序：await 调用 python.execute/bash.execute/memory.query/memory.write/llm.complete/web.fetchText/fs.readText 等能力函数；读写 results/context 对象；return 值作为结果（组合多 kernel 一步完成）
- python.execute: {code} —— 单 kernel 快捷（简单步骤不必写程序）
- bash.execute: {command} —— 单 kernel 快捷
- done: {result, summary?} —— 完成任务，result 为最终产出对象`;
