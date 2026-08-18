/**
 * agent-tools —— agent 循环的工具执行器表（工具面收敛 2026-08-09）。
 *
 * 终态双层结构（用户裁决）：
 *   动作工具（元工具）= ts.run / ts.eval / python.run / python.eval / bash.run / bash.eval / done
 *   能力函数（ts 程序内注入——capability 白名单）= memory.query/write · sql ·
 *     context/results（ts 核内对象）· llm.complete · web · fs
 *
 * 所有组合/联动在 ts 程序内完成（程序内一体化——零跨工具文本往返）；
 * 结果自动注册 ts 核内 results 对象（agent-loop 执行后调用 kernel.ts.registerResult）。
 */

import type { AgentToolId } from "./parse-agent-action.js";
import { buildDoc } from "../extensions/index.js";
import { buildToolSchemas } from "../ptc/tools.js";
import { AGENT_TOOLS, type AgentToolResult, type AgentToolCtx } from "./agent-tools-registry.js";
export { AGENT_TOOLS } from "./agent-tools-registry.js";
export type { AgentToolResult, AgentToolCtx } from "./agent-tools-registry.js";

export const AGENT_CAPABILITY_DOC = `ts 程序内的能力函数（await 调用；组合/联动在程序内完成——结果自动注册 results 对象）：
${buildDoc()}`;

/** 工具参数 JSON Schema 定义（OpenAI function 格式——原生 tool_calls 声明） */
// （2026-08-14 T3：pick.tools 动态工具选择协议已废弃——schema 移除，工具面不再动态收窄）
/** 工具参数 JSON Schema 定义（OpenAI function 格式——原生 tool_calls 声明）
 * （2026-08-14 A1 Phase 3 条目 10：由 ptc/tools.ts 工具契约注册表派生——单一真相源，
 *   与旧手写 35 条逐字节一致——ptc-tools 测试 golden 断言） */
const TOOL_SCHEMAS: Record<string, { description: string; properties: Record<string, unknown>; required: string[] }> = buildToolSchemas();

/** 单个执行器名 → 工具 schema（点形或下划线形均可——asp 工具含点需先转下划线查表） */
export function toolSchemaFor(executorKey: string): import("@earendil-works/pi-ai").Tool | null {
  const key = executorKey.replace(/_/g, ".");
  const s = TOOL_SCHEMAS[key];
  if (!s) return null;
  return { name: key.replace(/\./g, "_"), description: s.description, parameters: { type: "object", properties: s.properties, required: s.required } };
}

/** 族名展开（2026-08-11 元命令拆分）：execTool 族名下所有同族工具 schema。
 * ts/python/bash（族名）→ 族下全部工具（ts→ts_run+ts_eval；python→python_run+python_eval…）；
 * c_execute（含下划线=精确）→ [c_execute]。 */
export function toolsForExecTool(execTool: string): import("@earendil-works/pi-ai").Tool[] {
  const exact = toolSchemaFor(execTool);
  if (exact) return [exact];
  const family = execTool.replace(/_/g, ".");
  const out: import("@earendil-works/pi-ai").Tool[] = [];
  for (const key of Object.keys(TOOL_SCHEMAS)) {
    if (key.startsWith(`${family}.`)) {
      const s = toolSchemaFor(key);
      if (s) out.push(s);
    }
  }
  return out;
}

/** 工具族（2026-08-12 动作面裁剪——按角色目标最小化分组的单元）
 * 角色声明 actionTools 时按族/逐工具 id 白名单过滤 LLM 工具面——
 * in-tokens 削减（memory-stats 背 debug.* 定义的历史问题消除）。
 * 2026-08-14 N8：spaceMaint 族随 asp.create/destroy 退役移除——空间生成走治理通道
 * （spaceRegistry.createChild/unregister），worker 工具面不再有空间生成/注销。 */
export const TOOL_GROUPS: Record<string, string[]> = {
  execTs: ["ts.run", "ts.eval"],
  execPy: ["python.run", "python.eval"],
  execBash: ["bash.run", "bash.eval"],
  dev: ["dev.write", "dev.edit", "dev.build", "dev.run", "dev.save", "dev.list"],
  debug: ["debug.attach", "debug.breakpoint", "debug.continue", "debug.step", "debug.snapshot", "debug.evaluate", "debug.detach", "debug.sessions"],
  write: ["write.create", "write.edit", "write.read", "write.list", "write.save", "write.section"],
  nav: ["asp.cd", "asp.index", "memory.index"],
  cache: ["cache.load", "cache.index", "cache.cancel"],
};

/** ASP-only 工具（2026-08-15 审计 MEDIUM：执行面只在 ASP 模式内联实现，AGENT_TOOLS 无对应执行器）。
 * 非 ASP 模式的 schema/prompt 面剔除——schema 面与执行面同源（非 ASP 调 asp_cd/cache_* 只会落到 unknown-tool）。 */
export const ASP_ONLY_TOOLS = new Set(["asp.cd", "asp.index", "memory.index", "cache.load", "cache.index", "cache.cancel"]);

/** 工具面选项：asp=false 表示非 ASP 模式（剔除 ASP-only）；缺省保持全量（契约注册表面向后兼容） */
export interface ToolFaceOptions { asp?: boolean }

