/**
 * contracts/cognitive-responsibility.ts —— N28 认知责任契约（可行性阶段统一接口事实源）。
 *
 * 对应设计 `docs/pth/n28-role-memory-orchestration-design.md`：
 *  - §2.2 核心契约（Role/Worker/MemoryRegion/Responsibility/预算类型）
 *  - §5.3 Retrieval Trace
 *  - §6.2 Task Working Set
 * §4.1 的 Directory 类型（RegionMembership/DirectoryEntryInput/MemoryDirectorySnapshot）
 * 由 `execution/memory-directory.ts` 独家拥有，本文件不得重复定义（跨 lane 裁决 C1）。
 *
 * 本文件只含纯类型、常量与纯函数；不 import 任何运行时实现。
 */

export interface RoleDefinitionRef {
  roleId: string;
  revision: string;
}

export interface WorkerReplicaRef {
  /** 全系统唯一 UUID；batchId 只表达宿主生命周期，不参与消歧。 */
  workerId: string;
  batchId: string;
  role: RoleDefinitionRef;
}

/** 五类共享记忆（v1.3 P0）：Index Memory 只存导航元数据，绝不存正文。 */
export const MEMORY_TYPES = ["setting", "wiki", "skill", "log", "index"] as const;

export type MemoryType = (typeof MEMORY_TYPES)[number];

export interface MemoryRegionSelector {
  domains?: readonly string[];
  memoryTypes?: readonly MemoryType[];
  kinds?: readonly string[];
  anchorsAny?: readonly string[];
  anchorPrefixes?: readonly string[];
}

export interface MemoryRegion {
  regionId: string;
  revision: number;
  mode?: "selector" | "unclassified";
  selector: MemoryRegionSelector;
  estimatedWeight: number;
}

export type MemoryResponsibilityKind = "primary" | "overlap" | "fallback";

export interface MemoryResponsibility {
  workerId: string;
  regionId: string;
  regionRevision: number;
  kind: MemoryResponsibilityKind;
  priority: number;
  epoch: number;
}

export interface ResponsibilityCapacity {
  maxRegions: number;
  maxPrimaryWeight: number;
  /** overlap 与 fallback 都计入，避免非主责任绕过固定负载。 */
  maxSecondaryWeight: number;
}

export interface CognitiveBudget {
  maxMemoryEntries: number;
  maxMemoryChars: number;
  maxSkillIndexEntries: number;
  maxActiveSkills: number;
  maxSkillChars: number;
  maxTools: number;
}

export interface WorkerLoadEnvelope {
  responsibility: ResponsibilityCapacity;
  task: CognitiveBudget;
}

export interface RetrievalWaveTrace {
  wave: 0 | 1 | 2 | 3;
  regionIds: readonly string[];
  candidateCount: number;
  visibleCount: number;
  selectedCount: number;
  scannedCount: number;
  completeForQuery: boolean;
  reason: string;
  /** N28 T7/P1-1：每波实际进入 merged/rank/limit 的 entry id 列表（final Working Set 精确对账用）。 */
  selectedEntryIds: readonly string[];
}

export interface PendingRetrievalTrace {
  directorySnapshotId: string;
  workerId: string;
  queryFingerprint: string;
  waves: readonly RetrievalWaveTrace[];
  globalFallback: boolean;
  omitted: Readonly<Record<string, number>>;
  status: "found" | "exhausted-empty" | "retrieval-incomplete" | "retrieval-failed";
}

export interface RetrievalTrace extends PendingRetrievalTrace {
  traceId: string;
  callIndex: number;
}

export interface TaskWorkingSetPolicy {
  taskId: string;
  worker: WorkerReplicaRef;
  directorySnapshotId: string;
  budget: CognitiveBudget;
  skillIndexIds: readonly string[];
  toolNames: readonly string[];
}

export interface TaskWorkingSet {
  taskId: string;
  worker: WorkerReplicaRef;
  directorySnapshotId: string;
  memoryEntryIds: readonly string[];
  skillIndexIds: readonly string[];
  activeSkillIds: readonly string[];
  toolNames: readonly string[];
  usage: {
    memoryEntries: number;
    memoryChars: number;
    skillIndexEntries: number;
    activeSkills: number;
    skillChars: number;
    tools: number;
  };
  omitted: Readonly<Record<string, number>>;
  retrievalTraces: readonly RetrievalTrace[];
}

/** 可行性阶段实验预算（不进入生产配置默认值）。 */
export const N28_FEASIBILITY_BUDGET: WorkerLoadEnvelope = Object.freeze({
  responsibility: Object.freeze({
    maxRegions: 3,
    maxPrimaryWeight: 80,
    maxSecondaryWeight: 40,
  }),
  task: Object.freeze({
    maxMemoryEntries: 8,
    maxMemoryChars: 4096,
    maxSkillIndexEntries: 8,
    maxActiveSkills: 4,
    maxSkillChars: 8192,
    maxTools: 16,
  }),
});

export type ResponsibilityCapacityResult =
  | { ok: true; usage: { regions: number; primaryWeight: number; secondaryWeight: number } }
  | { ok: false; reason: "worker-mismatch" | "unknown-region" | "region-revision" | "invalid-weight" | "duplicate-responsibility" | "region-count" | "primary-weight" | "secondary-weight" };

export function checkResponsibilityCapacity(
  worker: WorkerReplicaRef,
  regions: readonly MemoryRegion[],
  responsibilities: readonly MemoryResponsibility[],
  capacity: ResponsibilityCapacity,
): ResponsibilityCapacityResult {
  const byId = new Map(regions.map((region) => [region.regionId, region] as const));
  let primaryWeight = 0;
  let secondaryWeight = 0;
  const seen = new Set<string>();
  for (const responsibility of responsibilities) {
    if (responsibility.workerId !== worker.workerId) return { ok: false, reason: "worker-mismatch" };
    const region = byId.get(responsibility.regionId);
    if (!region) return { ok: false, reason: "unknown-region" };
    if (region.revision !== responsibility.regionRevision) return { ok: false, reason: "region-revision" };
    if (!Number.isFinite(region.estimatedWeight) || region.estimatedWeight < 0) return { ok: false, reason: "invalid-weight" };
    const bindingKey = `${responsibility.workerId}|${responsibility.regionId}`;
    if (seen.has(bindingKey)) return { ok: false, reason: "duplicate-responsibility" };
    seen.add(bindingKey);
    if (responsibility.kind === "primary") primaryWeight += region.estimatedWeight;
    else secondaryWeight += region.estimatedWeight;
  }
  const usage = { regions: responsibilities.length, primaryWeight, secondaryWeight };
  if (usage.regions > capacity.maxRegions) return { ok: false, reason: "region-count" };
  if (usage.primaryWeight > capacity.maxPrimaryWeight) return { ok: false, reason: "primary-weight" };
  if (usage.secondaryWeight > capacity.maxSecondaryWeight) return { ok: false, reason: "secondary-weight" };
  return { ok: true, usage };
}
