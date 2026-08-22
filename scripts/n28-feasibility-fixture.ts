/**
 * scripts/n28-feasibility-fixture.ts —— N28 可行性确定性语料/身份 fixture（冻结）。
 *
 * 输入相同 → 输出完全确定；T3/T4/T6/T7 的 Vitest 与 CLI 都从本文件取语料、
 * worker refs、regions、responsibilities 与 gold queries，互相不 import。
 */

import type { KnowledgeMemoryEntry } from "../src/pth/execution/knowledge-broker.js";
import { N28_FEASIBILITY_BUDGET, type CognitiveBudget } from "../src/pth/contracts/index.js";
import { classifyFeasibilityMemoryType } from "../src/pth/execution/memory-type-classifier.js";
import { MID_ROLES } from "../src/pth/kernel/execution/builtin-roles.js";
import type { RoleDefinition } from "../src/pth/kernel/execution/worker-cluster.js";
import { roleDefinitionRevision } from "../src/pth/kernel/execution/worker-replica.js";

const researcher = MID_ROLES.find((role) => role.id === "researcher")!;
export const N28_ROLE = {
  ...researcher,
  capabilities: [...new Set([...(researcher.capabilities ?? []), "memory.query", "state", "skills"])],
  loadPolicyRef: "n28-feasibility-v1",
} satisfies RoleDefinition;
Object.freeze(N28_ROLE.capabilities);
Object.freeze(N28_ROLE);
export const N28_ROLE_REVISION = roleDefinitionRevision(N28_ROLE);
export const N28_ROLE_LOAD_POLICIES: ReadonlyMap<string, Readonly<CognitiveBudget>> = new Map<string, Readonly<CognitiveBudget>>([
  ["n28-feasibility-v1", Object.freeze({ ...N28_FEASIBILITY_BUDGET.task })],
]);
export const N28_DOMAIN_IDS = new Set(["algebra", "geometry", "mathematics"]);

export type N28KnowledgeEntry = KnowledgeMemoryEntry & { tenantId: string };

function rows(prefix: string, count: number, domains: string[], anchors: string[], contentPrefix: string): N28KnowledgeEntry[] {
  return Array.from({ length: count }, (_, index) => {
    const id = `${prefix}-${String(index + 1).padStart(2, "0")}`;
    return {
      id,
      tenantId: "tenant-a",
      kind: index % 4 === 0 ? "domain-method" : "domain-fact",
      anchors,
      status: "official",
      content: `${contentPrefix} token:${id}`,
      meta: { domains, spaceScope: { space: "meta", visibility: "public" } },
    };
  });
}

export function n28AuthorizedCorpus(): N28KnowledgeEntry[] {
  const algebra = rows("alg", 40, ["algebra"], ["mathematics", "algebra-core"], "algebra theorem");
  algebra[34] = { ...algebra[34]!, kind: "system-setting" };
  algebra[35] = { ...algebra[35]!, kind: "skill" };
  algebra[36] = { ...algebra[36]!, kind: "task-insight" };
  algebra[38] = { ...algebra[38]!, content: `${algebra[38]!.content} bounded global target decoy` };
  algebra[39] = { ...algebra[39]!, anchors: [...algebra[39]!.anchors, "numerical"] };
  return [
    ...algebra,
    ...rows("geo", 40, ["geometry"], ["mathematics", "geometry-core"], "geometry theorem"),
    ...rows("num", 10, ["mathematics"], ["mathematics", "numerical"], "numerical method"),
    ...rows("shared", 8, ["mathematics"], ["mathematics", "shared-method"], "shared mathematical method"),
    { id: "global-only", tenantId: "tenant-a", kind: "domain-fact", anchors: ["mathematics", "global-only"], status: "official", content: "bounded global target canonical", meta: { domains: ["mathematics"], spaceScope: { space: "meta", visibility: "public" } } },
    { id: "unclassified-only", tenantId: "tenant-a", kind: "domain-fact", anchors: ["orphan-anchor"], status: "official", content: "unclassified target", meta: { domains: [], spaceScope: { space: "meta", visibility: "public" } } },
  ];
}

