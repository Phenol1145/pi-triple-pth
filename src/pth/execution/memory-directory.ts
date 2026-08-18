/**
 * execution/memory-directory.ts —— N28 T3 确定性内存 MemoryDirectory。
 *
 * 本文件独家拥有设计 §4.1 类型（RegionMembership / DirectoryEntryInput /
 * MemoryDirectorySnapshot）——T1 contracts 模块不得重复定义（跨 lane 裁决 C1）。
 * 快照：单 tenant、不可变、确定排序；membership 只保存复合身份/revision/哈希/regionIds，
 * 不保存正文；official 条目未命中声明 Region 必须进入显式 `region:unclassified`。
 */

import { createHash } from "node:crypto";
import { checkResponsibilityCapacity } from "../contracts/index.js";
import type { MemoryRegion, MemoryResponsibility, MemoryType, ResponsibilityCapacity, WorkerReplicaRef } from "../contracts/index.js";
import type { KnowledgeMemoryEntry } from "./knowledge-broker.js";

export interface RegionMembership {
  tenantId: string;
  entryId: string;
  entryRevision: number;
  contentHash: string;
  indexHash: string;
  regionIds: readonly string[];
}

export interface MemoryDirectorySnapshot {
  tenantId: string;
  epoch: number;
  snapshotId: string;
  corpusFingerprint: string;
  workers: readonly WorkerReplicaRef[];
  regions: readonly MemoryRegion[];
  responsibilities: readonly MemoryResponsibility[];
  memberships: readonly RegionMembership[];
  unclassifiedEntryIds: readonly string[];
}

/** 由 tenant-scoped repository/projection 提供；revision 不得从松散 meta 猜测。 */
export interface DirectoryEntryInput {
  entry: KnowledgeMemoryEntry & { tenantId: string };
  revision: number;
  memoryType: MemoryType;
}

function matches(region: MemoryRegion, input: DirectoryEntryInput): boolean {
  if (region.mode === "unclassified") return false;
  const entry = input.entry;
  const selector = region.selector;
  const anchors = new Set(entry.anchors);
  const domains = new Set(Array.isArray(entry.meta?.["domains"]) ? entry.meta!["domains"] as string[] : []);
  if (selector.domains?.length && !selector.domains.some((domain) => domains.has(domain))) return false;
  if (selector.memoryTypes?.length && !selector.memoryTypes.includes(input.memoryType)) return false;
  if (selector.kinds?.length && !selector.kinds.includes(entry.kind)) return false;
  if (selector.anchorsAny?.length && !selector.anchorsAny.some((anchor) => anchors.has(anchor))) return false;
  if (selector.anchorPrefixes?.length && !entry.anchors.some((anchor) => selector.anchorPrefixes!.some((prefix) => anchor.startsWith(prefix)))) return false;
  return Boolean(selector.domains?.length || selector.memoryTypes?.length || selector.kinds?.length || selector.anchorsAny?.length || selector.anchorPrefixes?.length);
}

