/**
 * system-inspection.test.ts — N33 Task 3 Step 1：DTO redaction + 分页边界 + 跨租户零泄漏。
 *
 * 契约冻结（本文件先于实现落盘，FAIL 是预期）：
 *  - secret 配置条目 effective/default 恒为 `***`，validator 拒绝未打码 secret；
 *  - 分页 fail-closed：默认 limit 20 / 上限 100，越界一律 400；
 *  - MemoryListItem 不携带 tenantId / content / meta 原文，序列化零泄漏；
 *  - WorkerInspection / MemorySummary / MemoryListItem / ConfigInspectionEntry /
 *    RoleInspection 五个 DTO validator 正反用例。
 */

import { describe, expect, it, vi } from "vitest";
import {
  CONFIG_SOURCES,
  SYSTEM_INSPECTION_DEFAULT_LIMIT,
  SYSTEM_INSPECTION_MAX_LIMIT,
  configEntry,
  validateConfigInspectionEntry,
  validateMemoryListItem,
  validateMemorySummary,
  validateRoleInspection,
  validateWorkerInspection,
} from "@away_from/pth-contracts";
import type {
  ConfigInspectionEntry,
  MemoryListItem,
  MemorySummary,
  RoleInspection,
  WorkerInspection,
} from "@away_from/pth-contracts";
import {
  SystemInspectionError,
  SystemInspectionFacade,
} from "../../src/pth/application/observation/system-inspection-facade.js";

const T0 = new Date("2026-08-19T00:00:00.000Z");
const T1 = new Date("2026-08-19T00:01:00.000Z");

// ─── DTO fixtures ──────────────────────────────────────────────────────────

const workerInspection: WorkerInspection = {
  workerId: "w-1",
  batchId: "b-1",
  role: { roleId: "analyst", revision: "role-sha256:aa" },
  lifecycle: "idle",
  workMode: "run",
  currentTaskId: "t-1",
  leaseId: "lease-1",
  regionIds: ["region:analyst"],
  regionWeights: { "region:analyst": 80 },
  workingSet: {
    entryIds: ["entry-1"],
    skillIndexIds: ["skill-index-1"],
    activeSkillIds: ["skill:1"],
    counts: { memoryEntries: 1, skillIndexEntries: 1, activeSkills: 1, tools: 1 },
    usage: { memoryEntries: 1, memoryChars: 10, skillIndexEntries: 1, activeSkills: 1, skillChars: 10, tools: 1 },
    omitted: { memoryChars: 90 },
  },
  toolNames: ["ts.run"],
  skillIds: ["skill:1"],
  heartbeatLagMs: 123,
};

const memorySummary: MemorySummary = {
  byType: {
    setting: { count: 1, bytes: 10 },
    wiki: { count: 2, bytes: 20 },
    skill: { count: 3, bytes: 30 },
    log: { count: 4, bytes: 40 },
    index: { count: 5, bytes: 50 },
  },
  totals: { count: 15, bytes: 150 },
};

const memoryListItem: MemoryListItem = {
  id: "entry-000",
  kind: "skill",
  status: "official",
  anchors: ["skill"],
  memoryType: "skill",
  version: 1,
  createdAt: T0.toISOString(),
  updatedAt: T1.toISOString(),
  contentBytes: 128,
};

const configInspectionEntry: ConfigInspectionEntry = {
  key: "LOG_LEVEL",
  type: "string",
  group: "observability",
  scope: "both",
  description: "日志级别",
  secret: false,
  runtime: false,
  source: "default",
  effectiveValue: "info",
  defaultValue: "info",
};

const roleInspection: RoleInspection = {
  roleId: "analyst",
  revision: "role-sha256:aa",
  parent: null,
  generation: 0,
  tags: ["analyst"],
  capabilities: ["llm"],
  thinking: "medium",
  acceptanceRole: "writer",
  description: "分析角色",
};

// ─── fake pg pool（供分页/序列化边界使用） ─────────────────────────────────

function fakePool(rowCount: number, overrides: Record<string, unknown> = {}) {
  const rows = Array.from({ length: rowCount }, (_, i) => ({
    id: `entry-${String(i).padStart(3, "0")}`,
    tenant_id: "tenant-a",
    kind: "skill",
    anchors: ["skill", `entry-${String(i).padStart(3, "0")}`],
    status: "official",
    version: 1,
    created_at: T0,
    updated_at: T1,
    content_bytes: 128,
    ...overrides,
  }));
  const query = vi.fn(async () => ({ rows, rowCount: rows.length }));
  return { pool: { query } as unknown as import("pg").Pool, query };
}

// ─── 分页边界 ──────────────────────────────────────────────────────────────