/** 展开工具族（组名 → 工具 id 列表；未知组名忽略——保持前向兼容） */
export function expandToolGroups(ids: string[]): string[] {
  const out: string[] = [];
  for (const id of ids) {
    if (TOOL_GROUPS[id]) out.push(...TOOL_GROUPS[id]);
    else out.push(id);
  }
  return out;
}

/** 按角色动作面过滤工具（actionTools 未声明/空 → 全量——向后兼容：扩展角色/自定义角色不受影响）
 *  opts.asp=false：剔除 ASP-only（非 ASP 模式 schema 与执行面同源——2026-08-15 审计 MEDIUM） */
export function filterToolSchemas(ids: string[] | undefined, opts: ToolFaceOptions = {}): typeof TOOL_SCHEMAS {
  const wanted = ids && ids.length > 0 ? new Set(expandToolGroups(ids)) : null;
  const out: typeof TOOL_SCHEMAS = {};
  for (const [name, s] of Object.entries(TOOL_SCHEMAS)) {
    if (opts.asp === false && ASP_ONLY_TOOLS.has(name)) continue;
    if (wanted && !wanted.has(name)) continue;
    out[name] = s;
  }
  return out;
}

/** 工具声明 → pi-ai Tool[]（OpenAI function 格式——Context.tools 原生 tool_calls）
 * name 去点（OpenAI tool name pattern ^[a-zA-Z0-9_-]+$——python.execute 非法 → python_execute）
 * actionTools 过滤：按角色白名单裁剪（缺省全量）。
 * opts.asp=false：非 ASP 模式——剔除 asp.cd/asp.index/memory.index/cache.*（执行面只在 ASP 内联）。 */
export function toolsToSchema(actionTools?: string[], opts: ToolFaceOptions = {}): import("@earendil-works/pi-ai").Tool[] {
  const schemas = filterToolSchemas(actionTools, opts);
  return Object.entries(schemas).map(([name, s]) => ({
    name: name.replace(/\./g, "_"),
    description: s.description,
    parameters: { type: "object", properties: s.properties, required: s.required },
  }));
}

/** 裁剪后的工具描述（prompt 注入面与 schema 同步——in-tokens 削减；done/输出模式为固定协议段）
 *  opts.asp=false：与 toolsToSchema(asp:false) 同步剔除 ASP-only。
 *  2026-08-15 审计 LOW：列表名用下划线形（与 OpenAI tool_calls 声明一致——命名一致性）；
 *  done 在固定协议段输出一次（schema 内 done 行跳过——去重）。 */
export function toolsDescription(actionTools?: string[], opts: ToolFaceOptions & { allowlist?: readonly string[] } = {}): string {
  const schemas = filterToolSchemas(actionTools, opts);
  const allowed = opts.allowlist && opts.allowlist.length > 0
    ? new Set(opts.allowlist.map((name) => name.replace(/_/g, ".")))
    : null;
  return `可用工具（每次输出一个 JSON 动作 {"thought":"...","action":{"tool":"<tool>","args":{...}}}）：
${Object.entries(schemas)
    .filter(([name]) => name !== "done")
    .filter(([name]) => !allowed || allowed.has(name))
    .map(([name, s]) => `- ${name.replace(/\./g, "_")}: ${s.description}`)
    .join("\n")}
- done: {result, summary?} —— 完成任务，result 为最终产出对象

输出模式（mode 可选——控制回填带宽）：default=完整；value-only=只回 value（大数据省 token）；errors-only=成功只回 ok 失败回全错（快速试错）；quiet=静默（状态准备不污染轨迹）`;
}

export const AGENT_TOOLS_DESCRIPTION = `可用工具（每次输出一个 JSON 动作 {"thought":"...","action":{"tool":"<tool>","args":{...}}}）：
- ts.run: {code, mode?} —— 【程序模式（优先）】执行完整 TypeScript 程序：可声明变量/多语句/控制流；await 调用 memory.query/memory.write/llm.complete/web.fetchText/fs.readText 等能力函数；读写 results/context 对象；return 值作为结果（组合多 kernel 一步完成）
- ts.eval: {code, mode?} —— 【单表达式求值】一行查询/计算（不声明变量——表达式值即结果）：await memory.query(...) 统计等
- python.run: {code, mode?} —— python 程序执行（_result = 值 回传）；python.eval: {code} —— 单表达式求值（值即结果）
- bash.run: {command, mode?} —— 命令序列；bash.eval: {command} —— 单条命令
- 【生产核·代码】dev.write/edit/build/run/save/list —— C 产物开发（asp.cd("dev")；编译类语言唯一入口）
- 【调试】debug.attach/breakpoint/continue/step/snapshot/evaluate/detach/sessions —— C 调试会话（句柄化 sessionId——状态在 sandbox）
- 【生产核·文档】write.create/edit/read/list/save/section —— 文档创作（asp.cd("write")；大纲→草稿→修订→定稿；section 章节组织）
- done: {result, summary?} —— 完成任务，result 为最终产出对象

输出模式（mode 可选——控制回填带宽）：default=完整；value-only=只回 value（大数据省 token）；errors-only=成功只回 ok 失败回全错（快速试错）；quiet=静默（状态准备不污染轨迹）`;
