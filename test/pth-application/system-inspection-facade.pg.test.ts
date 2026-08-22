/**
 * system-inspection-facade.pg.test.ts — N33 Task 3（真实 PostgreSQL 投影测试）。
 *
 * 覆盖：
 *  - tenant 隔离：tenant A 查询中 tenant B 条目零可见；
 *  - 分页：opaque cursor 翻页不重不漏；
 *  - secret 正文零泄漏（DTO 无 content/tenantId/meta）；
 *  - 兄弟空间 private 条目不可见；
 *  - 默认 status=official，archived 仅在显式请求时可见；
 *  - 零记忆 summary 五类 count/bytes 均为 0；
 *  - recent revisions = append-only log + current revision，按 revision 倒序。
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { setSpaceLookup } from "@away_from/pth-memory";
import { createPgPool } from "@away_from/pth-kernel-storage";
import { applySchema } from "@away_from/pth-kernel-storage";
import {
  validateMemoryListItem,
  validateMemoryRevisionEvent,
  validateMemorySummary,
} from "@away_from/pth-contracts";
import {
  SystemInspectionFacade,
} from "../../src/pth/application/observation/system-inspection-facade.js";

const T0 = new Date("2026-08-19T00:00:00.000Z");

type Pool = Awaited<ReturnType<typeof createPgPool>>;

async function seedMemory(
  pool: Pool,
  row: {
    id: string;
    tenantId: string;
    kind: string;
    anchors: string[];
    content: string;
    status?: string;
    version?: number;
    space: string;
    visibility: "public" | "private";
    updatedAt?: Date;
  },
): Promise<void> {
  const updatedAt = row.updatedAt ?? T0;
  await pool.query(
    `INSERT INTO memory_entries
       (id, tenant_id, kind, anchors, content, status, version, meta, created_at, updated_at)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8::jsonb,$9::timestamptz,$10::timestamptz)`,
    [
      row.id,
      row.tenantId,
      row.kind,
      JSON.stringify(row.anchors),
      row.content,
      row.status ?? "official",
      row.version ?? 1,
      JSON.stringify({ spaceScope: { space: row.space, visibility: row.visibility } }),
      updatedAt,
      updatedAt,
    ],
  );
}

async function seedRevision(
  pool: Pool,
  row: {
    entryId: string;
    tenantId: string;
    revision: number;
    content: string;
    status?: string;
    createdAt?: Date;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO memory_revisions
       (entry_id, tenant_id, revision, content, status, anchors, meta, created_at, created_by, reason)
     VALUES ($1,$2,$3,$4,$5,'[]'::jsonb,'{}'::jsonb,$6::timestamptz,'seed','seed-revision')`,
    [
      row.entryId,
      row.tenantId,
      row.revision,
      row.content,
      row.status ?? "official",
      row.createdAt ?? T0,
    ],
  );
}

describe("SystemInspectionFacade（PG 投影）", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let facade: SystemInspectionFacade;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    pool = await createPgPool({ connectionString: container.getConnectionUri() });
    await applySchema(pool);

    // 空间树：meta 为根；space-a 与 space-b 是兄弟（不可见对方 private；public 沿父向下）。
    setSpaceLookup({ get: (id) => (id === "space-a" || id === "space-b" ? { parent: "meta" } : undefined) });

    // tenant-a / space-a：25 条分页种子（updatedAt 递增，content 含可控字符串）。
    for (let i = 0; i < 25; i += 1) {
      await seedMemory(pool, {
        id: `a-${String(i).padStart(3, "0")}`,
        tenantId: "tenant-a",
        kind: "skill",
        anchors: ["skill", `a-${String(i).padStart(3, "0")}`],
        content: `tenant-a public content ${i}`,
        space: "space-a",
        visibility: "public",
        updatedAt: new Date(T0.getTime() + i * 1000),
      });
    }

    // tenant-b：跨租户隔离种子（content 带租户秘密标记）。
    await seedMemory(pool, {
      id: "b-secret",
      tenantId: "tenant-b",
      kind: "skill",
      anchors: ["skill", "tenant-b"],
      content: "tenant-b-secret",
      space: "space-b",
      visibility: "public",
    });

    // tenant-a / space-b：兄弟空间 private 条目。
    await seedMemory(pool, {
      id: "a-private-in-b",
      tenantId: "tenant-a",
      kind: "domain-fact",
      anchors: ["wiki", "private"],
      content: "tenant-a private in space-b",
      space: "space-b",
      visibility: "private",
    });

    // tenant-a / space-a：archived 条目（默认不可见）。
    await seedMemory(pool, {
      id: "a-archived",
      tenantId: "tenant-a",
      kind: "episodic-log",
      anchors: ["log", "archived"],
      content: "tenant-a archived entry",
      status: "archived",
      space: "space-a",
      visibility: "public",
    });

    // revision 历史种子：当前 version=3，revision 1/2 在 append-only log。
    await seedMemory(pool, {
      id: "a-revisions",
      tenantId: "tenant-a",
      kind: "skill",
      anchors: ["skill", "revisions"],
      content: "current-v3",
      version: 3,
      space: "space-a",
      visibility: "public",
    });
    await seedRevision(pool, {
      entryId: "a-revisions",
      tenantId: "tenant-a",
      revision: 1,
      content: "old-v1",
      createdAt: new Date(T0.getTime() - 2000),
    });
    await seedRevision(pool, {
      entryId: "a-revisions",
      tenantId: "tenant-a",
      revision: 2,
      content: "old-v2",
      createdAt: new Date(T0.getTime() - 1000),
    });

    facade = new SystemInspectionFacade(pool, { clock: () => T0.getTime() });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it("tenant 隔离：tenant A 查询中 tenant B 条目零可见", async () => {
    const page = await facade.queryMemory({ tenantId: "tenant-a", space: "space-a" }, { limit: 100 });

    const ids = page.items.map((item) => item.id);
    expect(ids).toContain("a-000");
    expect(ids).not.toContain("b-secret");
    for (const item of page.items) {
      expect(item.id).not.toContain("tenant-b");
      expect(validateMemoryListItem(item).ok).toBe(true);
    }
    expect(JSON.stringify(page)).not.toContain("tenant-b-secret");
  });

  it("opaque cursor 分页不重不漏", async () => {
    const collected: string[] = [];
    let cursor: string | null = null;
    let guard = 0;
    do {
      const page = await facade.queryMemory(
        { tenantId: "tenant-a", space: "space-a" },
        { limit: 5, ...(cursor ? { cursor } : {}) },
      );
      collected.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
      guard += 1;
    } while (cursor && guard < 20);

    expect(guard).toBeLessThan(20);
    // 25 条分页种子 + 1 条 revision 种子（同为 official skill）。
    expect(collected).toHaveLength(26);
    expect(new Set(collected).size).toBe(26);
    // 排序为 updatedAt ASC / id ASC：T0 时刻 a-000 < a-revisions，随后 a-001…a-024。
    expect(collected).toEqual(["a-000", "a-revisions", ...Array.from({ length: 24 }, (_, i) => `a-${String(i + 1).padStart(3, "0")}`)]);
  });

  it("secret 正文零泄漏：DTO 序列化不含 content/tenantId/meta", async () => {
    const page = await facade.queryMemory({ tenantId: "tenant-a", space: "space-a" }, { limit: 100 });
    const json = JSON.stringify(page);
    expect(json).not.toContain("tenant-b-secret");
    expect(json).not.toContain("tenant-b");
    for (const item of page.items) {
      expect((item as { content?: unknown }).content).toBeUndefined();
      expect((item as { tenantId?: unknown }).tenantId).toBeUndefined();
      expect((item as { meta?: unknown }).meta).toBeUndefined();
    }
  });

  it("兄弟空间 private 条目不可见；本空间可见", async () => {
    const fromA = await facade.queryMemory({ tenantId: "tenant-a", space: "space-a" }, { limit: 100 });
    expect(fromA.items.map((item) => item.id)).not.toContain("a-private-in-b");

    const fromB = await facade.queryMemory({ tenantId: "tenant-a", space: "space-b" }, { limit: 100 });
    expect(fromB.items.map((item) => item.id)).toContain("a-private-in-b");
  });

  it("默认 status=official；archived 仅在显式请求时可见", async () => {
    const page = await facade.queryMemory({ tenantId: "tenant-a", space: "space-a" }, { limit: 100 });
    expect(page.items.map((item) => item.id)).not.toContain("a-archived");

    const withArchived = await facade.queryMemory(
      { tenantId: "tenant-a", space: "space-a" },
      { limit: 100, statuses: ["official", "archived"] },
    );
    expect(withArchived.items.map((item) => item.id)).toContain("a-archived");
  });

  it("零记忆 summary：五类 count/bytes 均为 0", async () => {
    const summary = await facade.queryMemorySummary({ tenantId: "tenant-z", space: "meta" });
    expect(validateMemorySummary(summary).ok).toBe(true);
    for (const type of ["setting", "wiki", "skill", "log", "index"] as const) {
      expect(summary.byType[type]).toEqual({ count: 0, bytes: 0 });
    }
    expect(summary.totals).toEqual({ count: 0, bytes: 0 });
  });

  it("summary 按 canonical MemoryType 聚合 count 与 octet_length", async () => {
    const summary = await facade.queryMemorySummary({ tenantId: "tenant-a", space: "space-a" });
    expect(validateMemorySummary(summary).ok).toBe(true);
    expect(summary.byType.skill.count).toBeGreaterThanOrEqual(26); // 25 分页 + a-revisions
    expect(summary.byType.skill.bytes).toBeGreaterThanOrEqual(25 * 20);
    expect(summary.byType.log.count).toBe(0); // archived 默认不参与
    expect(summary.byType.wiki.count).toBe(0);
  });

  it("recent revisions = append-only log + current revision，按 revision 倒序且零正文", async () => {
    const revisions = await facade.queryMemoryRevisions(
      { tenantId: "tenant-a", space: "space-a" },
      "a-revisions",
      10,
    );

    expect(revisions).toHaveLength(3);
    expect(revisions.map((revision) => revision.revision)).toEqual([3, 2, 1]);
    for (const revision of revisions) {
      expect(validateMemoryRevisionEvent(revision).ok).toBe(true);
      expect((revision as { content?: unknown }).content).toBeUndefined();
      expect((revision as { tenantId?: unknown }).tenantId).toBeUndefined();
    }
    expect(JSON.stringify(revisions)).not.toContain("old-v1");
    expect(JSON.stringify(revisions)).not.toContain("current-v3");
  });
});
