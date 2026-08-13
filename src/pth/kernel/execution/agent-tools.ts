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
  /** 当前动作空间（记忆桥盖章——2026-08-12 批 3：语言执行带 space，kernel 层注入记忆访问可见性） */
  space?: string;
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
  const url = ctx.debugApi?.url ?? process.env.PTH_SANDBOX_KERNEL_URL ?? "http://sandbox:8080";
  const secret = ctx.debugApi?.secret ?? process.env.SANDBOX_SHARED_SECRET ?? "";
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
    return applyOutputMode(
      { ok: r.ok, value: r.ok ? r.stdout : undefined, stdout: out.text, stderr: r.stderr, truncated: out.truncated || (r as { truncated?: boolean }).truncated },
      args["mode"],
    );
  },

  "bash.eval": async ({ kernel, space }, args) => {
    const r = await kernel.bash.execute(str(args, "command"), ...(space ? [{ space }] : []));
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

/** 工具动作描述（元工具面） */
/** 工具参数 JSON Schema 定义（OpenAI function 格式——原生 tool_calls 声明） */
const TOOL_SCHEMAS: Record<string, { description: string; properties: Record<string, unknown>; required: string[] }> = {
  "pick.tools": {
    description: "【工具面声明（2026-08-12 动态工具选择协议）】声明下一轮 LLM 调用只暴露的工具清单（点形/下划线形均可）——聚焦注意力防误选。生效于下一轮并持续到空间切换或新声明；可在同一条消息里与其他工具并行调用（不增加轮次）；越权/当前空间不可用的名字会被忽略；done 与 asp_cd 始终可用；空数组 = 恢复默认全量面。",
    properties: { tools: { type: "array", items: { type: "string" }, description: "下一轮要用的工具名清单（如 ts.run/memory.query/ts_run）——只声明本轮真正需要的" } },
    required: ["tools"],
  },
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
  "write.create": {
    description: "【文档】创建文档（path 相对工作区；content 初稿全文——大纲→草稿→修订→定稿工作流第一步）",
    properties: { path: { type: "string" }, content: { type: "string" }, mode: { type: "string" } },
    required: ["path", "content"],
  },
  "write.edit": {
    description: "【文档】唯一匹配替换（oldText 必须唯一——多处匹配报错引导提供更多上下文；修订工作流核心）",
    properties: { path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" }, mode: { type: "string" } },
    required: ["path", "oldText", "newText"],
  },
  "write.read": {
    description: "【文档】读文档（全文回传，截断 6000 字符——长文档分段或读章节）",
    properties: { path: { type: "string" }, mode: { type: "string" } },
    required: ["path"],
  },
  "write.list": {
    description: "【文档】列工作区文档（*.md/txt/rst/adoc 递归）",
    properties: { mode: { type: "string" } },
    required: [],
  },
  "write.save": {
    description: "【文档】存记忆单元 docs/<name>.md（跨任务复用——定稿后保存）",
    properties: { path: { type: "string" }, name: { type: "string" }, mode: { type: "string" } },
    required: ["path", "name"],
  },
  "write.section": {
    description: "【文档】章节组织（非子空间——文档内结构操作）：op=list 列标题结构 / op=split 从 title 拆后段到新文件 target / op=reorder 移动 title 章节到 before 前（缺省末尾）",
    properties: { path: { type: "string" }, op: { type: "string" }, title: { type: "string" }, target: { type: "string" }, before: { type: "string" }, mode: { type: "string" } },
    required: ["path"],
  },
  "asp.cd": {
    description: "空间迁移（ASP 元工具）——cd 到目标空间。目标必须已注册（内置：meta 元空间/ts/python/bash + 生产核 dev 代码/write 文档；asp.create 生成的自定义子空间亦可）。语言代码只能在对应动作空间执行；done 仅在元空间可用。",
    properties: { space: { type: "string", description: "目标空间 id（meta/ts/python/bash/dev/write 或自定义注册空间）" } },
    required: ["space"],
  },
  "asp.create": {
    description: "空间生成（ASP 元工具·治理 v2）——在声明 allowChildren 的父空间内注册子空间（数据驱动：新空间=一条注册记录，即可被 asp.cd 进入）。meta 禁建（凭据根级固化）；父空间 childParams 必填表单校验（能力面 execTool/extraTools 收窄 + 记忆域 memoryScope 分配——缺字段拒绝并展示表单）；深度 ≤ 父 maxDepth；extraTools 只能收窄不能扩权。asp.index 查看空间树与表单。",
    properties: {
      id: { type: "string", description: "新空间 id（小写字母数字连字符 ≤32）" },
      execTool: { type: "string", description: "子空间语言执行工具名（能力面收窄——须为已注册语言族：ts/python/bash/dev/write）" },
      memoryScope: { type: "string", description: "记忆域标注（子空间记忆域名——缺省继承父空间；实际可见性过滤按空间 id 树）" },
      extraTools: { type: "string", description: "工具族收窄（逗号分隔——父空间 extraTools 的子集）" },
      skeleton: { type: "string", description: "语言骨架摘要（索引/prompt 用）" },
      description: { type: "string", description: "子空间说明（必填）" },
    },
    required: ["id", "execTool", "memoryScope", "description"],
  },
  "asp.destroy": {
    description: "空间注销（ASP 元工具·治理 v2）——注销子空间。位置约束：仅子空间的父空间内可注销自己的子空间（meta 兜底可注销任何非内置空间）；内置空间保护不变（parent=meta 的不可注销）。",
    properties: { id: { type: "string", description: "要注销的空间 id" } },
    required: ["id"],
  },
  "asp.index": {
    description: "【空间地图（探索引导——新任务/要切空间时先用它）】一次展示空间树/当前空间可达函数与数据。无参数 = 当前空间；space: 指定空间——避免盲目 asp_cd 往返。",
    properties: {
      mode: { type: "string", enum: ["by-package", "by-type"], description: "聚合模式（缺省 by-package）" },
      space: { type: "string", description: "目标空间 id（缺省当前空间）" },
    },
    required: [],
  },
  "memory.index": {
    description: "【记忆库地图（查询/统计/找条目第一步必用——避免逐条 SQL 盲查）】无参=顶层视图（一次拿到所有 kind 的条数分布 + 热门 tag 词表——统计/清点任务直接用它）；{tag} = 该 tag 条目清单；{id} = 条目摘要+出边。先看地图再决定查什么。",
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

/** 工具族（2026-08-12 动作面裁剪——按角色目标最小化分组的单元）
 * 角色声明 actionTools 时按族/逐工具 id 白名单过滤 LLM 工具面——
 * in-tokens 削减（memory-stats 背 debug.* 定义的历史问题消除）。
 * 维护类收编：spaceMaint（asp.create/destroy）默认只授 controller 系/origin——
 * 空间治理走 controller 维护任务（worker 不做空间生成/注销）。 */
export const TOOL_GROUPS: Record<string, string[]> = {
  execTs: ["ts.run", "ts.eval"],
  execPy: ["python.run", "python.eval"],
  execBash: ["bash.run", "bash.eval"],
  dev: ["dev.write", "dev.edit", "dev.build", "dev.run", "dev.save", "dev.list"],
  debug: ["debug.attach", "debug.breakpoint", "debug.continue", "debug.step", "debug.snapshot", "debug.evaluate", "debug.detach", "debug.sessions"],
  write: ["write.create", "write.edit", "write.read", "write.list", "write.save", "write.section"],
  nav: ["asp.cd", "asp.index", "memory.index"],
  spaceMaint: ["asp.create", "asp.destroy"],
  cache: ["cache.load", "cache.index", "cache.cancel"],
};

/** 展开工具族（组名 → 工具 id 列表；未知组名忽略——保持前向兼容） */
export function expandToolGroups(ids: string[]): string[] {
  const out: string[] = [];
  for (const id of ids) {
    if (TOOL_GROUPS[id]) out.push(...TOOL_GROUPS[id]);
    else out.push(id);
  }
  return out;
}

/** 按角色动作面过滤工具（actionTools 未声明/空 → 全量——向后兼容：扩展角色/自定义角色不受影响） */
export function filterToolSchemas(ids: string[] | undefined): typeof TOOL_SCHEMAS {
  if (!ids || ids.length === 0) return TOOL_SCHEMAS;
  const wanted = new Set(expandToolGroups(ids));
  const out: typeof TOOL_SCHEMAS = {};
  for (const [name, s] of Object.entries(TOOL_SCHEMAS)) {
    if (wanted.has(name)) out[name] = s;
  }
  return out;
}

/** 工具声明 → pi-ai Tool[]（OpenAI function 格式——Context.tools 原生 tool_calls）
 * name 去点（OpenAI tool name pattern ^[a-zA-Z0-9_-]+$——python.execute 非法 → python_execute）
 * actionTools 过滤：按角色白名单裁剪（缺省全量）。 */
export function toolsToSchema(actionTools?: string[]): import("@earendil-works/pi-ai").Tool[] {
  const schemas = filterToolSchemas(actionTools);
  return Object.entries(schemas).map(([name, s]) => ({
    name: name.replace(/\./g, "_"),
    description: s.description,
    parameters: { type: "object", properties: s.properties, required: s.required },
  }));
}

/** 裁剪后的工具描述（prompt 注入面与 schema 同步——in-tokens 削减；done/输出模式为固定协议段） */
export function toolsDescription(actionTools?: string[]): string {
  const schemas = filterToolSchemas(actionTools);
  return `可用工具（每次输出一个 JSON 动作 {"thought":"...","action":{"tool":"<tool>","args":{...}}}）：
${Object.entries(schemas)
    .map(([name, s]) => `- ${name}: ${s.description}`)
    .join("\n")}
- done: {result, summary?} —— 完成任务，result 为最终产出对象
- pick.tools: {tools: string[]} —— 声明下一轮只暴露的工具清单（聚焦防误选；done/asp.cd 始终可用；空数组恢复默认）

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
