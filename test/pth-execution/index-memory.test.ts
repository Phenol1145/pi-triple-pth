import { describe, expect, it, vi } from "vitest";
import {
  createIndexMemoryReader,
  validateIndexMemoryRecord,
  type IndexMemoryRecord,
  type IndexMemorySourceAdapter,
  type IndexMemorySpan,
} from "../../src/pth/execution/index-memory.js";
import {
  canonicalExposureChars,
  CognitiveBudgetExceededError,
  CognitiveBudgetLedger,
} from "../../src/pth/kernel/execution/cognitive-budget.js";
import { createVerifiedTaskReadScopeFactory, type VerifiedTaskReadScope } from "../../src/pth/execution/authorization/verified-task-read-scope.js";
import { createExecutionGrantService } from "../../src/pth/execution/authorization/execution-grant-service.js";
import { createHmacGrantKeyProvider } from "../../src/pth/execution/authorization/grant-key-provider.js";
import { N28_FEASIBILITY_BUDGET, type ExecutionGrant, type TaskLease, type TaskWorkItem, type WorkerReplicaRef } from "../../src/pth/contracts/index.js";

let nowMs = Date.parse("2030-01-01T00:00:00.000Z");
const clock = () => new Date(nowMs);

const worker: WorkerReplicaRef = {
  workerId: "10000000-0000-4000-8000-000000000071",
  batchId: "batch-index-memory",
  role: { roleId: "researcher", revision: "rev-v1" },
};

const lease: TaskLease = {
  taskId: "task-index-memory",
  leaseId: "20000000-0000-4000-8000-000000000071",
  generation: 1,
  scope: { tenantId: "tenant-a", principalId: `worker:${worker.workerId}`, roles: ["researcher"], traceId: "trace-index-memory", space: "meta" },
  workspace: { tenantId: "tenant-a", workspaceId: "ws-index-memory", taskId: "task-index-memory" },
  roleId: "researcher",
  deadlineAt: "2030-01-01T00:02:00.000Z",
};

const work: TaskWorkItem = {
  taskId: "task-index-memory",
  scope: lease.scope,
  title: "index-memory",
  text: "index-memory",
  tags: [],
  payload: {},
  assignedRole: "researcher",
  domains: ["formal-methods"],
};

const validRecordInput = {
  entryId: "idx:lean:list-map",
  sourceId: "lean4-mathlib",
  product: "Mathlib",
  version: "stable-lock",
  releaseChannel: "stable",
  canonicalUri: "artifact://mathlib-docs",
  artifactHash: "sha256:" + "a".repeat(64),
  locator: { kind: "symbol", value: "List.map" },
  domains: ["formal-methods"],
  license: "Apache-2.0",
} as const;

function makeGrantService() {
  return createExecutionGrantService({
    keyProvider: createHmacGrantKeyProvider({ secret: "index-memory-test-secret-0123456789" }),
    clock,
  });
}

function issueGrant(svc: ReturnType<typeof makeGrantService>, overrides: Partial<Parameters<ReturnType<typeof makeGrantService>["issue"]>[0]> = {}): ExecutionGrant {
  return svc.issue({
    lease,
    scope: { ...lease.scope, principalId: `worker:${worker.workerId}`, roles: ["researcher"] },
    workspace: lease.workspace,
    language: "ts",
    capabilities: ["memory.read", "memory.query"],
    ttlMs: 120_000,
    ...overrides,
  });
}

function mintScope(svc = makeGrantService()): VerifiedTaskReadScope {
  const factory = createVerifiedTaskReadScopeFactory({ grantService: svc, grantForTask: () => issueGrant(svc) });
  return factory.forTask({ lease, work, space: "meta", worker });
}

function newLedger(overrides: Partial<typeof N28_FEASIBILITY_BUDGET.task> = {}) {
  return new CognitiveBudgetLedger({
    taskId: "task-index-memory",
    workerId: worker.workerId,
    directorySnapshotId: "md-index-memory",
    budget: { ...N28_FEASIBILITY_BUDGET.task, ...overrides },
  });
}

