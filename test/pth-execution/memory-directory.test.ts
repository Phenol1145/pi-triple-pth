import { describe, expect, it } from "vitest";
import { N28_FEASIBILITY_BUDGET, checkResponsibilityCapacity } from "@away_from/pth-contracts";
import { assertMemoryDirectoryResponsibilityCapacity, assertMemoryDirectorySnapshotIntegrity, buildMemoryDirectorySnapshot, membershipsForEntry } from "../../src/pth/execution/memory-directory.js";
import { N28_DOMAIN_IDS, N28_REGIONS, N28_RESPONSIBILITIES, N28_WORKERS, n28AuthorizedCorpus, n28DirectoryInputs, type N28KnowledgeEntry } from "../../scripts/n28-feasibility-fixture.js";

describe("MemoryDirectory", () => {
  it("references one cross-domain entry from multiple regions without copying it", () => {
    const corpus = n28AuthorizedCorpus();
    const directory = buildMemoryDirectorySnapshot({ tenantId: "tenant-a", epoch: 1, knownDomainIds: N28_DOMAIN_IDS, workers: Object.values(N28_WORKERS), regions: N28_REGIONS, responsibilities: N28_RESPONSIBILITIES, entries: n28DirectoryInputs(corpus) });
    expect(directory.memberships.find((membership) => membership.entryId === "alg-40")?.regionIds).toEqual([
      "region:algebra",
      "region:numerical",
    ]);
    expect(corpus.filter((entry) => entry.id === "alg-40")).toHaveLength(1);
  });

  it("classifies every entry or records it as unclassified", () => {
    const directory = buildMemoryDirectorySnapshot({ tenantId: "tenant-a", epoch: 1, knownDomainIds: N28_DOMAIN_IDS, workers: Object.values(N28_WORKERS), regions: N28_REGIONS, responsibilities: N28_RESPONSIBILITIES, entries: n28DirectoryInputs() });
    expect(directory.memberships).toHaveLength(100);
    expect(directory.unclassifiedEntryIds).toEqual(["unclassified-only"]);
    expect(directory.regions.some((region) => region.regionId === "region:unclassified")).toBe(true);
    expect(new Set(n28DirectoryInputs().map((item) => item.memoryType))).toEqual(new Set(["setting", "wiki", "skill", "log"]));
  });

  it("produces the same snapshot for reordered input and a different one for a content revision", () => {
    const corpus = n28AuthorizedCorpus();
    const a = buildMemoryDirectorySnapshot({ tenantId: "tenant-a", epoch: 1, knownDomainIds: N28_DOMAIN_IDS, workers: Object.values(N28_WORKERS), regions: N28_REGIONS, responsibilities: N28_RESPONSIBILITIES, entries: n28DirectoryInputs(corpus) });
    const b = buildMemoryDirectorySnapshot({ tenantId: "tenant-a", epoch: 1, knownDomainIds: N28_DOMAIN_IDS, workers: Object.values(N28_WORKERS).reverse(), regions: [...N28_REGIONS].reverse(), responsibilities: [...N28_RESPONSIBILITIES].reverse(), entries: n28DirectoryInputs([...corpus].reverse()) });
    expect(b.snapshotId).toBe(a.snapshotId);
    expect(b.memberships).toEqual(a.memberships);
    expect(Object.isFrozen(a.memberships[0]!.regionIds)).toBe(true);
    expect(() => (a.memberships[0]!.regionIds as string[]).push("region:forged")).toThrow();
    expect(Object.isFrozen(N28_REGIONS[0].selector)).toBe(false);
    const changed = corpus.map((entry) => entry.id === "alg-01" ? { ...entry, content: `${entry.content}!` } : entry);
    const c = buildMemoryDirectorySnapshot({ tenantId: "tenant-a", epoch: 1, knownDomainIds: N28_DOMAIN_IDS, workers: Object.values(N28_WORKERS), regions: N28_REGIONS, responsibilities: N28_RESPONSIBILITIES, entries: n28DirectoryInputs(changed, new Map([["alg-01", 2]])) });
    expect(c.snapshotId).not.toBe(a.snapshotId);
    expect(c.corpusFingerprint).not.toBe(a.corpusFingerprint);
  });

  it("keeps both same-role replicas inside the fixed responsibility capacity", () => {
    const directory = buildMemoryDirectorySnapshot({ tenantId: "tenant-a", epoch: 1, knownDomainIds: N28_DOMAIN_IDS, workers: Object.values(N28_WORKERS), regions: N28_REGIONS, responsibilities: N28_RESPONSIBILITIES, entries: n28DirectoryInputs() });
    expect(() => assertMemoryDirectoryResponsibilityCapacity(directory, N28_FEASIBILITY_BUDGET.responsibility)).not.toThrow();
    for (const worker of Object.values(N28_WORKERS)) {
      const assigned = directory.responsibilities.filter((item) => item.workerId === worker.workerId);
      expect(checkResponsibilityCapacity(worker, directory.regions, assigned, N28_FEASIBILITY_BUDGET.responsibility)).toMatchObject({ ok: true });
    }
    expect(() => assertMemoryDirectoryResponsibilityCapacity(directory, {
      ...N28_FEASIBILITY_BUDGET.responsibility,
      maxRegions: 0,
    })).toThrow(/capacity exceeded/);
  });

  it("rejects cross-tenant entries, duplicate bindings, stale epochs and ownerless regions", () => {
    const base = { tenantId: "tenant-a", epoch: 1, knownDomainIds: N28_DOMAIN_IDS, workers: Object.values(N28_WORKERS), regions: N28_REGIONS, responsibilities: N28_RESPONSIBILITIES, entries: n28DirectoryInputs() } as const;
    expect(() => buildMemoryDirectorySnapshot({ ...base, entries: [...base.entries, { ...base.entries[0]!, entry: { ...base.entries[0]!.entry, id: "tenant-duplicate", tenantId: "tenant-b" } }] })).toThrow(/tenant/);
    expect(() => buildMemoryDirectorySnapshot({ ...base, responsibilities: [...base.responsibilities, base.responsibilities[0]!] })).toThrow(/duplicate responsibility/);
    expect(() => buildMemoryDirectorySnapshot({ ...base, responsibilities: base.responsibilities.map((item) => ({ ...item, epoch: 0 })) })).toThrow(/epoch/);
    expect(() => buildMemoryDirectorySnapshot({ ...base, responsibilities: base.responsibilities.filter((item) => item.regionId !== "region:global-holdout") })).toThrow(/primary owner/);
    expect(() => buildMemoryDirectorySnapshot({ ...base, workers: base.workers.filter((worker) => worker.workerId !== N28_WORKERS.global.workerId) })).toThrow(/unknown worker/);
    expect(() => buildMemoryDirectorySnapshot({ ...base, entries: base.entries.map((item) => item.entry.id === "alg-01" ? { ...item, revision: 0 } : item) })).toThrow(/revision/);
    expect(() => buildMemoryDirectorySnapshot({ ...base, regions: base.regions.map((region) => region.regionId === "region:algebra" ? { ...region, selector: { domains: ["not-in-catalog"] } } : region) })).toThrow(/unknown selector domain/);
  });

  it("rejects a forged revision, content hash, index hash or epoch before retrieval", () => {
    const entries = n28DirectoryInputs();
    const directory = buildMemoryDirectorySnapshot({ tenantId: "tenant-a", epoch: 1, knownDomainIds: N28_DOMAIN_IDS, workers: Object.values(N28_WORKERS), regions: N28_REGIONS, responsibilities: N28_RESPONSIBILITIES, entries });
    expect(() => assertMemoryDirectorySnapshotIntegrity({ ...directory, epoch: 2 }, { knownDomainIds: N28_DOMAIN_IDS, entries })).toThrow(/integrity mismatch/);
    const membership = { ...directory.memberships[0]!, contentHash: "0".repeat(64) };
    expect(() => assertMemoryDirectorySnapshotIntegrity({ ...directory, memberships: [membership, ...directory.memberships.slice(1)] }, { knownDomainIds: N28_DOMAIN_IDS, entries })).toThrow(/integrity mismatch/);
    const staleRevision = { ...directory.memberships[0]!, entryRevision: directory.memberships[0]!.entryRevision + 1 };
    expect(() => assertMemoryDirectorySnapshotIntegrity({ ...directory, memberships: [staleRevision, ...directory.memberships.slice(1)] }, { knownDomainIds: N28_DOMAIN_IDS, entries })).toThrow(/integrity mismatch/);
    const forgedIndex = { ...directory.memberships[0]!, indexHash: "f".repeat(64) };
    expect(() => assertMemoryDirectorySnapshotIntegrity({ ...directory, memberships: [forgedIndex, ...directory.memberships.slice(1)] }, { knownDomainIds: N28_DOMAIN_IDS, entries })).toThrow(/integrity mismatch/);
  });

  it("places a newly promoted but unmatched official entry into unclassified on the next immutable snapshot", () => {
    const before = buildMemoryDirectorySnapshot({ tenantId: "tenant-a", epoch: 1, knownDomainIds: N28_DOMAIN_IDS, workers: Object.values(N28_WORKERS), regions: N28_REGIONS, responsibilities: N28_RESPONSIBILITIES, entries: n28DirectoryInputs() });
    const added = { id: "new-official", tenantId: "tenant-a", kind: "domain-fact", anchors: ["new-anchor"], status: "official", content: "new intake result", meta: { domains: [], spaceScope: { space: "meta", visibility: "public" } } } satisfies N28KnowledgeEntry;
    const after = buildMemoryDirectorySnapshot({ tenantId: "tenant-a", epoch: 1, knownDomainIds: N28_DOMAIN_IDS, workers: Object.values(N28_WORKERS), regions: N28_REGIONS, responsibilities: N28_RESPONSIBILITIES, entries: n28DirectoryInputs([...n28AuthorizedCorpus(), added]) });
    expect(before.memberships).toHaveLength(100);
    expect(after.memberships).toHaveLength(101);
    expect(membershipsForEntry(after, "new-official")).toEqual(["region:unclassified"]);
    expect(before.snapshotId).not.toBe(after.snapshotId);
  });
});