describe("system inspection DTO 契约（N33 Task 3 Step 1）", () => {
  it("分页边界常量：默认 20，上限 100", () => {
    expect(SYSTEM_INSPECTION_DEFAULT_LIMIT).toBe(20);
    expect(SYSTEM_INSPECTION_MAX_LIMIT).toBe(100);
    expect(CONFIG_SOURCES).toEqual(["default", "env", "runtime", "file", "unknown"]);
  });

  it("secret 配置条目 effective/default 恒为 ***", () => {
    const entry = configEntry({
      key: "DATABASE_URL",
      secret: true,
      effective: "postgres://secret",
      defaultValue: "postgres://secret",
    });

    expect(entry).toMatchObject({ effectiveValue: "***", defaultValue: "***", secret: true });
    expect(entry.effectiveValue).toBe("***");
    expect(entry.defaultValue).toBe("***");
    expect(JSON.stringify(entry)).not.toContain("postgres://secret");
  });

  it("非 secret 配置条目保留 effective/default，source 只在枚举内", () => {
    const entry = configEntry({
      key: "LOG_LEVEL",
      secret: false,
      effective: "info",
      defaultValue: "info",
      source: "default",
    });

    expect(entry.effectiveValue).toBe("info");
    expect(entry.defaultValue).toBe("info");
    expect(entry.source).toBe("default");
    expect(CONFIG_SOURCES).toContain(entry.source);
  });

  it("ConfigInspectionEntry validator：打码 secret 通过，未打码拒绝", () => {
    const redacted = configEntry({
      key: "DATABASE_URL",
      secret: true,
      effective: "postgres://secret",
      defaultValue: "postgres://secret",
    });
    expect(validateConfigInspectionEntry(redacted).ok).toBe(true);

    const leaked = {
      ...redacted,
      effectiveValue: "postgres://secret",
      defaultValue: "postgres://secret",
    } as ConfigInspectionEntry;
    const result = validateConfigInspectionEntry(leaked);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("***");
  });

  it("ConfigInspectionEntry validator：source 枚举外拒绝", () => {
    const bad = { ...configInspectionEntry, source: "inferred" } as ConfigInspectionEntry;
    const result = validateConfigInspectionEntry(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("source");
  });

  it("MemoryListItem validator：合法条目通过，携带 tenantId/content/meta 原文拒绝", () => {
    expect(validateMemoryListItem(memoryListItem).ok).toBe(true);

    const withTenant = { ...memoryListItem, tenantId: "tenant-a" } as MemoryListItem;
    expect(validateMemoryListItem(withTenant).ok).toBe(false);

    const withContent = { ...memoryListItem, content: "tenant-b-secret" } as MemoryListItem;
    expect(validateMemoryListItem(withContent).ok).toBe(false);

    const withMeta = { ...memoryListItem, meta: { secret: true } } as MemoryListItem;
    expect(validateMemoryListItem(withMeta).ok).toBe(false);
  });

  it("MemorySummary validator：五类 count/bytes 合法通过，缺失/负数拒绝", () => {
    expect(validateMemorySummary(memorySummary).ok).toBe(true);

    const missingType = {
      ...memorySummary,
      byType: { setting: memorySummary.byType.setting },
    } as MemorySummary;
    expect(validateMemorySummary(missingType).ok).toBe(false);

    const negativeBytes = {
      ...memorySummary,
      byType: { ...memorySummary.byType, log: { count: 1, bytes: -1 } },
    } as MemorySummary;
    expect(validateMemorySummary(negativeBytes).ok).toBe(false);
  });

  it("WorkerInspection validator：合法投影通过，prompt/content/secret/environment 键拒绝", () => {
    expect(validateWorkerInspection(workerInspection).ok).toBe(true);

    for (const forbidden of ["prompt", "content", "secret", "environment"]) {
      const leaked = { ...workerInspection, [forbidden]: "x" } as WorkerInspection;
      const result = validateWorkerInspection(leaked);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain(forbidden);
    }
  });

  it("RoleInspection validator：合法角色通过，缺 revision 拒绝", () => {
    expect(validateRoleInspection(roleInspection).ok).toBe(true);

    const missingRevision = { ...roleInspection, revision: undefined } as RoleInspection;
    const result = validateRoleInspection(missingRevision);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("revision");
  });
});

// ─── facade 分页与序列化（内存投影） ────────────────────────────────────────

describe("SystemInspectionFacade 分页与零泄漏（N33 Task 3 Step 1）", () => {
  it("分页：默认 limit 20，且只返回 20 条", async () => {
    const { pool } = fakePool(25);
    const facade = new SystemInspectionFacade(pool, { clock: () => T1.getTime() });

    const page = await facade.queryMemory({ tenantId: "tenant-a" });

    expect(page.items).toHaveLength(20);
    expect(page.nextCursor).toBeTruthy();
    expect(page.items.every((x) => (x as { tenantId?: unknown }).tenantId === undefined)).toBe(true);
    expect(JSON.stringify(page.items)).not.toContain("tenant-a");
  });

  it("分页 fail-closed：limit 0 / 101 / 非整数 → 400", async () => {
    const { pool } = fakePool(5);
    const facade = new SystemInspectionFacade(pool, { clock: () => T1.getTime() });

    for (const limit of [0, 101, -1, 1.5, Number.NaN]) {
      await expect(
        facade.queryMemory({ tenantId: "tenant-a" }, { limit }),
      ).rejects.toThrowError(SystemInspectionError);
      await expect(
        facade.queryMemory({ tenantId: "tenant-a" }, { limit }),
      ).rejects.toMatchObject({ statusCode: 400 });
    }
  });

  it("分页：limit=100 是合法上限", async () => {
    const { pool } = fakePool(100);
    const facade = new SystemInspectionFacade(pool, { clock: () => T1.getTime() });

    const page = await facade.queryMemory({ tenantId: "tenant-a" }, { limit: 100 });
    expect(page.items).toHaveLength(100);
    expect(page.nextCursor).toBeNull();
  });

  it("跨 tenant 内容零泄漏：序列化不包含 tenant-b-secret", async () => {
    const { pool } = fakePool(20, {
      tenant_id: "tenant-b",
      content: "tenant-b-secret",
    });
    const facade = new SystemInspectionFacade(pool, { clock: () => T1.getTime() });

    const page = await facade.queryMemory({ tenantId: "tenant-a" }, { limit: 20 });

    expect(page.items).toHaveLength(20);
    expect(page.items.every((x) => (x as { tenantId?: unknown }).tenantId === undefined)).toBe(true);
    expect(page.items.every((x) => (x as { content?: unknown }).content === undefined)).toBe(true);
    expect(JSON.stringify(page)).not.toContain("tenant-b-secret");
  });
});