function spanAdapter(span: IndexMemorySpan): IndexMemorySourceAdapter {
  return {
    readExactSpan: vi.fn(async () => span),
  };
}

const validRecord = (): IndexMemoryRecord => validateIndexMemoryRecord(validRecordInput);
const exactSpan = (record: IndexMemoryRecord): IndexMemorySpan => ({
  locator: record.locator,
  artifactHash: record.artifactHash,
  content: "theorem List.map_eq...（仅引用 span 的正文，不含语料其余部分）",
});

describe("validateIndexMemoryRecord（Index Memory 只存导航元数据）", () => {
  it("合法记录通过，返回对象不含 body 形状字段", () => {
    const record = validateIndexMemoryRecord({
      ...validRecordInput,
    });
    expect(record).toMatchObject(validRecordInput);
    expect("content" in record).toBe(false);
    expect("body" in record).toBe(false);
    expect(record.locator).toEqual({ kind: "symbol", value: "List.map" });
  });

  it("拒绝 body 形状字段（content/body/text/corpus/fullText）", () => {
    for (const field of ["content", "body", "text", "corpus", "fullText"]) {
      expect(() => validateIndexMemoryRecord({ ...validRecordInput, [field]: "forbidden body" }), field).toThrow(/body-shaped|body|content|索引/);
    }
  });

  it("拒绝非 stable releaseChannel", () => {
    expect(() => validateIndexMemoryRecord({ ...validRecordInput, releaseChannel: "beta" })).toThrow(/stable|releaseChannel/);
    expect(() => validateIndexMemoryRecord({ ...validRecordInput, releaseChannel: "rc" })).toThrow(/stable|releaseChannel/);
  });

  it("拒绝空 hash", () => {
    expect(() => validateIndexMemoryRecord({ ...validRecordInput, artifactHash: "" })).toThrow(/hash/);
    expect(() => validateIndexMemoryRecord({ ...validRecordInput, artifactHash: "   " })).toThrow(/hash/);
  });

  it("拒绝未知 locator kind", () => {
    expect(() => validateIndexMemoryRecord({
      ...validRecordInput,
      locator: { kind: "paragraph", value: "x" },
    })).toThrow(/locator/);
  });

  it("拒绝缺 license / domains", () => {
    const { license: _license, ...noLicense } = { ...validRecordInput };
    const { domains: _domains, ...noDomains } = { ...validRecordInput };
    expect(() => validateIndexMemoryRecord(noLicense)).toThrow(/license/);
    expect(() => validateIndexMemoryRecord(noDomains)).toThrow(/domains/);
    expect(() => validateIndexMemoryRecord({ ...validRecordInput, domains: [] })).toThrow(/domains/);
  });
});