export function n28DirectoryInputs(
  entries: readonly N28KnowledgeEntry[] = n28AuthorizedCorpus(),
  revisions: ReadonlyMap<string, number> = new Map(),
) {
  return entries.map((entry) => {
    const memoryType = classifyFeasibilityMemoryType(entry);
    if (!memoryType) throw new Error(`unclassified memory kind: ${entry.kind}`);
    return { entry, revision: revisions.get(entry.id) ?? 1, memoryType };
  });
}

export const N28_WORKERS = {
  algebra: {
    workerId: "10000000-0000-4000-8000-000000000011",
    batchId: "batch-n28",
    role: { roleId: "researcher", revision: N28_ROLE_REVISION },
  },
  geometry: {
    workerId: "10000000-0000-4000-8000-000000000012",
    batchId: "batch-n28",
    role: { roleId: "researcher", revision: N28_ROLE_REVISION },
  },
  curator: {
    workerId: "10000000-0000-4000-8000-000000000013",
    batchId: "batch-n28",
    role: { roleId: "researcher", revision: N28_ROLE_REVISION },
  },
  global: {
    workerId: "10000000-0000-4000-8000-000000000014",
    batchId: "batch-n28",
    role: { roleId: "researcher", revision: N28_ROLE_REVISION },
  },
} as const;

export const N28_REGIONS = [
  { regionId: "region:algebra", revision: 1, mode: "selector", selector: { domains: ["algebra"] }, estimatedWeight: 0 },
  { regionId: "region:geometry", revision: 1, mode: "selector", selector: { domains: ["geometry"] }, estimatedWeight: 0 },
  { regionId: "region:numerical", revision: 1, selector: { anchorsAny: ["numerical"] }, estimatedWeight: 0 },
  { regionId: "region:shared", revision: 1, selector: { anchorsAny: ["shared-method"] }, estimatedWeight: 0 },
  { regionId: "region:global-holdout", revision: 1, selector: { anchorsAny: ["global-only"] }, estimatedWeight: 0 },
  { regionId: "region:unclassified", revision: 1, mode: "unclassified", selector: {}, estimatedWeight: 0 },
] as const;

export const N28_RESPONSIBILITIES = [
  { workerId: N28_WORKERS.algebra.workerId, regionId: "region:algebra", regionRevision: 1, kind: "primary", priority: 0, epoch: 1 },
  { workerId: N28_WORKERS.algebra.workerId, regionId: "region:numerical", regionRevision: 1, kind: "overlap", priority: 0, epoch: 1 },
  { workerId: N28_WORKERS.algebra.workerId, regionId: "region:shared", regionRevision: 1, kind: "fallback", priority: 0, epoch: 1 },
  { workerId: N28_WORKERS.geometry.workerId, regionId: "region:geometry", regionRevision: 1, kind: "primary", priority: 0, epoch: 1 },
  { workerId: N28_WORKERS.geometry.workerId, regionId: "region:numerical", regionRevision: 1, kind: "overlap", priority: 0, epoch: 1 },
  { workerId: N28_WORKERS.geometry.workerId, regionId: "region:shared", regionRevision: 1, kind: "fallback", priority: 0, epoch: 1 },
  { workerId: N28_WORKERS.curator.workerId, regionId: "region:shared", regionRevision: 1, kind: "primary", priority: 0, epoch: 1 },
  { workerId: N28_WORKERS.curator.workerId, regionId: "region:unclassified", regionRevision: 1, kind: "primary", priority: 1, epoch: 1 },
  { workerId: N28_WORKERS.global.workerId, regionId: "region:global-holdout", regionRevision: 1, kind: "primary", priority: 0, epoch: 1 },
  { workerId: N28_WORKERS.global.workerId, regionId: "region:numerical", regionRevision: 1, kind: "primary", priority: 1, epoch: 1 },
] as const;

