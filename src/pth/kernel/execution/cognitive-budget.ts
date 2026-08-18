/**
 * kernel/execution/cognitive-budget.ts —— N28 T5 任务级认知预算账本。
 *
 * 单次任务的 memory / Skill / Tool 三个暴露面共用这一本账；所有输入 ID 由调用方
 * 按 score 排序后进入（平局按 ID/name），账本只做单调、确定性的硬上限裁决。
 * canonicalExposureChars 只对实际返回/注入的规范化投影计字节（key 排序 + UTF-8 JSON）。
 */

import { createHash } from "node:crypto";
import type { CognitiveBudget, PendingRetrievalTrace, RetrievalTrace } from "../../contracts/index.js";

export class CognitiveBudgetExceededError extends Error {
  constructor(axis: string, limit: number, current: number) {
    super(`cognitive-budget-exceeded: ${axis}（limit=${limit}, current=${current}）`);
    this.name = "CognitiveBudgetExceededError";
  }
}

/** 规范化暴露投影 → UTF-8 JSON bytes（对象 key 排序；只计实际暴露字段）。 */
export function canonicalExposureChars(value: unknown): number {
  const normalize = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(normalize);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort((a, b) => a.localeCompare(b))
          .map((key) => [key, normalize((v as Record<string, unknown>)[key])]),
      );
    }
    return v;
  };
  return Buffer.byteLength(JSON.stringify(normalize(value)), "utf8");
}

interface SkillIndexItem {
  id: string;
  summaryChars: number;
}

export class CognitiveBudgetLedger {
  private readonly memoryEntryIds: string[] = [];
  private readonly chargedMemoryChars = new Map<string, number>();
  private readonly skillIndexItems = new Map<string, SkillIndexItem>();
  private readonly skillIndexIds: string[] = [];
  private readonly activeSkillIds: string[] = [];
  private readonly chargedSkillChars = new Map<string, number>();
  private toolNames: string[] = [];
  private readonly retrievalTraces: RetrievalTrace[] = [];
  private callIndex = 0;
  private readonly omitted: Record<string, number> = {};

  constructor(readonly input: {
    taskId: string;
    workerId: string;
    directorySnapshotId: string;
    budget: CognitiveBudget;
  }) {}

  private omit(id: string): void {
    this.omitted[id] = (this.omitted[id] ?? 0) + 1;
  }

  admitMemory<T extends { id: string; chars: number }>(items: readonly T[]): { accepted: T[]; omitted: T[] } {
    const accepted: T[] = [];
    const omittedItems: T[] = [];
    const seen = new Set<string>();
    let memoryEntries = this.memoryEntryIds.length;
    let memoryChars = this.usageMemoryChars();

    for (const item of items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      const previous = this.chargedMemoryChars.get(item.id);
      if (previous !== undefined) {
        const delta = item.chars - previous;
        if (delta <= 0) {
          accepted.push(item);
          continue;
        }
        if (memoryChars + delta > this.input.budget.maxMemoryChars) {
          this.omit(item.id);
          omittedItems.push(item);
          continue;
        }
        this.chargedMemoryChars.set(item.id, item.chars);
        memoryChars += delta;
        accepted.push(item);
        continue;
      }
      if (memoryEntries + 1 > this.input.budget.maxMemoryEntries || memoryChars + item.chars > this.input.budget.maxMemoryChars) {
        this.omit(item.id);
        omittedItems.push(item);
        continue;
      }
      this.memoryEntryIds.push(item.id);
      this.chargedMemoryChars.set(item.id, item.chars);
      memoryEntries += 1;
      memoryChars += item.chars;
      accepted.push(item);
    }
    return { accepted, omitted: omittedItems };
  }

  private usageMemoryChars(): number {
    let total = 0;
    for (const value of this.chargedMemoryChars.values()) total += value;
    return total;
  }

