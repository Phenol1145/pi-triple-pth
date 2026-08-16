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
import { runPtcProgram } from "../ptc/runner.js";
import { buildToolSchemas } from "../ptc/tools.js";
import { pthConfig } from "../../config/index.js";

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
  /** 当前动作空间（记忆桥盖章——2026-08-12 批 3：语言执行带 space，kernel 层注入记忆访问可见性） */
  space?: string;
  /** 任务级能力装配（Phase 3 条目 12——cache 收敛）：runPtcProgram 统一注入 vm
   *  （task-loop → agent-loop → 本 ctx 透传；与越界预检同一机制） */
  ptcCaps?: Record<string, unknown>;
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
/**
 * asm-kernel 惰性注册（2026-08-12 asm 核接线——设计 §4 选项 b）：dev.build/dev.run 遇 .s/.S
 * 时从 toolstore 装载 asm-kernel 扩展（new Function eval——与 ext-capability 同通道——受信
 * toolstore 代码）→ registerKernel("asm")。WeakSet 防重复注册。C 核路径完全不受影响。
 */
const asmKernels = new WeakSet<object>();
async function ensureAsmKernel(ctx: { kernel: object; toolstore?: { readText: (p: string) => Promise<string> } }): Promise<{ ok: boolean; error?: string }> {
  if (asmKernels.has(ctx.kernel)) return { ok: true };
  if (!ctx.toolstore) return { ok: false, error: "asm-kernel: toolstore 未配置" };
  try {
    const code = await ctx.toolstore.readText("extensions/asm-kernel/index.js");
    const wrapped = `"use strict";
      const module = { exports: {} };
      const exports = module.exports;
      ${code}
      return module.exports.default ?? module.exports;`;
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function(wrapped)();
    const mod = typeof fn === "function" ? fn : (fn as { default?: unknown }).default;
    const ext = await (mod as (c: unknown) => Promise<{ kernels?: Array<{ language: string; create: (o: unknown) => unknown }>; create?: (o: unknown) => unknown }>)({ log: () => {} });
    const kern = (ext.kernels ?? []).find((k) => k.language === "asm");
    const kernel = kern ? kern.create({}) : ext.create?.({});
    if (!kernel || typeof (kernel as { execute?: unknown }).execute !== "function") {
      return { ok: false, error: "asm-kernel: 未找到 asm 核 execute 实现" };
    }
    (ctx.kernel as { registerKernel: (l: string, k: unknown) => void }).registerKernel("asm", kernel);
    asmKernels.add(ctx.kernel);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `asm-kernel 惰性注册失败: ${(e as Error).message}` };
  }
}