function stable<T>(values: readonly T[], key: (value: T) => string): T[] {
  return [...values].sort((a, b) => key(a).localeCompare(key(b)));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function buildMemoryDirectorySnapshot(
  input: {
    tenantId: string;
    epoch: number;
    knownDomainIds: ReadonlySet<string>;
    workers: readonly WorkerReplicaRef[];
    regions: readonly MemoryRegion[];
    responsibilities: readonly MemoryResponsibility[];
    entries: readonly DirectoryEntryInput[];
  },
): MemoryDirectorySnapshot {
  if (!input.tenantId || !Number.isInteger(input.epoch) || input.epoch < 1) throw new Error("invalid tenant/epoch");
  const workers = stable(input.workers.map((worker) => ({ ...worker, role: { ...worker.role } })), (worker) => worker.workerId);
  if (new Set(workers.map((worker) => worker.workerId)).size !== workers.length) throw new Error("duplicate worker id");
  const workerIds = new Set(workers.map((worker) => worker.workerId));
  const regionSpecs = stable(input.regions.map((region) => ({
    ...region,
    selector: Object.fromEntries(Object.entries(region.selector).map(([key, values]) => [key, values ? [...values] : values])) as MemoryRegion["selector"],
  })), (region) => `${region.regionId}@${region.revision}`);
  if (new Set(regionSpecs.map((region) => region.regionId)).size !== regionSpecs.length) throw new Error("duplicate region");
  if (!regionSpecs.some((region) => region.regionId === "region:unclassified" && region.mode === "unclassified")) throw new Error("missing explicit unclassified region");
  for (const region of regionSpecs) {
    if (!Number.isFinite(region.estimatedWeight) || region.estimatedWeight < 0) throw new Error("invalid region weight");
    if (region.mode !== "unclassified" && Object.values(region.selector).every((values) => !Array.isArray(values) || values.length === 0)) throw new Error("empty selector");
    if (region.selector.domains?.some((domain) => !input.knownDomainIds.has(domain))) throw new Error("unknown selector domain");
  }
  const responsibilities = stable(input.responsibilities.map((item) => ({ ...item })), (item) => `${item.workerId}|${item.kind}|${String(item.priority).padStart(8, "0")}|${item.regionId}`);
  const regionById = new Map(regionSpecs.map((region) => [region.regionId, region] as const));
  const bindingKeys = new Set<string>();
  for (const item of responsibilities) {
    if (!workerIds.has(item.workerId)) throw new Error("responsibility references unknown worker");
    if (item.epoch !== input.epoch) throw new Error("responsibility epoch mismatch");
    const region = regionById.get(item.regionId);
    if (!region || region.revision !== item.regionRevision) throw new Error("unknown region revision");
    const key = `${item.workerId}|${item.regionId}`;
    if (bindingKeys.has(key)) throw new Error("duplicate responsibility");
    bindingKeys.add(key);
  }
  for (const region of regionSpecs) {
    if (!responsibilities.some((item) => item.regionId === region.regionId && item.kind === "primary")) throw new Error(`region ${region.regionId} has no primary owner`);
  }
  const entries = stable(input.entries, (item) => item.entry.id);
  if (new Set(entries.map((item) => item.entry.id)).size !== entries.length) throw new Error("duplicate tenant entry identity");
  for (const item of entries) {
    const entry = item.entry;
    if (entry.tenantId !== input.tenantId) throw new Error("cross-tenant directory entry");
    if (!Number.isInteger(item.revision) || item.revision < 1) throw new Error("invalid entry revision");
    if (!["setting", "wiki", "skill", "log"].includes(item.memoryType)) throw new Error("invalid memory type");
    if (entry.status !== "official") throw new Error("directory accepts official entries only");
    const domains = Array.isArray(entry.meta?.["domains"]) ? entry.meta!["domains"] as string[] : [];
    if (domains.some((domain) => !input.knownDomainIds.has(domain))) throw new Error("unknown entry domain");
  }
  const memberships = entries.map((item) => {
    const entry = item.entry;
    const matched = regionSpecs.filter((region) => matches(region, item)).map((region) => region.regionId);
    return {
      tenantId: input.tenantId,
      entryId: entry.id,
      entryRevision: item.revision,
      contentHash: createHash("sha256").update(entry.content).digest("hex"),
      indexHash: createHash("sha256").update(JSON.stringify({ memoryType: item.memoryType, kind: entry.kind, anchors: [...entry.anchors].sort(), domains: [...(Array.isArray(entry.meta?.["domains"]) ? entry.meta!["domains"] as string[] : [])].sort(), status: entry.status })).digest("hex"),
      regionIds: matched.length ? matched : ["region:unclassified"],
    };
  });
  const entryById = new Map(entries.map((item) => [item.entry.id, item.entry] as const));
  const regions = regionSpecs.map((region) => {
    const memberIds = memberships.filter((membership) => membership.regionIds.includes(region.regionId)).map((membership) => membership.entryId);
    const totalContentChars = memberIds.reduce((sum, entryId) => sum + (entryById.get(entryId)?.content.length ?? 0), 0);
    const selectorClauseCount =
      (region.selector.domains?.length ?? 0) +
      (region.selector.memoryTypes?.length ?? 0) +
      (region.selector.kinds?.length ?? 0) +
      (region.selector.anchorsAny?.length ?? 0) +
      (region.selector.anchorPrefixes?.length ?? 0);
    return {
      ...region,
      estimatedWeight: memberIds.length + Math.ceil(totalContentChars / 4096) + selectorClauseCount,
    };
  });
  const unclassifiedEntryIds = memberships.filter((membership) => membership.regionIds.includes("region:unclassified")).map((membership) => membership.entryId);
  const corpusFingerprint = createHash("sha256").update(JSON.stringify(memberships.map(({ tenantId, entryId, entryRevision, contentHash, indexHash }) => ({ tenantId, entryId, entryRevision, contentHash, indexHash })))).digest("hex");
  const digestInput = JSON.stringify({ tenantId: input.tenantId, epoch: input.epoch, corpusFingerprint, workers, regions, responsibilities, memberships });
  const snapshotId = `md-${createHash("sha256").update(digestInput).digest("hex").slice(0, 16)}`;
  return deepFreeze({ tenantId: input.tenantId, epoch: input.epoch, snapshotId, corpusFingerprint, workers, regions, responsibilities, memberships, unclassifiedEntryIds });
}

export function responsibilitiesForWorker(directory: MemoryDirectorySnapshot, workerId: string): MemoryResponsibility[] {
  return directory.responsibilities.filter((item) => item.workerId === workerId);
}

export function membershipsForEntry(directory: MemoryDirectorySnapshot, entryId: string): readonly string[] {
  return directory.memberships.find((membership) => membership.entryId === entryId)?.regionIds ?? [];
}

export function regionEntryIds(directory: MemoryDirectorySnapshot, regionId: string): string[] {
  return directory.memberships.filter((membership) => membership.regionIds.includes(regionId)).map((membership) => membership.entryId);
}

export function assertMemoryDirectoryResponsibilityCapacity(
  directory: MemoryDirectorySnapshot,
  capacity: ResponsibilityCapacity,
): void {
  for (const worker of directory.workers) {
    const result = checkResponsibilityCapacity(
      worker,
      directory.regions,
      responsibilitiesForWorker(directory, worker.workerId),
      capacity,
    );
    if (!result.ok) throw new Error(`worker responsibility capacity exceeded: ${worker.workerId}:${result.reason}`);
  }
}

export function assertMemoryDirectorySnapshotIntegrity(
  directory: MemoryDirectorySnapshot,
  source: { knownDomainIds: ReadonlySet<string>; entries: readonly DirectoryEntryInput[] },
): void {
  try {
    const rebuilt = buildMemoryDirectorySnapshot({
      tenantId: directory.tenantId,
      epoch: directory.epoch,
      knownDomainIds: source.knownDomainIds,
      workers: directory.workers,
      regions: directory.regions,
      responsibilities: directory.responsibilities,
      entries: source.entries,
    });
    if (rebuilt.snapshotId !== directory.snapshotId || rebuilt.corpusFingerprint !== directory.corpusFingerprint || JSON.stringify(rebuilt) !== JSON.stringify(directory)) {
      throw new Error("snapshot differs");
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`memory directory snapshot integrity mismatch: ${detail}`);
  }
}
