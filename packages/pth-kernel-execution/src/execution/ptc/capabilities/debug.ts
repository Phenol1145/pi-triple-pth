/**
 * ptc/capabilities/debug.ts —— TCE W1：debug.* 能力对象。
 *
 * 从 agent-tools-registry.ts 抽出，行为逐字节保留。
 */

import type { AgentToolResult } from "../../agent-tool-types.js";
import { debugCall, readArtifact, truncate } from "./helpers.js";

export interface DebugCapabilityDeps {
  taskWorkspace?: string;
  debugApi?: { url: string; secret: string };
}

export interface DebugCapability {
  attach(input: { code?: string; path?: string; cc?: string; mode?: string }): Promise<AgentToolResult>;
  breakpoint(input: { sessionId: string; line: number; condition?: string; mode?: string }): Promise<AgentToolResult>;
  continue(input: { sessionId: string; mode?: string }): Promise<AgentToolResult>;
  step(input: { sessionId: string; direction: string; mode?: string }): Promise<AgentToolResult>;
  snapshot(input: { sessionId: string; mode?: string }): Promise<AgentToolResult>;
  evaluate(input: { sessionId: string; expr: string; frameId?: number; mode?: string }): Promise<AgentToolResult>;
  detach(input: { sessionId: string; mode?: string }): Promise<AgentToolResult>;
  sessions(input?: { mode?: string }): Promise<AgentToolResult>;
}

export function createDebugCapability(deps: DebugCapabilityDeps): DebugCapability {
  const { taskWorkspace, debugApi } = deps;

  return {
    async attach(input) {
      let code = input.code as string | undefined;
      if (!code && typeof input.path === "string") code = await readArtifact(taskWorkspace, input.path);
      if (!code) return { ok: false, error: "debug.attach: code 或 path 必填其一" };
      try {
        const r = (await debugCall({ debugApi }, "attach", { code, cc: input.cc })) as { sessionId: string };
        return { ok: true, value: r, stdout: `调试会话已建立: ${r.sessionId}（编译 -g 调试版——后续操作传 sessionId；用完 debug.detach 释放）` };
      } catch (e) { return { ok: false, error: (e as Error).message }; }
    },

    async breakpoint(input) {
      try {
        const r = await debugCall({ debugApi }, "breakpoint", { sessionId: input.sessionId, line: input.line, condition: input.condition });
        return { ok: true, value: r, stdout: JSON.stringify(r) };
      } catch (e) { return { ok: false, error: (e as Error).message }; }
    },

    async continue(input) {
      try {
        const r = (await debugCall({ debugApi }, "continue", { sessionId: input.sessionId })) as { reason?: string; frame?: unknown; output?: string };
        // 程序 stdout 回传（小缺口 2026-08-12——continue 期间输出不再丢失）
        const out = r.output ? `\n--- 程序输出 ---\n${r.output}` : "";
        return { ok: true, value: r, stdout: (r.reason === "exited" ? "程序已退出（未命中断点）" : `命中: ${JSON.stringify(r.frame ?? r)}`) + out };
      } catch (e) { return { ok: false, error: (e as Error).message }; }
    },

    async step(input) {
      try {
        const r = (await debugCall({ debugApi }, "step", { sessionId: input.sessionId, direction: input.direction })) as { output?: string };
        const out = r.output ? `\n--- 程序输出 ---\n${r.output}` : "";
        return { ok: true, value: r, stdout: truncate(JSON.stringify(r), 500).text + out };
      } catch (e) { return { ok: false, error: (e as Error).message }; }
    },

    async snapshot(input) {
      // 聚合接口（ADI——原生 snapshot 端点：一次调用拿全帧+顶层帧变量；2026-08-12 小缺口）
      try {
        const r = await debugCall({ debugApi }, "snapshot", { sessionId: input.sessionId });
        return { ok: true, value: r, stdout: truncate(JSON.stringify(r), 3000).text };
      } catch (e) { return { ok: false, error: (e as Error).message }; }
    },

    async evaluate(input) {
      try {
        const r = await debugCall({ debugApi }, "evaluate", { sessionId: input.sessionId, expr: input.expr, frameId: input.frameId });
        return { ok: true, value: r, stdout: JSON.stringify(r) };
      } catch (e) { return { ok: false, error: (e as Error).message }; }
    },

    async detach(input) {
      try {
        await debugCall({ debugApi }, "detach", { sessionId: input.sessionId });
        return { ok: true, stdout: `会话 ${input.sessionId} 已释放` };
      } catch (e) { return { ok: false, error: (e as Error).message }; }
    },

    async sessions() {
      try {
        const r = await debugCall({ debugApi }, "sessions", {});
        return { ok: true, value: r, stdout: JSON.stringify(r) };
      } catch (e) { return { ok: false, error: (e as Error).message }; }
    },
  };
}
