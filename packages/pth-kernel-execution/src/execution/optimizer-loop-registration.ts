/**
 * optimizer-loop-registration.ts —— 把现有 JIT Optimizer 包装为规范化优化循环（Wave 1）。
 *
 * 这里只做“登记 + 阶段映射”，不改动 Optimizer 现有建议内容与默认行为：
 *  - detect 仍走 optimizer.detect()（纯函数 + 窗口规则表）；
 *  - govern 默认返回 pending（JIT 建议仍是 draft，需监督层批准）；
 *  - 只有装配层开启 autoApplyReversible 时，才可能进入 apply/verify/deopt。
 */

import type { Optimizer, OptimizerSuggestion } from "./optimizer-loop.js";
import type { OptimizationLoopSpec } from "./optimization-loop-spec.js";
import type {
  AppliedProposal,
  GovernedProposal,
  OptimizationLoopContext,
  OptimizationLoopHandler,
  OptimizationLoopProposal,
  VerifyResult,
} from "./optimization-loop-runtime.js";

export const JIT_OPTIMIZATION_LOOP_ID = "optimization-loop:jit-worker";

export const jitOptimizationLoopSpec: OptimizationLoopSpec = {
  id: JIT_OPTIMIZATION_LOOP_ID,
  name: "JIT Optimizer (wrapped)",
  description: "现有 scorecard → 热点检测 → 规则/角色/guard 建议的优化环，作为首个规范化 loop 登记。",
  sensor: {
    kind: "code",
    ref: "scorecard-collector",
    readOnly: true,
  },
  schedule: {
    kind: "task-finish",
    everyNTasks: 1,
  },
  governance: {
    applyChannel: "auto-reversible",
    safetySensitive: false,
    proposalStoreRef: "memory:optimizer-suggestion",
    requiredApprovals: ["supervisor"],
    rollbackRef: "optimizer-deopt-rollback",
  },
  verify: {
    required: true,
    baselineRef: "memory:task-scorecard-aggregate",
    timeoutMs: 30 * 60_000,
    evidenceRefs: ["verify-aggregate", "task-scorecard-aggregate"],
    deoptOn: ["degraded", "timeout"],
  },
  budget: {
    maxIterations: 1,
    maxDurationMs: 30_000,
  },
  migrationStatus: "wrapped",
  owner: "optimizer-loop",
  tags: ["jit", "scorecard"],
};

function toProposal(s: OptimizerSuggestion): OptimizationLoopProposal {
  return {
    id: s.id,
    kind: s.kind,
    target: s.target,
    content: s,
    evidence: s.evidence,
  };
}

export interface JitOptimizationLoopHandlerOptions {
  /** 默认 false：保持 draft/pending，不自动批准。测试可设 true 以跑通完整骨架。 */
  approveAll?: boolean;
  /** 可选：批准的 proposal 的 apply 执行器（默认返回 not applied）。 */
  applySuggestion?: (proposalId: string) => Promise<{ ok: boolean; error?: string }>;
  /** 可选：verify 执行器（默认直接标记 verified；生产由 Optimizer.sweep/checkDeopt 负责）。 */
  verifySuggestion?: (proposalId: string) => Promise<{ status: VerifyResult["status"]; evidence?: unknown }>;
}

export function createJitOptimizationLoopHandler(
  optimizer: Optimizer,
  options: JitOptimizationLoopHandlerOptions = {},
): OptimizationLoopHandler {
  const applySuggestion = options.applySuggestion;
  return {
    async sense(): Promise<unknown> {
      // JIT 的 sense 由外部 scorecard collect 驱动；此处不主动拉取。
      return undefined;
    },
    async detect(sensed: unknown): Promise<OptimizationLoopProposal[]> {
      if (!Array.isArray(sensed)) {
        throw new Error("JIT loop detect expects a scorecard window array");
      }
      return optimizer.detect(sensed).map(toProposal);
    },
    async govern(proposals: OptimizationLoopProposal[]): Promise<GovernedProposal[]> {
      if (options.approveAll) {
        return proposals.map((proposal) => ({ proposal, decision: { decision: "approved" as const } }));
      }
      return proposals.map((proposal) => ({
        proposal,
        decision: { decision: "pending" as const, reason: "JIT 建议默认 draft，需监督层批准" },
      }));
    },
    async apply(approved: GovernedProposal[]): Promise<AppliedProposal[]> {
      const out: AppliedProposal[] = [];
      for (const g of approved) {
        if (applySuggestion) {
          const r = await applySuggestion(g.proposal.id);
          out.push({ proposalId: g.proposal.id, ok: r.ok, error: r.error });
        } else {
          out.push({ proposalId: g.proposal.id, ok: false, error: "no applySuggestion provided" });
        }
      }
      return out;
    },
    async verify(applied: AppliedProposal[]): Promise<VerifyResult[]> {
      if (options.verifySuggestion) {
        return Promise.all(applied.map(async (a) => {
          const r = await options.verifySuggestion!(a.proposalId);
          return { proposalId: a.proposalId, status: r.status, evidence: r.evidence };
        }));
      }
      // 生产环境由 Optimizer.sweep/checkDeopt 做异步复测；这里不阻塞返回 pending。
      return applied.map((a) => ({ proposalId: a.proposalId, status: "pending" as const }));
    },
    async deopt(verifyResults: VerifyResult[]): Promise<Array<{ proposalId: string; rolledBack: boolean; reason?: string }>> {
      return verifyResults
        .filter((v) => v.status === "degraded" || v.status === "timeout")
        .map((v) => ({ proposalId: v.proposalId, rolledBack: true, reason: `deopt after ${v.status}` }));
    },
  };
}
