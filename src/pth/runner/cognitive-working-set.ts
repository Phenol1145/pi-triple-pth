/**
 * runner/cognitive-working-set.ts —— N28 T5 任务工作集 policy 与预算化 capability facade。
 *
 * TaskWorkingSetPolicy 在任务开始冻结；TaskWorkingSet 随合法 memory/knowledge 展开和
 * skills.get 单调增长，每次增长先消费同一个 CognitiveBudgetLedger。
 * 本模块只包装读路径；write/maintain/review/promotion/task-control 一概不碰。
 */

import type { MemoryEntry, SkillSummary } from "@away_from/pth-memory";
import type { CognitiveBudget, TaskWorkingSetPolicy, WorkerLoadEnvelope, WorkerReplicaRef } from "@away_from/pth-contracts";
import { knowledgeQueryTokenHits } from "../execution/index.js";
import { canonicalExposureChars, CognitiveBudgetExceededError, CognitiveBudgetLedger } from "@away_from/pth-kernel-execution";
import type { AuthorizedTaskReads } from "./authorized-task-reads.js";

export function createTaskWorkingSetPolicy(input: {
  taskId: string;
  worker: WorkerReplicaRef;
  directorySnapshotId: string;
  budget: CognitiveBudget;
  skillIndexItems: readonly { id: string; chars: number }[];
  pinnedToolNames: readonly string[];
  candidateToolNames: readonly string[];
}): { policy: TaskWorkingSetPolicy; ledger: CognitiveBudgetLedger } {
  const ledger = new CognitiveBudgetLedger({
    taskId: input.taskId,
    workerId: input.worker.workerId,
    directorySnapshotId: input.directorySnapshotId,
    budget: input.budget,
  });
  const skillIndexIds = ledger.freezeSkillIndex(input.skillIndexItems);
  const toolNames = ledger.freezeTools(input.pinnedToolNames, input.candidateToolNames);
  const policy: TaskWorkingSetPolicy = {
    taskId: input.taskId,
    worker: input.worker,
    directorySnapshotId: input.directorySnapshotId,
    budget: input.budget,
    skillIndexIds,
    toolNames,
  };
  return { policy, ledger };
}

export function createBudgetedTaskCapabilities(
  base: Record<string, unknown>,
  policy: TaskWorkingSetPolicy,
  ledger: CognitiveBudgetLedger,
  adapters: AuthorizedTaskReads,
  frozen: { skillSummaries: readonly SkillSummary[] },
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };

  const canonicalSkillId = (id: string): string => (id.startsWith("skill:") ? id : `skill:${id}`);

  out["memory"] = {
    ...((base["memory"] as Record<string, unknown> | undefined) ?? {}),
    async retrieve(opts: { anchors?: string[]; kinds?: string[]; queryText?: string; limit?: number }): Promise<Array<{ id: string } & Record<string, unknown>>> {
      const { entries, trace } = await adapters.retrieveMemory(opts);
      const completed = ledger.recordRetrievalTrace(trace);
      void completed;
      // P0-2 修复：逐行 token 计费——重复 ID 的每行都独立占账本，禁止 ID Set 反向放行重复正文。
      const admitted = ledger.admitMemory(entries.map((entry, index) => ({ id: `${String(entry.id)}#row${index}`, chars: canonicalExposureChars(entry) })));
      const allowed = new Set(admitted.accepted.map((item) => item.id));
      return entries.filter((_, index) => allowed.has(`${String(entries[index]!.id)}#row${index}`));
    },
    async get(id: string): Promise<({ id: string } & Record<string, unknown>) | undefined> {
      const row = await adapters.getMemory(id);
      if (!row) return undefined;
      const admitted = ledger.admitMemory([{ id: String(row.id), chars: canonicalExposureChars(row) }]);
      if (admitted.accepted.length === 0) {
        throw new CognitiveBudgetExceededError("memoryChars", ledger.snapshot().usage.memoryChars, canonicalExposureChars(row));
      }
      return row;
    },
    async query(sql: string): Promise<Array<{ id: string } & Record<string, unknown>>> {
      const rows = await adapters.queryMemory(sql);
      const admitted = ledger.admitMemory(rows.map((row, index) => ({ id: `${String(row.id)}#row${index}`, chars: canonicalExposureChars(row) })));
      const allowed = new Set(admitted.accepted.map((item) => item.id));
      return rows.filter((_, index) => allowed.has(`${String(rows[index]!.id)}#row${index}`));
    },
  };

  out["state"] = {
    ...((base["state"] as Record<string, unknown> | undefined) ?? {}),
    async recallFunctions(anchors: string[], opts?: { limit?: number }): Promise<Array<{ key: string; source: string; spec: unknown }>> {
      const rows = await adapters.recallFunctions(anchors, opts);
      const admitted = ledger.admitMemory(rows.map((row, index) => ({ id: `${row.id}#row${index}`, chars: canonicalExposureChars({ key: row.key, source: row.source, spec: row.spec }) })));
      const allowed = new Set(admitted.accepted.map((item) => item.id));
      // P0-1/P0-2 修复：逐行 token 过滤；omitted 与重复 ID 多行绝不返回。
      return rows.filter((_, index) => allowed.has(`${rows[index]!.id}#row${index}`)).map(({ key, source, spec }) => ({ key, source, spec }));
    },
    async recallInsights(anchors: string[], opts?: { limit?: number }): Promise<Array<{ content: string }>> {
      const rows = await adapters.recallInsights(anchors, opts);
      const admitted = ledger.admitMemory(rows.map((row, index) => ({ id: `${row.id}#row${index}`, chars: canonicalExposureChars({ content: row.content }) })));
      const allowed = new Set(admitted.accepted.map((item) => item.id));
      return rows.filter((_, index) => allowed.has(`${rows[index]!.id}#row${index}`)).map(({ content }) => ({ content }));
    },
  };

  out["skills"] = {
    ...((base["skills"] as Record<string, unknown> | undefined) ?? {}),
    async list(): Promise<SkillSummary[]> {
      adapters.assertCurrentScope();
      return [...frozen.skillSummaries];
    },
    async get(id: string): Promise<MemoryEntry | undefined> {
      const canonical = canonicalSkillId(id);
      if (!policy.skillIndexIds.includes(canonical)) throw new Error(`skill ${id} not in frozen skill index`);
      const entry = await adapters.getSkill(canonical);
      if (!entry) return undefined;
      const ok = ledger.activateSkill(canonical, canonicalExposureChars(entry));
      if (!ok) {
        throw new CognitiveBudgetExceededError("skillChars", ledger.snapshot().usage.skillChars, canonicalExposureChars(entry));
      }
      return entry;
    },
  };

  return out;
}

