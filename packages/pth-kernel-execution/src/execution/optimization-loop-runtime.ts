/**
 * optimization-loop-runtime.ts —— 规范化优化循环注册表与运行骨架（Wave 1）。
 *
 * 这里只表达规范骨架：Sense → Detect → Propose → Govern → Apply → Verify → Deopt。
 * 不同 loop 可以有不同 frequency；本模块不强制统一 scheduler tick。
 */

import {
  assertValidOptimizationLoopSpec,
  type OptimizationLoopSpec,
} from "./optimization-loop-spec.js";

export interface OptimizationLoopContext {
  readonly loopId: string;
  readonly startedAt: number;
  readonly trace: readonly unknown[];
  readonly signal?: AbortSignal;
}

export interface OptimizationLoopProposal {
  readonly id: string;
  readonly kind: string;
  readonly target: string;
  readonly content: unknown;
  readonly evidence?: unknown;
}

export type GovernDecision =
  | { readonly decision: "approved" }
  | { readonly decision: "denied"; readonly reason: string; readonly feedback?: unknown }
  | { readonly decision: "pending"; readonly reason?: string };

export interface GovernedProposal {
  readonly proposal: OptimizationLoopProposal;
  readonly decision: GovernDecision;
}

export interface AppliedProposal {
  readonly proposalId: string;
  readonly ok: boolean;
  readonly error?: string;
  readonly rollbackRef?: string;
}

export interface VerifyResult {
  readonly proposalId: string;
  readonly status: "verified" | "degraded" | "timeout" | "pending";
  readonly evidence?: unknown;
}

export interface DeoptResult {
  readonly proposalId: string;
  readonly rolledBack: boolean;
  readonly reason?: string;
}

export interface OptimizationLoopHandler {
  sense(ctx: OptimizationLoopContext): Promise<unknown>;
  detect(sensed: unknown, ctx: OptimizationLoopContext): Promise<OptimizationLoopProposal[]>;
  govern(proposals: OptimizationLoopProposal[], ctx: OptimizationLoopContext): Promise<GovernedProposal[]>;
  apply(approved: GovernedProposal[], ctx: OptimizationLoopContext): Promise<AppliedProposal[]>;
  verify(applied: AppliedProposal[], ctx: OptimizationLoopContext): Promise<VerifyResult[]>;
  deopt(verifyResults: VerifyResult[], ctx: OptimizationLoopContext): Promise<DeoptResult[]>;
}

export interface OptimizationLoopRunResult {
  readonly ctx: OptimizationLoopContext;
  readonly sensed: unknown;
  readonly detected: readonly OptimizationLoopProposal[];
  readonly governed: readonly GovernedProposal[];
  readonly approved: readonly GovernedProposal[];
  readonly applied: readonly AppliedProposal[];
  readonly verified: readonly VerifyResult[];
  readonly deopted: readonly DeoptResult[];
}

export interface OptimizationLoopRegistration {
  readonly spec: OptimizationLoopSpec;
  readonly handler: OptimizationLoopHandler;
}

export class OptimizationLoopRegistry {
  private readonly loops = new Map<string, OptimizationLoopRegistration>();

  register(registration: OptimizationLoopRegistration): void {
    assertValidOptimizationLoopSpec(registration.spec);
    if (this.loops.has(registration.spec.id)) {
      throw new Error(`optimization loop already registered: ${registration.spec.id}`);
    }
    this.loops.set(registration.spec.id, registration);
  }

  get(id: string): OptimizationLoopRegistration | undefined {
    return this.loops.get(id);
  }

  has(id: string): boolean {
    return this.loops.has(id);
  }

  list(): readonly OptimizationLoopRegistration[] {
    return [...this.loops.values()];
  }
}

/**
 * 运行一个规范化 loop 的完整骨架。
 * 任一步骤抛错都会向上传播；调用方可按 `observation-strategy-error` 等错误码降级。
 */
export async function runOptimizationLoop(
  spec: OptimizationLoopSpec,
  handler: OptimizationLoopHandler,
  input?: unknown,
  opts: { signal?: AbortSignal } = {},
): Promise<OptimizationLoopRunResult> {
  assertValidOptimizationLoopSpec(spec);
  const trace: unknown[] = [];
  const ctx: OptimizationLoopContext = {
    loopId: spec.id,
    startedAt: Date.now(),
    trace,
    signal: opts.signal,
  };
  const sensed = await handler.sense(ctx);
  const detected = await handler.detect(sensed ?? input, ctx);
  trace.push({ phase: "detect", count: detected.length });
  const governed = await handler.govern(detected, ctx);
  trace.push({ phase: "govern", count: governed.length });
  const approved = governed.filter((g) => g.decision.decision === "approved");
  const applied = await handler.apply(approved, ctx);
  trace.push({ phase: "apply", count: applied.length });
  const verified = await handler.verify(applied, ctx);
  trace.push({ phase: "verify", count: verified.length });
  const deopted = await handler.deopt(verified, ctx);
  trace.push({ phase: "deopt", count: deopted.length });
  return { ctx, sensed, detected, governed, approved, applied, verified, deopted };
}
