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
 *
 * Phase 3（2026-08-14 同日续）：能力面装配 + 越界预检——装配 → 预检 → 执行三步：
 *   - caps（任务级能力注入——cache 收敛自 task-loop 直调 injectCapability）；
 *   - 越界预检（ptc/surface.ts——未知能力根编译前拒绝 + 引导消息，与 N12 unknown-tool 同构）；
 *   - 预检基准 = ts.state 注入面键集合（Object.keys——seeds + caps + 内建外的程序残留）。
 */

import type { Interpreter, InterpreterResult } from "@away_from/pth-sandbox";
import { findOutOfBoundsRoots, buildSurfaceGuidance } from "./surface.js";

export interface PtcRunOptions {
  code: string;
  /** 执行 cwd（缺省 "/tmp"） */
  cwd?: string;
  /** 执行模式（缺省不传——走解释器 auto 语义，与旧降级路径一致） */
  exec?: "program" | "single";
  /** ts 核最小面（execute + state——state 为越界预检的注入面基准；registerResult 实现类必提供、接口层可选） */
  ts: Pick<Interpreter, "execute" | "state"> & {
    registerResult?: (key: string, value: unknown) => void;
    injectCapability?: (name: string, value: unknown) => void;
  };
  /** 结果注册钩子（payload 构造留给消费点——两处注册形状不同） */
  registerResult?: { key: string; build: (raw: InterpreterResult) => unknown };
  /** 任务级能力装配（Phase 3 条目 12）：runner 统一注入（cache 收敛）——
   *  与越界预检同一机制（注入后 state 即校验基准）。幂等——同一任务同一对象重复注入无害 */
  caps?: Record<string, unknown>;
  /** 关闭能力面越界预检（缺省 false——检查开启；测试/调试用） */
  skipSurfaceCheck?: boolean;
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

/** PTC 程序统一执行入口：装配 → 越界预检 → 执行 → 组装 → 结果注册（单点） */
export async function runPtcProgram(o: PtcRunOptions): Promise<PtcRunOutput> {
  // 1. 能力面装配（Phase 3 条目 12）：任务级 caps 注入 vm（幂等——同一任务同一对象）
  if (o.caps) {
    for (const [name, value] of Object.entries(o.caps)) {
      o.ts.injectCapability?.(name, value);
    }
  }
  // 2. 能力面越界预检（Phase 3 条目 9）：编译前拒绝——引导消息替代运行时裸 undefined
  let raw: InterpreterResult;
  if (!o.skipSurfaceCheck) {
    const known = new Set(Object.keys(o.ts.state ?? {}));
    const roots = findOutOfBoundsRoots(o.code, known);
    if (roots.length > 0) {
      raw = {
        ok: false, durationMs: 0, language: "ts",
        error: { message: buildSurfaceGuidance(roots), code: "capability-out-of-bounds" },
      };
    } else {
      raw = await o.ts.execute(o.code, { cwd: o.cwd ?? "/tmp", ...(o.exec ? { exec: o.exec } : {}) });
    }
  } else {
    raw = await o.ts.execute(o.code, { cwd: o.cwd ?? "/tmp", ...(o.exec ? { exec: o.exec } : {}) });
  }
  const single = o.exec === "single";
  const max = single ? 2000 : 4000;
  const prefix = single ? "结果: " : "返回值: ";
  const out = truncate(raw.stdout ?? "", max);
  const value = JSON.stringify(raw.value ?? null);
  const combined = [out.text, value !== "null" ? prefix + value : ""].filter(Boolean).join("\n");
  // 2026-08-15 审计 M7：第二次截断的标志不能丢——stdout 未超长但 value 追加后超长也要 truncated
  const finalOut = truncate(combined, max);
  const assembled = { stdout: finalOut.text, truncated: out.truncated || finalOut.truncated || Boolean(raw.truncated) };
  if (o.registerResult) {
    try {
      o.ts.registerResult?.(o.registerResult.key, o.registerResult.build(raw));
    } catch { /* mock 容忍（mock kernel 无 registerResult） */ }
  }
  return { raw, assembled };
}