/** 扩展名分发判定（.s/.S——asm-kernel 生产核） */
const isAsmSource = (p: string): boolean => /\.s$/i.test(p);

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
  const url = ctx.debugApi?.url ?? pthConfig().str("PTH_SANDBOX_KERNEL_URL");
  const secret = ctx.debugApi?.secret ?? pthConfig().str("SANDBOX_SHARED_SECRET");
  // 超时（2026-08-12 审计：与 SandboxKernel.call 对齐——防 sandbox 无响应悬挂工具调用）
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 35_000);
  try {
    const r = await fetch(`${url.replace(/\/+$/, "")}/kernel/debug/${op}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`debug.${op} failed (${r.status}): ${text.slice(0, 300)}`);
    try { return JSON.parse(text); } catch { return text; }
  } catch (e) {
    if ((e as Error).name === "AbortError") throw new Error(`debug.${op} timed out after 35s（sandbox 无响应）`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** 工具表（元工具——id → 执行器） */
export const AGENT_TOOLS: Record<AgentToolId, AgentTool> = {
  "python.run": async ({ kernel, space }, args) => {
    const r = await kernel.python.execute(str(args, "code"), { exec: "program", ...(space ? { space } : {}) });
    if (!r.ok) return { ok: false, error: r.error?.message ?? "python execute failed" };
    const value = JSON.stringify(r.value ?? null);
    return applyOutputMode({ ok: true, value: r.value, stdout: truncate(value, 2000).text }, args["mode"]);
  },

  "python.eval": async ({ kernel, space }, args) => {
    const r = await kernel.python.execute(str(args, "code"), { exec: "single", ...(space ? { space } : {}) });
    if (!r.ok) return { ok: false, error: r.error?.message ?? "python eval failed" };
    const value = JSON.stringify(r.value ?? null);
    return applyOutputMode({ ok: true, value: r.value, stdout: truncate(value, 2000).text }, args["mode"]);
  },

  "bash.run": async ({ kernel, space }, args) => {
    const r = await kernel.bash.execute(str(args, "command"), ...(space ? [{ space }] : []));
    const out = truncate(r.stdout ?? "", 4000);
    // 2026-08-15 筛查 HIGH-1：失败时把 stderr/error 写回 AgentToolResult——
    // 此前只回 "error: unknown"，LLM 拿不到真实错误而盲试同一命令
    const failDetail = r.ok ? undefined : r.error?.message ?? (r.stderr?.trim() ? r.stderr : "bash execute failed");
    return applyOutputMode(
      { ok: r.ok, value: r.ok ? r.stdout : undefined, stdout: out.text, stderr: r.stderr, error: failDetail, truncated: out.truncated || (r as { truncated?: boolean }).truncated },
      args["mode"],
    );
  },

  "bash.eval": async ({ kernel, space }, args) => {
    const r = await kernel.bash.execute(str(args, "command"), ...(space ? [{ space }] : []));
    const out = truncate(r.stdout ?? "", 4000);
    const failDetail = r.ok ? undefined : r.error?.message ?? (r.stderr?.trim() ? r.stderr : "bash eval failed");
    return applyOutputMode(
      { ok: r.ok, value: r.ok ? r.stdout : undefined, stdout: out.text, stderr: r.stderr, error: failDetail, truncated: out.truncated || (r as { truncated?: boolean }).truncated },
      args["mode"],
    );
  },

  // 元命令拆分（2026-08-11 用户裁决）：ts.run = 程序执行（块包装——声明/多语句/控制流）；
  // ts.eval = 单表达式求值（return 包装——completion value 必回）。显式声明取代启发式猜测。
  "ts.run": async ({ kernel, taskWorkspace, ptcCaps }, args) => {
    // PTC 统一执行缝（2026-08-14 A1 Phase 2——组装逻辑收敛进 ptc/runner；
    // Phase 3——caps 装配 + 越界预检进 runner）
    const { raw, assembled } = await runPtcProgram({ code: str(args, "code"), cwd: taskWorkspace ?? "/tmp", exec: "program", ts: kernel.ts, caps: ptcCaps });
    if (!raw.ok) return { ok: false, error: raw.error?.message ?? "ts execute failed" };
    return applyOutputMode(
      { ok: true, value: raw.value, stdout: assembled.stdout, truncated: assembled.truncated },
      args["mode"],
    );
  },

  "ts.eval": async ({ kernel, taskWorkspace, ptcCaps }, args) => {
    const { raw, assembled } = await runPtcProgram({ code: str(args, "code"), cwd: taskWorkspace ?? "/tmp", exec: "single", ts: kernel.ts, caps: ptcCaps });
    if (!raw.ok) return { ok: false, error: raw.error?.message ?? "ts eval failed" };
    return applyOutputMode(
      { ok: true, value: raw.value, stdout: assembled.stdout, truncated: assembled.truncated },
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
    // asm 分发（2026-08-12 asm-kernel 接线）：.s/.S 走汇编核（as+ld——target 可选多平台）——C 路径不变
    if (isAsmSource(str(args, "path"))) {
      const reg = await ensureAsmKernel(ctx);
      if (!reg.ok) return { ok: false, error: reg.error ?? "asm 核不可用" };
      if (!ctx.kernel.execute) return { ok: false, error: "asm 核: worker kernel 无 execute 路由" };
      const asmCode = await readArtifact(ctx.taskWorkspace, str(args, "path"));
      const ar = await ctx.kernel.execute("asm", asmCode, { buildOnly: true, target: args.target } as never);
      if (!ar.ok) return { ok: false, error: ar.error?.message ?? "汇编/链接失败" };
      return { ok: true, value: ar.value, stdout: `汇编链接成功（${str(args, "path")}${args.target ? ` → ${args.target}` : ""}）` };
    }
    if (!ctx.kernel.c) return { ok: false, error: "dev.build: C 编译核不可用（sandbox 未配置）" };
    const code = await readArtifact(ctx.taskWorkspace, str(args, "path"));
    const r = await ctx.kernel.c.execute(code, { buildOnly: true } as never);
    if (!r.ok) return { ok: false, error: r.error?.message ?? "编译失败" };
    return { ok: true, value: r.value, stdout: `编译成功（${str(args, "path")}）` };
  },
  "dev.run": async (ctx, args) => {
    // asm 分发（2026-08-12 asm-kernel 接线）：.s/.S 走汇编核（host 直跑 / qemu-<arch>）——C 路径不变
    if (isAsmSource(str(args, "path"))) {
      const reg = await ensureAsmKernel(ctx);
      if (!reg.ok) return { ok: false, error: reg.error ?? "asm 核不可用" };
      if (!ctx.kernel.execute) return { ok: false, error: "asm 核: worker kernel 无 execute 路由" };
      const asmCode = await readArtifact(ctx.taskWorkspace, str(args, "path"));
      const ar = await ctx.kernel.execute("asm", asmCode, { target: args.target, timeoutMs: args.timeoutMs } as never);
      if (!ar.ok) return { ok: false, error: ar.error?.message ?? "运行失败" };
      const out = truncate(ar.stdout ?? "", 4000);
      return applyOutputMode({ ok: true, value: ar.value, stdout: out.text, stderr: (ar.stderr ?? "").slice(0, 2000), truncated: out.truncated }, args["mode"]);
    }
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
      const r = (await debugCall(ctx, "continue", { sessionId: str(args, "sessionId") })) as { reason?: string; frame?: unknown; output?: string };
      // 程序 stdout 回传（小缺口 2026-08-12——continue 期间输出不再丢失）
      const out = r.output ? `\n--- 程序输出 ---\n${r.output}` : "";
      return { ok: true, value: r, stdout: (r.reason === "exited" ? "程序已退出（未命中断点）" : `命中: ${JSON.stringify(r.frame ?? r)}`) + out };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  },
  "debug.step": async (ctx, args) => {
    try {
      const r = (await debugCall(ctx, "step", { sessionId: str(args, "sessionId"), direction: str(args, "direction") })) as { output?: string };
      const out = r.output ? `\n--- 程序输出 ---\n${r.output}` : "";
      return { ok: true, value: r, stdout: truncate(JSON.stringify(r), 500).text + out };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  },
  "debug.snapshot": async (ctx, args) => {
    // 聚合接口（ADI——原生 snapshot 端点：一次调用拿全帧+顶层帧变量；2026-08-12 小缺口）
    try {
      const r = await debugCall(ctx, "snapshot", { sessionId: str(args, "sessionId") });
      return { ok: true, value: r, stdout: truncate(JSON.stringify(r), 3000).text };
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

  // ─── 生产核·文档产物（write 空间——2026-08-12 批 2：编写类任务独立空间）───
  // 工作流：大纲→草稿→修订→定稿；无 build/debug（文档不编译）；章节走 write.section（非子空间）
  "write.create": async (ctx, args) => {
    const abs = resolveArtifact(ctx.taskWorkspace, str(args, "path"));
    const { writeFile, mkdir } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdir(dirname(abs), { recursive: true });
    const content = str(args, "content");
    await writeFile(abs, content, "utf-8");
    return { ok: true, value: { path: str(args, "path") }, stdout: `已创建文档 ${str(args, "path")}（${content.length} 字符）` };
  },
  "write.edit": async (ctx, args) => {
    const abs = resolveArtifact(ctx.taskWorkspace, str(args, "path"));
    const content = await readArtifact(ctx.taskWorkspace, str(args, "path"));
    const oldText = str(args, "oldText"), newText = str(args, "newText");
    const hits = content.split(oldText).length - 1;
    if (hits === 0) return { ok: false, error: `write.edit: oldText 未匹配（${str(args, "path")}）` };
    if (hits > 1) return { ok: false, error: `write.edit: oldText 匹配 ${hits} 处——需唯一（提供更多上下文）` };
    const { writeFile } = await import("node:fs/promises");
    await writeFile(abs, content.replace(oldText, newText), "utf-8");
    return { ok: true, value: { path: str(args, "path") }, stdout: `已编辑 ${str(args, "path")}（1 处替换）` };
  },
  "write.read": async (ctx, args) => {
    const content = await readArtifact(ctx.taskWorkspace, str(args, "path"));
    const out = truncate(content, 6000);
    const hint = out.truncated ? `\n\n【截断提示】全文 ${content.length} 字符，仅显示前 6000——长文档可分段写（write.section op=split 拆章节）` : "";
    return { ok: true, value: { path: str(args, "path"), length: content.length, truncated: out.truncated }, stdout: out.text + hint };
  },
  "write.list": async (ctx) => {
    const { readdir } = await import("node:fs/promises");
    const root = ctx.taskWorkspace ?? "/tmp";
    const docs: string[] = [];
    const walk = async (dir: string, prefix = ""): Promise<void> => {
      let entries: import("node:fs").Dirent[] = [];
      try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name.startsWith(".") || e.name === "node_modules") continue;
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(`${dir}/${e.name}`, rel);
        else if (/\.(md|txt|rst|adoc)$/i.test(e.name)) docs.push(rel);
      }
    };
    await walk(root);
    return { ok: true, value: docs, stdout: docs.length ? docs.join("\n") : "（无文档）" };
  },
  "write.save": async (ctx, args) => {
    if (!ctx.toolstore) return { ok: false, error: "write.save: toolstore 未配置" };
    const name = str(args, "name");
    if (!/^[\w.-]+$/.test(name)) return { ok: false, error: `write.save: 非法文档名 "${name}"（限 [a-zA-Z0-9_.-]）` };
    const content = await readArtifact(ctx.taskWorkspace, str(args, "path"));
    await ctx.toolstore.writeText(`docs/${name}.md`, content);
    return { ok: true, value: { name }, stdout: `已保存文档 ${name}.md（${content.length} 字符——跨任务复用）` };
  },
  "write.section": async (ctx, args) => {
    // 章节组织（非子空间——文档内结构操作）：op=list 列出标题结构；op=split 拆后段到新文件；op=reorder 重排章节
    const abs = resolveArtifact(ctx.taskWorkspace, str(args, "path"));
    const content = await readArtifact(ctx.taskWorkspace, str(args, "path"));
    const op = str(args, "op") || "list";
    // 标题定位（行级匹配——`# 一级` 至 `###### 六级`；统一辅助，split/reorder/before 同语义）
    const headingRe = /^#{1,6}\s+.+$/gm;
    const matches = [...content.matchAll(headingRe)];
    const findHeading = (title: string): number => matches.findIndex((m) => m[0].trim() === title.trim());
    const headings = matches.map((m) => ({ line: content.slice(0, m.index).split("\n").length, text: m[0].trim() }));
    if (op === "list") {
      return { ok: true, value: headings, stdout: headings.length ? headings.map((h) => `${h.line}: ${h.text}`).join("\n") : "（无标题结构——纯文本文档）" };
    }
    if (op === "split") {
      // split: 从指定标题（title 参数）开始拆出后段 → 新文件（target 参数）
      const title = str(args, "title");
      const target = str(args, "target");
      const headingIdx = findHeading(title);
      if (headingIdx < 0) return { ok: false, error: `write.section split: 标题 "${title}" 未找到（用 write.section op=list 查看标题行——需完整如 "## 章节名"）` };
      const segStart = matches[headingIdx]!.index!;
      const head = content.slice(0, segStart).trimEnd() + "\n";
      const tail = content.slice(segStart).trimStart();
      const { writeFile, mkdir } = await import("node:fs/promises");
      const { dirname } = await import("node:path");
      const targetAbs = resolveArtifact(ctx.taskWorkspace, target);
      await mkdir(dirname(targetAbs), { recursive: true });
      await writeFile(abs, head, "utf-8");
      await writeFile(targetAbs, tail, "utf-8");
      return { ok: true, value: { path: str(args, "path"), splitAt: title, target }, stdout: `已从 "${title}" 拆分 → ${target}（原文件保留 ${head.length} 字符）` };
    }
    if (op === "reorder") {
      // reorder: 将 title 章节移动到 before（目标标题前）；无 before 则移到末尾
      const title = str(args, "title");
      const before = str(args, "before") as string | undefined;
      const headingIdx = findHeading(title);
      if (headingIdx < 0) return { ok: false, error: `write.section reorder: 标题 "${title}" 未找到（需完整标题行如 "## 章节名"）` };
      const segStart = matches[headingIdx]!.index!;
      const segEnd = headingIdx + 1 < matches.length ? matches[headingIdx + 1]!.index! : content.length;
      const segment = content.slice(segStart, segEnd);
      let rest = content.slice(0, segStart) + content.slice(segEnd);
      // 移除段后——在 before 前插入（before 也走行级匹配——防子串误插）
      if (before) {
        const bIdx = findHeading(before);
        if (bIdx < 0) return { ok: false, error: `write.section reorder: before 标题 "${before}" 未找到（需完整标题行）` };
        const bStart = rest.indexOf(matches[bIdx]![0]);
        if (bStart < 0) return { ok: false, error: `write.section reorder: before 标题 "${before}" 定位失败` };
        rest = rest.slice(0, bStart) + segment.trimEnd() + "\n\n" + rest.slice(bStart);
      } else {
        rest = rest.trimEnd() + "\n\n" + segment.trimStart();
      }
      const { writeFile } = await import("node:fs/promises");
      await writeFile(abs, rest, "utf-8");
      return { ok: true, value: { path: str(args, "path"), moved: title, before: before ?? "末尾" }, stdout: `已移动章节 "${title}" → ${before ? `"${before}" 前` : "文档末尾"}` };
    }
    return { ok: false, error: `write.section: 未知 op "${op}"（list|split|reorder）` };
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
export function toolsDescription(actionTools?: string[], opts: ToolFaceOptions = {}): string {
  const schemas = filterToolSchemas(actionTools, opts);
  return `可用工具（每次输出一个 JSON 动作 {"thought":"...","action":{"tool":"<tool>","args":{...}}}）：
${Object.entries(schemas)
    .filter(([name]) => name !== "done")
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
