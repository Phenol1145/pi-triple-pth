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
  /** 产物单元存储（dev.save/dev.list——生产核单元管理） */
  toolstore?: import("../interpreter/toolstore.js").Toolstore;
  /** 调试会话接入（debug.*——缺省读 env PTH_SANDBOX_KERNEL_URL/SANDBOX_SHARED_SECRET；测试注入覆盖） */
  debugApi?: { url: string; secret: string };
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

// ─── 生产核（dev 空间）辅助（2026-08-11 探索核/生产核分立）───

/** 产物路径校验（任务工作区白名单）：相对路径、拒绝绝对/穿越——与 fs.task 同规则 */
function resolveArtifact(taskWorkspace: string | undefined, relPath: string): string {
  if (!taskWorkspace) throw new Error("dev: 任务工作区未就绪（非任务上下文）");
  if (typeof relPath !== "string" || relPath.length === 0) throw new Error("dev: path 必填");
  if (relPath.startsWith("/") || relPath.startsWith("..") || relPath.includes("/../")) {
    throw new Error(`dev: 仅允许工作区相对路径（拒绝: ${relPath.slice(0, 60)}）`);
  }
  return `${taskWorkspace}/${relPath}`;
}

async function readArtifact(taskWorkspace: string | undefined, relPath: string): Promise<string> {
  const abs = resolveArtifact(taskWorkspace, relPath);
  const { readFile } = await import("node:fs/promises");
  try {
    return await readFile(abs, "utf-8");
  } catch {
    throw new Error(`dev: 产物不存在或不可读: ${relPath}（先 dev.write 创建）`);
  }
}

/** debug 会话调用（PTH → sandbox /kernel/debug/*——句柄化：状态在 sandbox 会话 Map，上限 4/idle 30min） */
async function debugCall(ctx: AgentToolCtx, op: string, body: Record<string, unknown>): Promise<unknown> {
  const url = ctx.debugApi?.url ?? process.env.PTH_SANDBOX_KERNEL_URL ?? "http://sandbox:8080";
  const secret = ctx.debugApi?.secret ?? process.env.SANDBOX_SHARED_SECRET ?? "";
  const r = await fetch(`${url.replace(/\/+$/, "")}/kernel/debug/${op}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`debug.${op} failed (${r.status}): ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return text; }
}

