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
import { buildDoc } from "../extensions/index.js";

export interface AgentToolResult {
  ok: boolean;
  value?: unknown;
  stdout?: string;
  stderr?: string;
  error?: string;
  truncated?: boolean;
  /** 输出模式标记（quiet 时轨迹记 [quiet]——agent-loop 用） */
  quiet?: boolean;
}

export interface AgentToolCtx {
  kernel: WorkerKernel;
  /** capability 白名单（web/state/fs/memory/llm/sql）——与 vm 注入同一份 */
  caps: Record<string, unknown>;
  /** 任务工作区（fs.task 落盘——ts 工具 cwd——自修改产物写 tasks/<id>/） */
  taskWorkspace?: string;
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

/**
 * 输出模式（③——LLM 控制感知带宽）：
 *   default     完整（现状）
 *   value-only  只回 value（省 token——大数据输出场景）
 *   errors-only 成功只回 ok，失败回完整错误（快速试错）
 *   quiet       静默（无轨迹——纯状态准备步骤）
 */
function applyOutputMode(r: AgentToolResult, mode: unknown): AgentToolResult {
  if (typeof mode !== "string" || mode === "default") return r;
  if (mode === "quiet") return { ok: r.ok, quiet: true, value: undefined, stdout: "", stderr: "" };
  if (mode === "errors-only") {
    if (r.ok) return { ok: true, value: undefined, stdout: "ok" };
    return r; // 失败全量（错误信息对修正必要）
  }
  if (mode === "value-only") {
    const v = r.value === undefined ? "" : truncate(JSON.stringify(r.value), 2000).text;
    return { ok: r.ok, value: r.value, stdout: v, stderr: "" };
  }
  return r; // 未知模式按 default
}

/** 工具表（元工具——id → 执行器） */
export const AGENT_TOOLS: Record<AgentToolId, AgentTool> = {
  "python.execute": async ({ kernel }, args) => {
    const r = await kernel.python.execute(str(args, "code"));
    if (!r.ok) return { ok: false, error: r.error?.message ?? "python execute failed" };
    const value = JSON.stringify(r.value ?? null);
    return applyOutputMode({ ok: true, value: r.value, stdout: truncate(value, 2000).text }, args["mode"]);
  },

  "bash.execute": async ({ kernel }, args) => {
    const r = await kernel.bash.execute(str(args, "command"));
    const out = truncate(r.stdout ?? "", 4000);
    return applyOutputMode(
      { ok: r.ok, value: r.ok ? r.stdout : undefined, stdout: out.text, stderr: r.stderr, truncated: out.truncated || (r as { truncated?: boolean }).truncated },
      args["mode"],
    );
  },

  ts: async ({ kernel, taskWorkspace }, args) => {
    const r = await kernel.ts.execute(str(args, "code"), { cwd: taskWorkspace ?? "/tmp" });
    if (!r.ok) return { ok: false, error: r.error?.message ?? "ts execute failed" };
    // PTC 程序模式：回填 return 值 + stdout（含中间输出——LLM 可诊断多步组合）
    const out = truncate(r.stdout ?? "", 4000);
    const value = JSON.stringify(r.value ?? null);
    const combined = [out.text, value !== "null" ? `返回值: ${value}` : ""].filter(Boolean).join("\n");
    return applyOutputMode(
      { ok: true, value: r.value, stdout: truncate(combined, 4000).text, truncated: out.truncated || (r as { truncated?: boolean }).truncated },
      args["mode"],
    );
  },

  // done 由 agent-loop 拦截（不执行）
  done: async () => ({ ok: true, value: null, stdout: "done" }),
};

/**
 * 能力函数文档（ts 程序内可用——喂给 LLM 的 system prompt）。
 * 元工具动作 → ts 程序；能力函数 → 程序内 await 调用。
 * 标准扩展包自动聚合（SPEC 2026-08-09——扩展自声明 doc）
 */
export const AGENT_CAPABILITY_DOC = `ts 程序内的能力函数（await 调用；组合/联动在程序内完成——结果自动注册 results 对象）：
${buildDoc()}`;

/** 工具动作描述（元工具面） */
/** 工具参数 JSON Schema 定义（OpenAI function 格式——原生 tool_calls 声明） */
const TOOL_SCHEMAS: Record<string, { description: string; properties: Record<string, unknown>; required: string[] }> = {
  "python.execute": {
    description: "在 python kernel 执行代码（sandbox）——返回 stdout/值",
    properties: { code: { type: "string", description: "python 代码" }, mode: { type: "string", enum: ["default", "value-only", "errors-only", "quiet"] } },
    required: ["code"],
  },
  "bash.execute": {
    description: "在 bash kernel 执行命令（sandbox）——返回 stdout",
    properties: { command: { type: "string", description: "shell 命令" }, mode: { type: "string", enum: ["default", "value-only", "errors-only", "quiet"] } },
    required: ["command"],
  },
  ts: {
    description: "在 ts kernel（vm 沙箱）执行程序——程序内可 await 调用能力函数（memory/llm/web/fs/python/bash/c/ext 等）；return 的值回填",
    properties: { code: { type: "string", description: "ts 程序（顶层 await 可用；return 对象作为结果）" }, mode: { type: "string", enum: ["default", "value-only", "errors-only", "quiet"] } },
    required: ["code"],
  },
  done: {
    description: "完成任务——提交最终产出对象（result 必填：实际产物——实现代码/写入的文件/计算结果等任意 JSON；缺少 result 或 result 为空会被拒绝并回填引导重新提交）【ASP：仅元空间可用】",
    properties: { result: { description: "最终产出对象（任意 JSON）——必填；须为实际产物（实现代码/写入的文件/计算结果），不能为空对象/空数组/空字符串" }, summary: { type: "string", description: "完成说明" } },
    required: ["result"],
  },
  "asp.cd": {
    description: "空间迁移（ASP 元工具）——cd 到目标空间。目标：meta（元空间）/ ts / python / bash / c。语言代码只能在对应动作空间执行；done 仅在元空间可用。",
    properties: { space: { type: "string", description: "目标空间 id（meta/ts/python/bash/c）" } },
    required: ["space"],
  },
  "asp.index": {
    description: "空间索引（ASP 元工具）——逐层展示空间的可达函数/可达数据。无参数 = 当前空间索引。mode: by-package（按扩展包展开）/ by-type（按变量/对象/函数展开）；space: 目标空间（缺省当前）。",
    properties: {
      mode: { type: "string", enum: ["by-package", "by-type"], description: "聚合模式（缺省 by-package）" },
      space: { type: "string", description: "目标空间 id（缺省当前空间）" },
    },
    required: [],
  },
  "memory.index": {
    description: "记忆空间索引（图导航——严格单跳）。无参=顶层视图（层/kind/tag 词表）；{tag} = 该 tag 关联条目清单；{id} = 条目的 tag 列表+摘要。",
    properties: {
      tag: { type: "string", description: "按 tag 查关联条目" },
      id: { type: "string", description: "按条目 id 查其 tag 出边" },
    },
    required: [],
  },
};

/** 单个执行器名 → 工具 schema（点形或下划线形均可——asp 工具含点需先转下划线查表） */
export function toolSchemaFor(executorKey: string): import("@earendil-works/pi-ai").Tool | null {
  const key = executorKey.replace(/_/g, ".");
  const s = TOOL_SCHEMAS[key];
  if (!s) return null;
  return { name: key.replace(/\./g, "_"), description: s.description, parameters: { type: "object", properties: s.properties, required: s.required } };
}

/** 工具声明 → pi-ai Tool[]（OpenAI function 格式——Context.tools 原生 tool_calls）
 * name 去点（OpenAI tool name pattern ^[a-zA-Z0-9_-]+$——python.execute 非法 → python_execute）
 */
export function toolsToSchema(): import("@earendil-works/pi-ai").Tool[] {
  return Object.entries(TOOL_SCHEMAS).map(([name, s]) => ({
    name: name.replace(/\./g, "_"),
    description: s.description,
    parameters: { type: "object", properties: s.properties, required: s.required },
  }));
}

export const AGENT_TOOLS_DESCRIPTION = `可用工具（每次输出一个 JSON 动作 {"thought":"...","action":{"tool":"<tool>","args":{...}}}）：
- ts: {code, mode?} —— 【程序模式（优先）】执行 TypeScript 程序：await 调用 python.execute/bash.execute/c.execute/c.saveUnit/c.executeUnit/c.listUnits/memory.query/memory.write/llm.complete/web.fetchText/fs.readText 等能力函数；读写 results/context 对象；return 值作为结果（组合多 kernel 一步完成）
- c.execute: {code, mode?} —— C 编译核快捷（sandbox 编译运行——源码内嵌字符串）
- c.executeUnit: {name, mode?} —— 命名编译单元（toolstore compiled-units/<name>.c——跨任务复用；c.saveUnit 保存）
- python.execute: {code, mode?} —— 单 kernel 快捷（简单步骤不必写程序）
- bash.execute: {command, mode?} —— 单 kernel 快捷
- done: {result, summary?} —— 完成任务，result 为最终产出对象

输出模式（mode 可选——控制回填带宽）：default=完整；value-only=只回 value（大数据省 token）；errors-only=成功只回 ok 失败回全错（快速试错）；quiet=静默（状态准备不污染轨迹）`;
