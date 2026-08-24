/**
 * ptc/capabilities/helpers.ts —— TCE W1 能力对象共享辅助。
 *
 * 从 agent-tools-registry.ts 抽出 dev/write/debug 实现所需的公共工具，
 * 供能力对象与旧 AGENT_TOOLS 薄包装共用，保证行为逐字节一致。
 */

import { pthConfig } from "@away_from/pth-config";
import type { AgentToolResult } from "../../agent-tool-types.js";

export function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string") throw new Error(`agent tool: 参数 ${key} 需为字符串`);
  return v;
}

export function truncate(s: string, max = 2000): { text: string; truncated: boolean } {
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
export function applyOutputMode(r: AgentToolResult, mode: unknown): AgentToolResult {
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

/** 产物路径校验（任务工作区白名单）：相对路径、拒绝绝对/穿越——与 fs.task 同规则 */
export function resolveArtifact(taskWorkspace: string | undefined, relPath: string): string {
  if (!taskWorkspace) throw new Error("dev: 任务工作区未就绪（非任务上下文）");
  if (typeof relPath !== "string" || relPath.length === 0) throw new Error("dev: path 必填");
  if (relPath.startsWith("/") || relPath.startsWith("..") || relPath.includes("/../")) {
    throw new Error(`dev: 仅允许工作区相对路径（拒绝: ${relPath.slice(0, 60)}）`);
  }
  return `${taskWorkspace}/${relPath}`;
}

export async function readArtifact(taskWorkspace: string | undefined, relPath: string): Promise<string> {
  const abs = resolveArtifact(taskWorkspace, relPath);
  const { readFile } = await import("node:fs/promises");
  try {
    return await readFile(abs, "utf-8");
  } catch {
    throw new Error(`dev: 产物不存在或不可读: ${relPath}（先 dev.write 创建）`);
  }
}

/** debug 会话调用（PTH → sandbox /kernel/debug/*——句柄化：状态在 sandbox 会话 Map，上限 4/idle 30min） */
export async function debugCall(
  ctx: { debugApi?: { url: string; secret: string } },
  op: string,
  body: Record<string, unknown>,
): Promise<unknown> {
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

/** 扩展名分发判定（.s/.S——asm-kernel 生产核） */
export const isAsmSource = (p: string): boolean => /\.s$/i.test(p);

/**
 * asm-kernel 惰性注册（2026-08-12 asm 核接线——设计 §4 选项 b）：dev.build/dev.run 遇 .s/.S
 * 时从 toolstore 装载 asm-kernel 扩展（new Function eval——与 ext-capability 同通道——受信
 * toolstore 代码）→ registerKernel("asm")。WeakSet 防重复注册。C 核路径完全不受影响。
 */
const asmKernels = new WeakSet<object>();
export async function ensureAsmKernel(ctx: { kernel: object; toolstore?: { readText: (p: string) => Promise<string> } }): Promise<{ ok: boolean; error?: string }> {
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
