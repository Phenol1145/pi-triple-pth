/**
 * ptc/runner.ts —— PTC 统一执行缝（2026-08-14 A1 Phase 2——Seam 解耦）。
 *
 * 只管 **ts 缝**——不建 per-language runner：python/bash 是核契约（Interpreter）与
 * 动作工具面（AGENT_TOOLS），两级落位见 docs/pth/backlog-priority.md 附录 A 修订。
 *
 * 消费点（原四处散落——本缝统一）：
 *   - agent-tools ts.run/ts.eval：用 assembled（「返回值:/结果:」前缀 + 截断组装）；
 *   - agent-loop capability-as-action 降级：用 raw + registerResult 钩子；
 *   - task-loop 降级直执行：用 raw（InterpreterResult 原样）。
 *
 * 行为逐字保留：组装格式/截断上限/注册形状全部与迁移前一致（ptc-runner 测试 golden 钉死）。
 */

import type { Interpreter, InterpreterResult } from "../interpreter/types.js";

export interface PtcRunOptions {
  code: string;
  /** 执行 cwd（缺省 "/tmp"） */
  cwd?: string;
  /** 执行模式（缺省不传——走解释器 auto 语义，与旧降级路径一致） */
  exec?: "program" | "single";
  /** ts 核最小面（execute + registerResult） */
  ts: Pick<Interpreter, "execute" | "registerResult">;
  /** 结果注册钩子（payload 构造留给消费点——两处注册形状不同） */
  registerResult?: { key: string; build: (raw: InterpreterResult) => unknown };
}

export interface PtcRunOutput {
  /** 核原始结果（消费点按需取用） */
  raw: InterpreterResult;
  /** ts.run/ts.eval 组装输出（前缀 + 截断） */
  assembled: { stdout: string; truncated: boolean };
}

function truncate(s: string, max: number): { text: string; truncated: boolean } {
  if (s.length <= max) return { text: s, truncated: false };
  return { text: s.slice(0, max), truncated: true };
}

/** PTC 程序统一执行入口：执行 → 组装 → 结果注册（单点） */
export async function runPtcProgram(o: PtcRunOptions): Promise<PtcRunOutput> {
  const raw = await o.ts.execute(o.code, { cwd: o.cwd ?? "/tmp", ...(o.exec ? { exec: o.exec } : {}) });
  const single = o.exec === "single";
  const max = single ? 2000 : 4000;
  const prefix = single ? "结果: " : "返回值: ";
  const out = truncate(raw.stdout ?? "", max);
  const value = JSON.stringify(raw.value ?? null);
  const combined = [out.text, value !== "null" ? prefix + value : ""].filter(Boolean).join("\n");
  const assembled = { stdout: truncate(combined, max).text, truncated: out.truncated || Boolean(raw.truncated) };
  if (o.registerResult) {
    try {
      o.ts.registerResult?.(o.registerResult.key, o.registerResult.build(raw));
    } catch { /* mock 容忍（mock kernel 无 registerResult） */ }
  }
  return { raw, assembled };
}