export function n28TrapCorpus(): N28KnowledgeEntry[] {
  return [
    { id: "trap-tenant", tenantId: "tenant-b", kind: "domain-fact", anchors: ["algebra"], status: "official", content: "tenant trap", meta: { domains: ["algebra"], spaceScope: { space: "meta", visibility: "public" } } },
    { id: "trap-space", tenantId: "tenant-a", kind: "domain-fact", anchors: ["algebra"], status: "official", content: "space trap", meta: { domains: ["algebra"], spaceScope: { space: "private-other", visibility: "private" } } },
    { id: "trap-draft", tenantId: "tenant-a", kind: "domain-fact", anchors: ["algebra"], status: "draft", content: "draft trap", meta: { domains: ["algebra"], spaceScope: { space: "meta", visibility: "public" } } },
    { id: "trap-archived", tenantId: "tenant-a", kind: "domain-fact", anchors: ["algebra"], status: "archived", content: "archived trap", meta: { domains: ["algebra"], spaceScope: { space: "meta", visibility: "public" } } },
    { id: "probe-public-child", tenantId: "tenant-a", kind: "domain-fact", anchors: ["algebra"], status: "official", content: "public child probe", meta: { domains: ["algebra"], spaceScope: { space: "child", visibility: "public" } } },
    { id: "probe-private-same", tenantId: "tenant-a", kind: "domain-fact", anchors: ["algebra"], status: "official", content: "private same probe", meta: { domains: ["algebra"], spaceScope: { space: "dev", visibility: "private" } } },
    { id: "probe-public-ancestor", tenantId: "tenant-a", kind: "domain-fact", anchors: ["algebra"], status: "official", content: "public ancestor probe", meta: { domains: ["algebra"], spaceScope: { space: "meta", visibility: "public" } } },
  ];
}

export const N28_ACCEPTED_BASELINE_SKIPS = [
  { file: "test/pth-execution/sandbox-security.integration.test.ts", tests: 9 },
  { file: "test/pth-professional/assembly-engineer.integration.test.ts", tests: 14 },
  { file: "test/pth-professional/computational-chemist.integration.test.ts", tests: 5 },
  { file: "test/pth-professional/lean4-prover.integration.test.ts", tests: 13 },
  { file: "test/pth-professional/technical-educator.integration.test.ts", tests: 17 },
] as const;

export const N28_GOLD_QUERIES = [
  { id: "q-primary-1", workerKey: "algebra", text: "token:alg-01", expected: "alg-01", expectedWave: 0 },
  { id: "q-primary-2", workerKey: "algebra", text: "token:alg-20", expected: "alg-20", expectedWave: 0 },
  { id: "q-primary-3", workerKey: "geometry", text: "token:geo-01", expected: "geo-01", expectedWave: 0 },
  { id: "q-primary-4", workerKey: "geometry", text: "token:geo-40", expected: "geo-40", expectedWave: 0 },
  { id: "q-overlap-1", workerKey: "algebra", text: "token:num-01", expected: "num-01", expectedWave: 1 },
  { id: "q-overlap-2", workerKey: "geometry", text: "token:num-10", expected: "num-10", expectedWave: 1 },
  { id: "q-fallback-1", workerKey: "algebra", text: "token:shared-01", expected: "shared-01", expectedWave: 2 },
  { id: "q-fallback-2", workerKey: "geometry", text: "token:shared-08", expected: "shared-08", expectedWave: 2 },
  { id: "q-global-decoy", workerKey: "algebra", text: "bounded global target canonical", expected: "global-only", expectedWave: 3 },
  { id: "q-misbound", workerKey: "algebra", text: "token:geo-39", expected: "geo-39", expectedWave: 3 },
  { id: "q-unclassified-1", workerKey: "algebra", text: "unclassified target", expected: "unclassified-only", expectedWave: 2 },
  { id: "q-unclassified-2", workerKey: "geometry", text: "unclassified target", expected: "unclassified-only", expectedWave: 2 },
] as const;
