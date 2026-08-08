/**
 * agent-tools —— agent 循环的工具执行器表（LLM 可调用的工具集）。
 *
 * 工具 = 现有 capability 白名单 + memory 读写（零新能力，调用者从任务代码换成 LLM）。
 * 每个工具：{ id, run(kernel, caps, args) → Observation-like }。
 * 返回结构统一 { ok, value?, stdout?, stderr?, error?, truncated? }（与 Observation 对齐，
 * 由 agent-loop 序列化回填 LLM 上下文）。
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
  /** capability 白名单（web/state/fs/memory/llm）——与 vm 注入同一份 */
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

/** 工具表（id → 执行器） */
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

  "llm.complete": async ({ kernel }, args) => {
    const user = str(args, "user");
    const r = await kernel.llm.complete(
      [{ role: "system", content: typeof args["system"] === "string" ? args["system"] : "你是助手" }, { role: "user", content: user }],
      { provider: "deepseek", model: typeof args["model"] === "string" ? args["model"] : undefined },
    );
    return { ok: true, value: r.content, stdout: truncate(r.content, 2000).text };
  },

  "web.fetchText": async (ctx, args) => {
    const web = ctx.caps["web"] as { fetchText?(url: string): Promise<string> } | undefined;
    if (!web?.fetchText) return { ok: false, error: "web 能力未注入" };
    try {
      const text = await web.fetchText(str(args, "url"));
      const t = truncate(String(text), 4000);
      return { ok: true, value: text, stdout: t.text, truncated: t.truncated };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },

  "fs.readText": async (ctx, args) => {
    const path = str(args, "path");
    try {
      const fs = ctx.caps["fs"] as { readText(p: string): Promise<string> } | undefined;
      if (!fs) return { ok: false, error: "fs 能力未注入（toolstore 未配置）" };
      const t = truncate(await fs.readText(path), 4000);
      return { ok: true, value: t.text, stdout: t.text, truncated: t.truncated };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },

  "fs.list": async (_ctx, args) => {
    const fs = _ctx.caps["fs"] as { list(dir?: string): Promise<unknown> } | undefined;
    if (!fs) return { ok: false, error: "fs 能力未注入（toolstore 未配置）" };
    try {
      const list = await fs.list(typeof args["dir"] === "string" ? args["dir"] : undefined);
      return { ok: true, value: list, stdout: truncate(JSON.stringify(list), 2000).text };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },

  "state.recallFunctions": async (_ctx, args) => {
    const state = _ctx.caps["state"] as { recallFunctions?(q?: string): Promise<unknown> } | undefined;
    if (!state?.recallFunctions) return { ok: false, error: "state 能力未注入" };
    try {
      const r = await state.recallFunctions(typeof args["query"] === "string" ? args["query"] : undefined);
      const t = truncate(JSON.stringify(r), 4000);
      return { ok: true, value: r, stdout: t.text, truncated: t.truncated };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },

  "state.recallInsights": async (_ctx, args) => {
    const state = _ctx.caps["state"] as { recallInsights?(q?: string): Promise<unknown> } | undefined;
    if (!state?.recallInsights) return { ok: false, error: "state 能力未注入" };
    try {
      const r = await state.recallInsights(typeof args["query"] === "string" ? args["query"] : undefined);
      const t = truncate(JSON.stringify(r), 4000);
      return { ok: true, value: r, stdout: t.text, truncated: t.truncated };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },

  "memory.retrieve": async (_ctx, args) => {
    const memory = _ctx.caps["memory"] as { retrieve(opts: unknown): Promise<unknown> } | undefined;
    if (!memory?.retrieve) return { ok: false, error: "memory 能力未注入" };
    try {
      const anchors = args["anchors"];
      const r = await memory.retrieve({
        anchors: Array.isArray(anchors) ? anchors : [String(anchors ?? "")],
        kinds: Array.isArray(args["kinds"]) ? args["kinds"] : undefined,
        limit: typeof args["limit"] === "number" ? args["limit"] : undefined,
      });
      const t = truncate(JSON.stringify(r), 4000);
      return { ok: true, value: r, stdout: t.text, truncated: t.truncated };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },

  "memory.write": async (_ctx, args) => {
    const memory = _ctx.caps["memory"] as { write(opts: unknown): Promise<unknown> } | undefined;
    if (!memory?.write) return { ok: false, error: "memory 能力未注入" };
    try {
      const r = await memory.write({
        id: typeof args["id"] === "string" ? args["id"] : undefined,
        kind: str(args, "kind"),
        anchors: Array.isArray(args["anchors"]) ? args["anchors"] : [str(args, "kind")],
        content: str(args, "content"),
      });
      return { ok: true, value: r, stdout: "memory written" };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },

  // done 由 agent-loop 拦截（不执行）
  done: async () => ({ ok: true, value: null, stdout: "done" }),
};

/** 工具清单描述（喂给 LLM 的 system prompt 用） */
export const AGENT_TOOLS_DESCRIPTION = `可用工具（每次输出一个 JSON 动作 {"thought":"...","action":{"tool":"<tool>","args":{...}}}）：
- python.execute: {code} —— 执行 Python 代码（代码里设 _result = 值 作为返回值；返回 { ok, value, stdout }）
- bash.execute: {command} —— 执行 shell 命令（返回 { ok, stdout, stderr }）
- ts: {code} —— 执行 TypeScript 内联代码（可用 await；return 值作为结果）
- llm.complete: {user, system?, model?} —— 调用子 LLM
- web.fetchText: {url} —— 只读获取网页文本
- fs.readText: {path} / fs.list: {dir?} —— 工具文件只读
- state.recallFunctions: {query?} / state.recallInsights: {query?} —— 记忆召回
- memory.retrieve: {anchors, kinds?, limit?} / memory.write: {id?, kind, anchors, content} —— 记忆读写
- done: {result, summary?} —— 完成任务，result 为最终产出对象`;