/** N28 T6：feasibility provider——真实 Skill 快照 + 冻结工具面 + 预算化 capability。 */
export interface CognitiveWorkingSetProvider {
  build(input: {
    taskId: string;
    worker: WorkerReplicaRef;
    directorySnapshotId: string;
    roleId: string;
    loadPolicyRef?: string;
    tenantId: string;
    space: string;
    domains: readonly string[];
    title: string;
    text: string;
    catalogVersion: string;
    baseCaps: Record<string, unknown>;
    staticToolNames: readonly string[];
    registryToolNames: readonly string[];
    authorizedReads: AuthorizedTaskReads;
  }): Promise<{
    policy: TaskWorkingSetPolicy;
    ledger: CognitiveBudgetLedger;
    capabilities: Record<string, unknown>;
  }>;
}

export function createCognitiveWorkingSetProvider(deps: {
  budget: WorkerLoadEnvelope;
  resolveRoleBudget?: (loadPolicyRef: string) => Partial<CognitiveBudget> | undefined;
}): CognitiveWorkingSetProvider {
  return {
    async build(input) {
      let budget: CognitiveBudget = { ...deps.budget.task };
      if (input.loadPolicyRef) {
        const rolePolicy = deps.resolveRoleBudget?.(input.loadPolicyRef);
        if (!rolePolicy) throw new Error(`cognitive working set: unknown role load policy ref ${input.loadPolicyRef}`);
        for (const axis of Object.keys(budget) as Array<keyof CognitiveBudget>) {
          const declared = rolePolicy[axis];
          if (typeof declared === "number" && Number.isFinite(declared)) {
            budget[axis] = Math.min(budget[axis], declared);
          }
        }
      }

      const summaries = await input.authorizedReads.listSkills();   // 恰好一次真实读取
      const canonical = (id: string): string => (id.startsWith("skill:") ? id : `skill:${id}`);
      const scored = summaries.map((summary) => {
        const id = canonical(summary.id);
        const scoringText = `${id}\n${summary.anchor}\n${summary.whenToUse}\n${summary.effect}`;
        const hits = knowledgeQueryTokenHits({ id, content: scoringText }, `${input.title}\n${input.text}`);
        return { summary, id, hits };
      }).sort((a, b) => (b.hits - a.hits) || a.id.localeCompare(b.id));

      const { policy, ledger } = createTaskWorkingSetPolicy({
        taskId: input.taskId,
        worker: input.worker,
        directorySnapshotId: input.directorySnapshotId,
        budget,
        skillIndexItems: scored.map((item) => ({ id: item.id, chars: canonicalExposureChars(item.summary) })),
        pinnedToolNames: input.staticToolNames,
        candidateToolNames: input.registryToolNames,
      });

      const admittedSet = new Set(policy.skillIndexIds);
      const admittedSummaries: SkillSummary[] = scored
        .filter((item) => admittedSet.has(item.id))
        .map((item) => Object.freeze({ ...item.summary, id: item.id }));
      Object.freeze(admittedSummaries);

      const capabilities = createBudgetedTaskCapabilities(
        input.baseCaps,
        policy,
        ledger,
        input.authorizedReads,
        { skillSummaries: admittedSummaries },
      );
      return { policy, ledger, capabilities };
    },
  };
}