  freezeSkillIndex(items: readonly { id: string; chars: number }[]): readonly string[] {
    const seen = new Set<string>();
    let skillChars = this.usageSkillChars();
    // 确定性冻结：输入反序也必须得到同一 skillIndexIds（按 id 字典序取预算内子集）。
    for (const item of [...items].sort((a, b) => a.id.localeCompare(b.id))) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      if (this.skillIndexIds.length + 1 > this.input.budget.maxSkillIndexEntries) {
        this.omit(item.id);
        continue;
      }
      if (skillChars + item.chars > this.input.budget.maxSkillChars) {
        this.omit(item.id);
        continue;
      }
      this.skillIndexIds.push(item.id);
      this.skillIndexItems.set(item.id, { id: item.id, summaryChars: item.chars });
      skillChars += item.chars;
      this.chargedSkillChars.set(item.id, item.chars);
    }
    return [...this.skillIndexIds];
  }

  private usageSkillChars(): number {
    let total = 0;
    for (const value of this.chargedSkillChars.values()) total += value;
    return total;
  }

  activateSkill(id: string, chars: number): boolean {
    const indexed = this.skillIndexItems.get(id);
    if (!indexed) throw new Error(`skill ${id} not in frozen skill index`);
    const isActive = this.activeSkillIds.includes(id);
    const previous = this.chargedSkillChars.get(id) ?? 0;
    const delta = chars - previous;
    if (delta > 0 && this.usageSkillChars() + delta > this.input.budget.maxSkillChars) {
      this.omit(id);
      return false;
    }
    if (!isActive) {
      if (this.activeSkillIds.length + 1 > this.input.budget.maxActiveSkills) {
        this.omit(id);
        return false;
      }
      this.activeSkillIds.push(id);
    }
    if (delta > 0) this.chargedSkillChars.set(id, chars);
    return true;
  }

  freezeTools(pinned: readonly string[], candidates: readonly string[]): readonly string[] {
    const pinnedUnique: string[] = [];
    const seen = new Set<string>();
    for (const name of pinned) {
      if (seen.has(name)) continue;
      seen.add(name);
      pinnedUnique.push(name);
    }
    if (pinnedUnique.length > this.input.budget.maxTools) throw new Error("pinned tools exceed");
    this.toolNames = [...pinnedUnique];
    for (const name of [...candidates].sort((a, b) => a.localeCompare(b))) {
      if (seen.has(name)) continue;
      if (this.toolNames.length >= this.input.budget.maxTools) {
        this.omit(name);
        continue;
      }
      seen.add(name);
      this.toolNames.push(name);
    }
    return [...this.toolNames];
  }

  recordRetrievalTrace(trace: PendingRetrievalTrace): RetrievalTrace {
    if (trace.directorySnapshotId !== this.input.directorySnapshotId || trace.workerId !== this.input.workerId) {
      throw new Error("retrieval trace binding mismatch（directory/worker 与 ledger 不一致）");
    }
    const callIndex = this.callIndex;
    this.callIndex += 1;
    const traceIdInput = [
      this.input.taskId,
      this.input.directorySnapshotId,
      this.input.workerId,
      trace.queryFingerprint,
      String(callIndex),
    ].join("|");
    const traceId = `tr-${createHash("sha256").update(traceIdInput).digest("hex").slice(0, 16)}`;
    const completed: RetrievalTrace = Object.freeze({
      directorySnapshotId: trace.directorySnapshotId,
      workerId: trace.workerId,
      queryFingerprint: trace.queryFingerprint,
      waves: Object.freeze(trace.waves.map((wave) => Object.freeze({ ...wave, regionIds: Object.freeze([...wave.regionIds]) }))),
      globalFallback: trace.globalFallback,
      omitted: Object.freeze({ ...trace.omitted }),
      status: trace.status,
      traceId,
      callIndex,
    });
    this.retrievalTraces.push(completed);
    return completed;
  }

  snapshot(): {
    usage: {
      memoryEntries: number;
      memoryChars: number;
      skillIndexEntries: number;
      activeSkills: number;
      skillChars: number;
      tools: number;
    };
    memoryEntryIds: string[];
    skillIndexIds: string[];
    activeSkillIds: string[];
    toolNames: string[];
    retrievalTraces: RetrievalTrace[];
    omitted: Record<string, number>;
  } {
    return {
      usage: {
        memoryEntries: this.memoryEntryIds.length,
        memoryChars: this.usageMemoryChars(),
        skillIndexEntries: this.skillIndexIds.length,
        activeSkills: this.activeSkillIds.length,
        skillChars: this.usageSkillChars(),
        tools: this.toolNames.length,
      },
      memoryEntryIds: [...this.memoryEntryIds],
      skillIndexIds: [...this.skillIndexIds],
      activeSkillIds: [...this.activeSkillIds],
      toolNames: [...this.toolNames],
      retrievalTraces: this.retrievalTraces.map((trace) => Object.freeze({
        ...trace,
        waves: Object.freeze(trace.waves.map((wave) => Object.freeze({ ...wave, regionIds: Object.freeze([...wave.regionIds]) }))),
        omitted: Object.freeze({ ...trace.omitted }),
      })),
      omitted: { ...this.omitted },
    };
  }
}
