/**
 * agent-tools-registry.ts —— agent 循环工具执行器表（模块专项 ② 大文件拆分：自 agent-tools.ts 抽出）。
 */
import type { WorkerKernel } from "@away_from/pth-kernel-interpreter";
import type { AgentToolId } from "./parse-agent-action.js";
import { buildDoc } from "@away_from/pth-kernel-interpreter";
import { runPtcProgram } from "@away_from/pth-kernel-interpreter";
import { buildToolSchemas } from "@away_from/pth-kernel-interpreter";
import { pthConfig } from "@away_from/pth-config";
import { createDevCapability, createWriteCapability, createDebugCapability } from "./ptc/capabilities/index.js";
import type { CommandGateway, CommandSecurityContext } from "./execution-command.js";
import { PTH_DONE_SIGNAL_CODE, type AgentToolResult } from "./agent-tool-types.js";
export { PTH_DONE_SIGNAL_CODE } from "./agent-tool-types.js";
export type { AgentToolResult } from "./agent-tool-types.js";

export interface AgentToolCtx {
  kernel: WorkerKernel;
  /** capability 白名单（web/state/fs/memory/llm/sql）——与 vm 注入同一份 */
  caps: Record<string, unknown>;
  /** 任务工作区（fs.task 落盘——ts 工具 cwd——自修改产物写 tasks/<id>/） */
  taskWorkspace?: string;
  /** 产物单元存储（dev.save/dev.list——生产核单元管理） */
  toolstore?: import("@away_from/pth-kernel-interpreter").Toolstore;
  /** 调试会话接入（debug.*——缺省读 env PTH_SANDBOX_KERNEL_URL/SANDBOX_SHARED_SECRET；测试注入覆盖） */
  debugApi?: { url: string; secret: string };
  /** 当前动作空间（记忆桥盖章——2026-08-12 批 3：语言执行带 space，kernel 层注入记忆访问可见性） */
  space?: string;
  /** 任务级能力装配（Phase 3 条目 12——cache 收敛）：runPtcProgram 统一注入 vm
   *  （task-loop → agent-loop → 本 ctx 透传；与越界预检同一机制） */
  ptcCaps?: Record<string, unknown>;
  /** TCE P3：Command 层注入（语言工具先过 CommandGateway 授权；缺省 = legacy 直执行） */
  commandGateway?: CommandGateway;
  /** TCE P3：Command 安全上下文（agent-loop 从任务身份盖章） */
  commandContext?: CommandSecurityContext;
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

/**
 * TCE P3：语言工具先过 CommandGateway 授权（若注入）。
 * 返回 ok:true 放行；deny/await-approval 直接转 AgentToolResult 错误（await 用 code 透传）。
 */
async function authorizeViaCommandGateway(
  ctx: AgentToolCtx,
  tool: string,
  args: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; error: string; code?: string; requestId?: string }> {
  if (!ctx.commandGateway || !ctx.commandContext) return { ok: true };
  const decision = await ctx.commandGateway.decide({
    surface: "agent-tool",
    toolCall: { tool, args },
    ctx: ctx.commandContext,
  });
  if (decision.kind === "deny") return { ok: false, error: decision.reason };
  if (decision.kind === "await-approval") {
    return { ok: false, error: "HUMAN_APPROVAL_PENDING", code: "HUMAN_APPROVAL_PENDING", requestId: decision.requestId };
  }
  return { ok: true };
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
  "python.run": async (ctx, args) => {
    const auth = await authorizeViaCommandGateway(ctx, "python.run", args);
    if (!auth.ok) return { ok: false, error: auth.error, code: auth.code };
    const { kernel, space } = ctx;
    const r = await kernel.python.execute(str(args, "code"), { exec: "program", ...(space ? { space } : {}) });
    if (!r.ok) return { ok: false, error: r.error?.message ?? "python execute failed" };
    const value = JSON.stringify(r.value ?? null);
    return applyOutputMode({ ok: true, value: r.value, stdout: truncate(value, 2000).text }, args["mode"]);
  },

  "python.eval": async (ctx, args) => {
    const auth = await authorizeViaCommandGateway(ctx, "python.eval", args);
    if (!auth.ok) return { ok: false, error: auth.error, code: auth.code };
    const { kernel, space } = ctx;
    const r = await kernel.python.execute(str(args, "code"), { exec: "single", ...(space ? { space } : {}) });
    if (!r.ok) return { ok: false, error: r.error?.message ?? "python eval failed" };
    const value = JSON.stringify(r.value ?? null);
    return applyOutputMode({ ok: true, value: r.value, stdout: truncate(value, 2000).text }, args["mode"]);
  },

  "bash.run": async (ctx, args) => {
    const auth = await authorizeViaCommandGateway(ctx, "bash.run", args);
    if (!auth.ok) return { ok: false, error: auth.error, code: auth.code };
    const { kernel, space } = ctx;
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

  "bash.eval": async (ctx, args) => {
    const auth = await authorizeViaCommandGateway(ctx, "bash.eval", args);
    if (!auth.ok) return { ok: false, error: auth.error, code: auth.code };
    const { kernel, space } = ctx;
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
  "ts.run": async (ctx, args) => {
    const auth = await authorizeViaCommandGateway(ctx, "ts.run", args);
    if (!auth.ok) return { ok: false, error: auth.error, code: auth.code };
    const { kernel, taskWorkspace, ptcCaps } = ctx;
    // PTC 统一执行缝（2026-08-14 A1 Phase 2——组装逻辑收敛进 ptc/runner；
    // Phase 3——caps 装配 + 越界预检进 runner）
    const { raw, assembled } = await runPtcProgram({ code: str(args, "code"), cwd: taskWorkspace ?? "/tmp", exec: "program", ts: kernel.ts, caps: ptcCaps });
    if (!raw.ok) {
      if (raw.error?.code === PTH_DONE_SIGNAL_CODE) {
        const doneErr = raw.error as Error & { result?: unknown; summary?: unknown };
        return { ok: false, error: raw.error.message, code: raw.error.code, doneResult: doneErr.result, doneSummary: typeof doneErr.summary === "string" ? doneErr.summary : undefined };
      }
      return { ok: false, error: raw.error?.message ?? "ts execute failed", code: raw.error?.code };
    }
    return applyOutputMode(
      { ok: true, value: raw.value, stdout: assembled.stdout, truncated: assembled.truncated },
      args["mode"],
    );
  },

  "ts.eval": async (ctx, args) => {
    const auth = await authorizeViaCommandGateway(ctx, "ts.eval", args);
    if (!auth.ok) return { ok: false, error: auth.error, code: auth.code };
    const { kernel, taskWorkspace, ptcCaps } = ctx;
    const { raw, assembled } = await runPtcProgram({ code: str(args, "code"), cwd: taskWorkspace ?? "/tmp", exec: "single", ts: kernel.ts, caps: ptcCaps });
    if (!raw.ok) {
      if (raw.error?.code === PTH_DONE_SIGNAL_CODE) {
        const doneErr = raw.error as Error & { result?: unknown; summary?: unknown };
        return { ok: false, error: raw.error.message, code: raw.error.code, doneResult: doneErr.result, doneSummary: typeof doneErr.summary === "string" ? doneErr.summary : undefined };
      }
      return { ok: false, error: raw.error?.message ?? "ts eval failed", code: raw.error?.code };
    }
    return applyOutputMode(
      { ok: true, value: raw.value, stdout: assembled.stdout, truncated: assembled.truncated },
      args["mode"],
    );
  },

  // ─── 生产核·代码产物（dev 空间——W1 能力对象薄包装）───
  "dev.write": async (ctx, args) => createDevCapability({ kernel: ctx.kernel, taskWorkspace: ctx.taskWorkspace, toolstore: ctx.toolstore }).write(args as never),
  "dev.edit": async (ctx, args) => createDevCapability({ kernel: ctx.kernel, taskWorkspace: ctx.taskWorkspace, toolstore: ctx.toolstore }).edit(args as never),
  "dev.build": async (ctx, args) => createDevCapability({ kernel: ctx.kernel, taskWorkspace: ctx.taskWorkspace, toolstore: ctx.toolstore }).build(args as never),
  "dev.run": async (ctx, args) => createDevCapability({ kernel: ctx.kernel, taskWorkspace: ctx.taskWorkspace, toolstore: ctx.toolstore }).run(args as never),
  "dev.save": async (ctx, args) => createDevCapability({ kernel: ctx.kernel, taskWorkspace: ctx.taskWorkspace, toolstore: ctx.toolstore }).save(args as never),
  "dev.list": async (ctx, args) => createDevCapability({ kernel: ctx.kernel, taskWorkspace: ctx.taskWorkspace, toolstore: ctx.toolstore }).list(args as never),

  // ─── 调试会话（debug 族——W1 能力对象薄包装）───
  "debug.attach": async (ctx, args) => createDebugCapability({ taskWorkspace: ctx.taskWorkspace, debugApi: ctx.debugApi }).attach(args as never),
  "debug.breakpoint": async (ctx, args) => createDebugCapability({ taskWorkspace: ctx.taskWorkspace, debugApi: ctx.debugApi }).breakpoint(args as never),
  "debug.continue": async (ctx, args) => createDebugCapability({ taskWorkspace: ctx.taskWorkspace, debugApi: ctx.debugApi }).continue(args as never),
  "debug.step": async (ctx, args) => createDebugCapability({ taskWorkspace: ctx.taskWorkspace, debugApi: ctx.debugApi }).step(args as never),
  "debug.snapshot": async (ctx, args) => createDebugCapability({ taskWorkspace: ctx.taskWorkspace, debugApi: ctx.debugApi }).snapshot(args as never),
  "debug.evaluate": async (ctx, args) => createDebugCapability({ taskWorkspace: ctx.taskWorkspace, debugApi: ctx.debugApi }).evaluate(args as never),
  "debug.detach": async (ctx, args) => createDebugCapability({ taskWorkspace: ctx.taskWorkspace, debugApi: ctx.debugApi }).detach(args as never),
  "debug.sessions": async (ctx, args) => createDebugCapability({ taskWorkspace: ctx.taskWorkspace, debugApi: ctx.debugApi }).sessions(args as never),

  // ─── 生产核·文档产物（write 空间——W1 能力对象薄包装）───
  "write.create": async (ctx, args) => createWriteCapability({ taskWorkspace: ctx.taskWorkspace, toolstore: ctx.toolstore }).create(args as never),
  "write.edit": async (ctx, args) => createWriteCapability({ taskWorkspace: ctx.taskWorkspace, toolstore: ctx.toolstore }).edit(args as never),
  "write.read": async (ctx, args) => createWriteCapability({ taskWorkspace: ctx.taskWorkspace, toolstore: ctx.toolstore }).read(args as never),
  "write.list": async (ctx, args) => createWriteCapability({ taskWorkspace: ctx.taskWorkspace, toolstore: ctx.toolstore }).list(args as never),
  "write.save": async (ctx, args) => createWriteCapability({ taskWorkspace: ctx.taskWorkspace, toolstore: ctx.toolstore }).save(args as never),
  "write.section": async (ctx, args) => createWriteCapability({ taskWorkspace: ctx.taskWorkspace, toolstore: ctx.toolstore }).section(args as never),

  // done 由 agent-loop 拦截（不执行）
  done: async () => ({ ok: true, value: null, stdout: "done" }),
  // pause 由 agent-loop 拦截（不执行；返回 TaskSuspension 信号）
  pause: async () => ({ ok: true, value: null, stdout: "pause" }),
};

/**
 * 能力函数文档（ts 程序内可用——喂给 LLM 的 system prompt）。
 * 元工具动作 → ts 程序；能力函数 → 程序内 await 调用。
 * 标准扩展包自动聚合（SPEC 2026-08-09——扩展自声明 doc）
 */