/** 工具表（元工具——id → 执行器） */
export const AGENT_TOOLS: Record<AgentToolId, AgentTool> = {
  "python.run": async ({ kernel }, args) => {
    const r = await kernel.python.execute(str(args, "code"), { exec: "program" });
    if (!r.ok) return { ok: false, error: r.error?.message ?? "python execute failed" };
    const value = JSON.stringify(r.value ?? null);
    return applyOutputMode({ ok: true, value: r.value, stdout: truncate(value, 2000).text }, args["mode"]);
  },

  "python.eval": async ({ kernel }, args) => {
    const r = await kernel.python.execute(str(args, "code"), { exec: "single" });
    if (!r.ok) return { ok: false, error: r.error?.message ?? "python eval failed" };
    const value = JSON.stringify(r.value ?? null);
    return applyOutputMode({ ok: true, value: r.value, stdout: truncate(value, 2000).text }, args["mode"]);
  },

  "bash.run": async ({ kernel }, args) => {
    const r = await kernel.bash.execute(str(args, "command"));
    const out = truncate(r.stdout ?? "", 4000);
    return applyOutputMode(
      { ok: r.ok, value: r.ok ? r.stdout : undefined, stdout: out.text, stderr: r.stderr, truncated: out.truncated || (r as { truncated?: boolean }).truncated },
      args["mode"],
    );
  },

  "bash.eval": async ({ kernel }, args) => {
    const r = await kernel.bash.execute(str(args, "command"));
    const out = truncate(r.stdout ?? "", 4000);
    return applyOutputMode(
      { ok: r.ok, value: r.ok ? r.stdout : undefined, stdout: out.text, stderr: r.stderr, truncated: out.truncated || (r as { truncated?: boolean }).truncated },
      args["mode"],
    );
  },

  // 元命令拆分（2026-08-11 用户裁决）：ts.run = 程序执行（块包装——声明/多语句/控制流）；
  // ts.eval = 单表达式求值（return 包装——completion value 必回）。显式声明取代启发式猜测。
  "ts.run": async ({ kernel, taskWorkspace }, args) => {
    const r = await kernel.ts.execute(str(args, "code"), { cwd: taskWorkspace ?? "/tmp", exec: "program" });
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

  "ts.eval": async ({ kernel, taskWorkspace }, args) => {
    const r = await kernel.ts.execute(str(args, "code"), { cwd: taskWorkspace ?? "/tmp", exec: "single" });
    if (!r.ok) return { ok: false, error: r.error?.message ?? "ts eval failed" };
    // 单表达式求值：value 即结果（stdout 冗余裁剪）
    const value = JSON.stringify(r.value ?? null);
    const out = truncate(r.stdout ?? "", 2000);
    const combined = [out.text, value !== "null" ? `结果: ${value}` : ""].filter(Boolean).join("\n");
    return applyOutputMode(
      { ok: true, value: r.value, stdout: truncate(combined, 2000).text, truncated: out.truncated },
      args["mode"],
    );
  },

  // ─── 生产核·代码产物（dev 空间——2026-08-11 探索核/生产核分立：编译类语言唯一入口）───
  "dev.write": async (ctx, args) => {
    const abs = resolveArtifact(ctx.taskWorkspace, str(args, "path"));
    const { writeFile, mkdir } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdir(dirname(abs), { recursive: true });
    const code = str(args, "code");
    await writeFile(abs, code, "utf-8");
    return { ok: true, value: { path: str(args, "path") }, stdout: `已写入 ${str(args, "path")}（${code.length} 字符）` };
  },
  "dev.edit": async (ctx, args) => {
    const abs = resolveArtifact(ctx.taskWorkspace, str(args, "path"));
    const content = await readArtifact(ctx.taskWorkspace, str(args, "path"));
    const oldText = str(args, "oldText"), newText = str(args, "newText");
    const hits = content.split(oldText).length - 1;
    if (hits === 0) return { ok: false, error: `dev.edit: oldText 未匹配（${str(args, "path")}）` };
    if (hits > 1) return { ok: false, error: `dev.edit: oldText 匹配 ${hits} 处——需唯一（提供更多上下文）` };
    const { writeFile } = await import("node:fs/promises");
    await writeFile(abs, content.replace(oldText, newText), "utf-8");
    return { ok: true, value: { path: str(args, "path") }, stdout: `已编辑 ${str(args, "path")}（1 处替换）` };
  },
  "dev.build": async (ctx, args) => {
    if (!ctx.kernel.c) return { ok: false, error: "dev.build: C 编译核不可用（sandbox 未配置）" };
    const code = await readArtifact(ctx.taskWorkspace, str(args, "path"));
    const r = await ctx.kernel.c.execute(code, { buildOnly: true } as never);
    if (!r.ok) return { ok: false, error: r.error?.message ?? "编译失败" };
    return { ok: true, value: r.value, stdout: `编译成功（${str(args, "path")}）` };
  },
  "dev.run": async (ctx, args) => {
    if (!ctx.kernel.c) return { ok: false, error: "dev.run: C 编译核不可用（sandbox 未配置）" };
    const code = await readArtifact(ctx.taskWorkspace, str(args, "path"));
    const r = await ctx.kernel.c.execute(code, { timeoutMs: args.timeoutMs as number | undefined } as never);
    if (!r.ok) return { ok: false, error: r.error?.message ?? "运行失败" };
    const out = truncate(r.stdout ?? "", 4000);
    return applyOutputMode({ ok: true, value: r.value, stdout: out.text, stderr: (r.stderr ?? "").slice(0, 2000), truncated: out.truncated }, args["mode"]);
  },
  "dev.save": async (ctx, args) => {
    if (!ctx.toolstore) return { ok: false, error: "dev.save: toolstore 未配置" };
    const name = str(args, "name");
    if (!/^[\w.-]+$/.test(name)) return { ok: false, error: `dev.save: 非法单元名 "${name}"（限 [a-zA-Z0-9_.-]）` };
    const code = await readArtifact(ctx.taskWorkspace, str(args, "path"));
    await ctx.toolstore.writeText(`compiled-units/${name}.c`, code);
    return { ok: true, value: { name }, stdout: `已保存编译单元 ${name}（${code.length} 字符——跨任务复用）` };
  },
  "dev.list": async (ctx) => {
    if (!ctx.toolstore) return { ok: false, error: "dev.list: toolstore 未配置" };
    const files = await ctx.toolstore.listSubdir("compiled-units");
    const units = files.filter((f) => f.endsWith(".c")).map((f) => f.slice(0, -2));
    return { ok: true, value: units, stdout: units.length ? units.join("\n") : "（无编译单元）" };
  },
  // ─── 调试会话（debug 族——句柄化：sessionId 字符串，状态在 sandbox 会话 Map）───
  "debug.attach": async (ctx, args) => {
    let code = args.code as string | undefined;
    if (!code && typeof args.path === "string") code = await readArtifact(ctx.taskWorkspace, args.path);
    if (!code) return { ok: false, error: "debug.attach: code 或 path 必填其一" };
    try {
      const r = (await debugCall(ctx, "attach", { code, cc: args.cc })) as { sessionId: string };
      return { ok: true, value: r, stdout: `调试会话已建立: ${r.sessionId}（编译 -g 调试版——后续操作传 sessionId；用完 debug.detach 释放）` };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  },
  "debug.breakpoint": async (ctx, args) => {
    try {
      const r = await debugCall(ctx, "breakpoint", { sessionId: str(args, "sessionId"), line: args.line, condition: args.condition });
      return { ok: true, value: r, stdout: JSON.stringify(r) };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  },
  "debug.continue": async (ctx, args) => {
    try {
      const r = (await debugCall(ctx, "continue", { sessionId: str(args, "sessionId") })) as { reason?: string; frame?: unknown };
      return { ok: true, value: r, stdout: r.reason === "exited" ? "程序已退出（未命中断点）" : `命中: ${JSON.stringify(r.frame ?? r)}` };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  },
  "debug.step": async (ctx, args) => {
    try {
      const r = await debugCall(ctx, "step", { sessionId: str(args, "sessionId"), direction: str(args, "direction") });
      return { ok: true, value: r, stdout: truncate(JSON.stringify(r), 500).text };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  },
  "debug.snapshot": async (ctx, args) => {
    // 聚合接口（ADI 思想——一次调用拿全帧+顶层帧变量；sandbox 原生 snapshot 端点后续）
    const sessionId = str(args, "sessionId");
    try {
      const frames = (await debugCall(ctx, "stack", { sessionId })) as Array<{ id?: number; frameId?: number }>;
      const top = frames[0];
      const variables = top ? await debugCall(ctx, "variables", { sessionId, frameId: top.frameId ?? top.id ?? 0 }) : [];
      return { ok: true, value: { frames, variables }, stdout: truncate(JSON.stringify({ frames, variables }), 3000).text };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  },
  "debug.evaluate": async (ctx, args) => {
    try {
      const r = await debugCall(ctx, "evaluate", { sessionId: str(args, "sessionId"), expr: str(args, "expr"), frameId: args.frameId });
      return { ok: true, value: r, stdout: JSON.stringify(r) };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  },
  "debug.detach": async (ctx, args) => {
    try {
      await debugCall(ctx, "detach", { sessionId: str(args, "sessionId") });
      return { ok: true, stdout: `会话 ${str(args, "sessionId")} 已释放` };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  },
  "debug.sessions": async (ctx) => {
    try {
      const r = await debugCall(ctx, "sessions", {});
      return { ok: true, value: r, stdout: JSON.stringify(r) };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
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
  "python.run": {
    description: "在 python kernel（sandbox 持久 REPL）执行程序——可多语句/声明/循环；设 _result = 值 回传结构化值（与 ts return 对齐）。",
    properties: { code: { type: "string", description: "python 程序（多语句；_result = 值 作为结果）" }, mode: { type: "string", enum: ["default", "value-only", "errors-only", "quiet"] } },
    required: ["code"],
  },
  "python.eval": {
    description: "在 python kernel 求值单个表达式（不写语句——一行计算/查询；表达式值即结果）。多语句/赋值请用 python.run。",
    properties: { code: { type: "string", description: "python 表达式（值即结果）" }, mode: { type: "string", enum: ["default", "value-only", "errors-only", "quiet"] } },
    required: ["code"],
  },
  "bash.run": {
    description: "在 bash kernel（sandbox 持久会话）执行命令序列——可多命令串联（; && || 换行）；stdout 即结果。",
    properties: { command: { type: "string", description: "shell 命令（可多命令串联）" }, mode: { type: "string", enum: ["default", "value-only", "errors-only", "quiet"] } },
    required: ["command"],
  },
  "bash.eval": {
    description: "在 bash kernel 执行单条命令（简单命令——ls/cat/grep 等；stdout 即结果）。复杂脚本/串联请用 bash.run。",
    properties: { command: { type: "string", description: "单条 shell 命令" }, mode: { type: "string", enum: ["default", "value-only", "errors-only", "quiet"] } },
    required: ["command"],
  },
  "ts.run": {
    description: "【程序模式（优先）】在 ts kernel（vm 沙箱）执行完整 TypeScript 程序——程序内可 await 调用能力函数（memory/llm/web/fs/python/bash/c/ext 等），可声明变量/多语句/控制流；return 的值回填；尾表达式自动捕获。【效率规则】查询/读取大内容一次取回后立即在程序内本地处理（切片/过滤/聚合都在程序里做）——不要多次调用重复分片读取同一内容；一个程序可组合多个能力调用，无需拆成多次工具调用",
    properties: { code: { type: "string", description: "ts 程序（顶层 await 可用；声明/多语句/控制流；return 对象作为结果）" }, mode: { type: "string", enum: ["default", "value-only", "errors-only", "quiet"] } },
    required: ["code"],
  },
  "ts.eval": {
    description: "【单表达式求值】在 ts kernel 计算单个表达式并返回结果（不声明变量——一行查询/计算：await memory.query(...)、count 统计等；表达式值即结果）。多步骤/声明变量/循环请用 ts.run。",
    properties: { code: { type: "string", description: "ts 单表达式（顶层 await 可用；表达式的值即结果）" }, mode: { type: "string", enum: ["default", "value-only", "errors-only", "quiet"] } },
    required: ["code"],
  },
  done: {
    description: "完成任务——提交最终产出对象（result 必填：实际产物——实现代码/写入的文件/计算结果等任意 JSON；缺少 result 或 result 为空会被拒绝并回填引导重新提交）【ASP：仅元空间可用】",
    properties: { result: { description: "最终产出对象（任意 JSON）——必填；须为实际产物（实现代码/写入的文件/计算结果），不能为空对象/空数组/空字符串" }, summary: { type: "string", description: "完成说明" } },
    required: ["result"],
  },
  "dev.write": {
    description: "【生产核】写产物代码到任务工作区（path 相对路径——自动建目录）。产物开发第一步",
    properties: { path: { type: "string", description: "工作区相对路径（如 main.c）" }, code: { type: "string", description: "完整源码" }, mode: { type: "string" } },
    required: ["path", "code"],
  },
  "dev.edit": {
    description: "【生产核】编辑产物（oldText 唯一匹配替换——不匹配/多处匹配报错）",
    properties: { path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" }, mode: { type: "string" } },
    required: ["path", "oldText", "newText"],
  },
  "dev.build": {
    description: "【生产核】编译产物（不运行——验证编译错误；C: gcc/clang/tcc）",
    properties: { path: { type: "string" }, cc: { type: "string" }, mode: { type: "string" } },
    required: ["path"],
  },
  "dev.run": {
    description: "【生产核】编译并运行产物（sha256 缓存——源码不变秒回；返回 stdout/value）",
    properties: { path: { type: "string" }, cc: { type: "string" }, timeoutMs: { type: "number" }, mode: { type: "string" } },
    required: ["path"],
  },
  "dev.save": {
    description: "【生产核】保存为命名编译单元（toolstore compiled-units/<name>.c——跨任务复用）",
    properties: { name: { type: "string" }, path: { type: "string" }, mode: { type: "string" } },
    required: ["name", "path"],
  },
  "dev.list": {
    description: "【生产核】列出已保存编译单元",
    properties: { mode: { type: "string" } },
    required: [],
  },
  "debug.attach": {
    description: "【调试】建立 C 调试会话（编译 -g + gdb——返回 sessionId 句柄；code 源码或 path 工作区文件二选一）",
    properties: { code: { type: "string" }, path: { type: "string" }, cc: { type: "string" }, mode: { type: "string" } },
    required: [],
  },
  "debug.breakpoint": {
    description: "【调试】设断点（line 行号，condition 可选条件表达式）",
    properties: { sessionId: { type: "string" }, line: { type: "number" }, condition: { type: "string" }, mode: { type: "string" } },
    required: ["sessionId", "line"],
  },
  "debug.continue": {
    description: "【调试】继续执行到断点/退出（返回 reason + frame）",
    properties: { sessionId: { type: "string" }, mode: { type: "string" } },
    required: ["sessionId"],
  },
  "debug.step": {
    description: "【调试】单步（direction: into/over/out）",
    properties: { sessionId: { type: "string" }, direction: { type: "string" }, mode: { type: "string" } },
    required: ["sessionId", "direction"],
  },
  "debug.snapshot": {
    description: "【调试】聚合快照（一次拿全帧+顶层帧变量——断点命中后首选，省逐帧查询）",
    properties: { sessionId: { type: "string" }, mode: { type: "string" } },
    required: ["sessionId"],
  },
  "debug.evaluate": {
    description: "【调试】求值表达式（当前暂停位置上下文——验证假设）",
    properties: { sessionId: { type: "string" }, expr: { type: "string" }, frameId: { type: "number" }, mode: { type: "string" } },
    required: ["sessionId", "expr"],
  },
  "debug.detach": {
    description: "【调试】释放会话（用完必调——上限 4 会话）",
    properties: { sessionId: { type: "string" }, mode: { type: "string" } },
    required: ["sessionId"],
  },
  "debug.sessions": {
    description: "【调试】活动会话清单",
    properties: { mode: { type: "string" } },
    required: [],
  },
  "asp.cd": {
    description: "空间迁移（ASP 元工具）——cd 到目标空间。目标必须已注册（内置：meta 元空间/ts/python/bash/c；asp.create 生成的自定义子空间亦可）。语言代码只能在对应动作空间执行；done 仅在元空间可用。",
    properties: { space: { type: "string", description: "目标空间 id（meta/ts/python/bash/c 或自定义注册空间）" } },
    required: ["space"],
  },
  "asp.create": {
    description: "空间生成（ASP 元工具）——注册一个自定义动作空间（数据驱动：新空间=一条注册记录，即可被 asp.cd 进入）。仅元空间可用。",
    properties: {
      id: { type: "string", description: "新空间 id（小写字母数字连字符）" },
      execTool: { type: "string", description: "该空间的语言执行工具名（LLM 原生工具面下划线形，如 custom_exec）" },
      skeleton: { type: "string", description: "语言骨架摘要（索引/prompt 用）" },
      description: { type: "string", description: "空间说明" },
    },
    required: ["id", "execTool", "description"],
  },
  "asp.destroy": {
    description: "空间注销（ASP 元工具）——注销自定义子空间（内置空间保护：parent=meta 或元空间本身不可注销）。仅元空间可用。",
    properties: { id: { type: "string", description: "要注销的空间 id" } },
    required: ["id"],
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
  "cache.load": {
    description: "载入随身缓存（跨空间携带——任何空间可 cache.get 引用）。来源：{id}/{ids}/{tag} 从记忆空间载入；或 {key, content} 直接载入自定义内容。硬容量限制——超容拒绝需先 cache.cancel。",
    properties: {
      id: { type: "string", description: "记忆条目 id" },
      ids: { type: "array", items: { type: "string" }, description: "批量条目 id" },
      tag: { type: "string", description: "按 tag 批量载入" },
      key: { type: "string", description: "自定义键（配合 content）" },
      content: { type: "string", description: "自定义内容（配合 key）" },
    },
    required: [],
  },
  "cache.index": {
    description: "随身缓存自检（条目键/大小/剩余容量）。",
    properties: {},
    required: [],
  },
  "cache.cancel": {
    description: "释放缓存条目（容量管理——腾位给更有价值的信息）。",
    properties: { key: { type: "string", description: "要释放的缓存键" } },
    required: ["key"],
  },
};

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
- ts.run: {code, mode?} —— 【程序模式（优先）】执行完整 TypeScript 程序：可声明变量/多语句/控制流；await 调用 python.run/bash.run/c.execute/c.saveUnit/c.executeUnit/c.listUnits/memory.query/memory.write/llm.complete/web.fetchText/fs.readText 等能力函数；读写 results/context 对象；return 值作为结果（组合多 kernel 一步完成）
- ts.eval: {code, mode?} —— 【单表达式求值】一行查询/计算（不声明变量——表达式值即结果）：await memory.query(...) 统计等
- c.execute: {code, mode?} —— C 编译核快捷（sandbox 编译运行——源码内嵌字符串）
- c.executeUnit: {name, mode?} —— 命名编译单元（toolstore compiled-units/<name>.c——跨任务复用；c.saveUnit 保存）
- python.run: {code, mode?} —— python 程序执行（_result = 值 回传）；python.eval: {code} —— 单表达式求值（值即结果）
- bash.run: {command, mode?} —— 命令序列；bash.eval: {command} —— 单条命令
- done: {result, summary?} —— 完成任务，result 为最终产出对象

输出模式（mode 可选——控制回填带宽）：default=完整；value-only=只回 value（大数据省 token）；errors-only=成功只回 ok 失败回全错（快速试错）；quiet=静默（状态准备不污染轨迹）`;