describe("IndexMemoryReader.readExact（授权 → adapter → hash/locator 校验 → 计费）", () => {
  it("不暴露 readWholeCorpus()（禁止整份语料载入）", () => {
    const reader = createIndexMemoryReader({ clock });
    expect("readWholeCorpus" in reader).toBe(false);
    expect((reader as unknown as Record<string, unknown>).readWholeCorpus).toBeUndefined();
  });

  it("精确 locator 只返回引用 span，按实际字符计费（同一 ledger）", async () => {
    nowMs = Date.parse("2030-01-01T00:00:00.000Z");
    const scope = mintScope();
    const record = validRecord();
    const span = exactSpan(record);
    const adapter = spanAdapter(span);
    const ledger = newLedger();
    const reader = createIndexMemoryReader({ clock });

    const returned = await reader.readExact(scope, record, adapter, ledger);

    expect(adapter.readExactSpan).toHaveBeenCalledTimes(1);
    expect(adapter.readExactSpan).toHaveBeenCalledWith(record, { tenantId: "tenant-a", space: "meta" });
    expect(returned).toEqual(span);
    expect(returned.content).toBe(span.content);
    // 只按返回 span 的实际字符计费；不按语料总大小计费。
    expect(ledger.snapshot().usage.memoryChars).toBe(canonicalExposureChars(span));
    expect(ledger.snapshot().usage.memoryEntries).toBe(1);
  });

  it("跨租户拒绝：adapter 返回其他租户 span → fail-closed", async () => {
    nowMs = Date.parse("2030-01-01T00:00:00.000Z");
    const scope = mintScope();
    const record = validRecord();
    const span: IndexMemorySpan = { ...exactSpan(record), tenantId: "tenant-b" };
    const adapter = spanAdapter(span);
    const ledger = newLedger();

    await expect(createIndexMemoryReader({ clock }).readExact(scope, record, adapter, ledger))
      .rejects.toThrow(/tenant/);
    expect(adapter.readExactSpan).toHaveBeenCalledTimes(1);
  });

  it("过期 grant 拒绝：授权先于 backing adapter，adapter 不被调用", async () => {
    nowMs = Date.parse("2030-01-01T00:00:00.000Z");
    const scope = mintScope();
    const record = validRecord();
    const adapter = spanAdapter(exactSpan(record));
    const ledger = newLedger();
    const reader = createIndexMemoryReader({ clock });

    nowMs = Date.parse("2030-01-01T00:02:01.000Z");
    await expect(reader.readExact(scope, record, adapter, ledger)).rejects.toThrow(/deadline/);
    expect(adapter.readExactSpan).not.toHaveBeenCalled();
    nowMs = Date.parse("2030-01-01T00:00:00.000Z");
  });

  it("预算超限拒绝：返回 span 实际字符超过 ledger 上限 → CognitiveBudgetExceededError", async () => {
    nowMs = Date.parse("2030-01-01T00:00:00.000Z");
    const scope = mintScope();
    const record = validRecord();
    const span = exactSpan(record);
    const adapter = spanAdapter(span);
    const ledger = newLedger({ maxMemoryEntries: 1, maxMemoryChars: 10 });

    const promise = createIndexMemoryReader({ clock }).readExact(scope, record, adapter, ledger);
    await expect(promise).rejects.toBeInstanceOf(CognitiveBudgetExceededError);
    await expect(promise).rejects.toThrow(/memoryChars/);
  });

  it("artifact hash 不匹配拒绝：adapter 返回的 span hash ≠ 索引记录 hash", async () => {
    nowMs = Date.parse("2030-01-01T00:00:00.000Z");
    const scope = mintScope();
    const record = validRecord();
    const span: IndexMemorySpan = { ...exactSpan(record), artifactHash: "sha256:" + "b".repeat(64) };
    const adapter = spanAdapter(span);
    const ledger = newLedger();

    await expect(createIndexMemoryReader({ clock }).readExact(scope, record, adapter, ledger))
      .rejects.toThrow(/hash/);
  });

  it("locator 同一性校验：adapter 返回不同 locator（整份语料退化）→ 拒绝", async () => {
    nowMs = Date.parse("2030-01-01T00:00:00.000Z");
    const scope = mintScope();
    const record = validRecord();
    const span: IndexMemorySpan = {
      ...exactSpan(record),
      locator: { kind: "json-pointer", value: "/corpus" },
      content: "FULL CORPUS BODY",
    };
    const adapter = spanAdapter(span);
    const ledger = newLedger();

    await expect(createIndexMemoryReader({ clock }).readExact(scope, record, adapter, ledger))
      .rejects.toThrow(/locator/);
  });

  it("status 非 official 的 span 拒绝（复用 status 门禁）", async () => {
    nowMs = Date.parse("2030-01-01T00:00:00.000Z");
    const scope = mintScope();
    const record = validRecord();
    const span: IndexMemorySpan = { ...exactSpan(record), status: "draft" };
    const adapter = spanAdapter(span);
    const ledger = newLedger();

    await expect(createIndexMemoryReader({ clock }).readExact(scope, record, adapter, ledger))
      .rejects.toThrow(/official/);
  });
});
