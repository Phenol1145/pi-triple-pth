/**
 * runner/cognitive-working-set.ts —— N28 T5 任务工作集 policy 与预算化 capability facade。
 *
 * TaskWorkingSetPolicy 在任务开始冻结；TaskWorkingSet 随合法 memory/knowledge 展开和
 * skills.get 单调增长，每次增长先消费同一个 CognitiveBudgetLedger。
 * 本模块只包装读路径；write/maintain/review/promotion/task-control 一概不碰。
 */

import type { MemoryEntry, SkillSummary } from "@away_from/pth-memory";
import type { CognitiveBudget, TaskWorkingSetPolicy, WorkerReplicaRef } from "../contracts/index.js";
import { canonicalExposureChars, CognitiveBudgetExceededError, CognitiveBudgetLedger } from "../kernel/execution/cognitive-budget.js";
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
      const admitted = ledger.admitMemory(entries.map((entry) => ({ id: String(entry.id), chars: canonicalExposureChars(entry) })));
      const allowed = new Set(admitted.accepted.map((item) => item.id));
      return entries.filter((entry) => allowed.has(String(entry.id)));
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
      const admitted = ledger.admitMemory(rows.map((row) => ({ id: String(row.id), chars: canonicalExposureChars(row) })));
      const allowed = new Set(admitted.accepted.map((item) => item.id));
      return rows.filter((row) => allowed.has(String(row.id)));
    },
  };

  out["state"] = {
    ...((base["state"] as Record<string, unknown> | undefined) ?? {}),
    async recallFunctions(anchors: string[], opts?: { limit?: number }): Promise<Array<{ key: string; source: string; spec: unknown }>> {
      const rows = await adapters.recallFunctions(anchors, opts);
      ledger.admitMemory(rows.map((row) => ({ id: row.id, chars: canonicalExposureChars({ key: row.key, source: row.source, spec: row.spec }) })));
      return rows.map(({ key, source, spec }) => ({ key, source, spec }));
    },
    async recallInsights(anchors: string[], opts?: { limit?: number }): Promise<Array<{ content: string }>> {
      const rows = await adapters.recallInsights(anchors, opts);
      ledger.admitMemory(rows.map((row) => ({ id: row.id, chars: canonicalExposureChars({ content: row.content }) })));
      return rows.map(({ content }) => ({ content }));
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
