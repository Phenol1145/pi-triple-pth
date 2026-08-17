/**
 * test/pth-kernel-storage/task-store-pg-domains.test.ts — K2 publish 域名盖章（fake pool，无 Docker）。
 *
 * 覆盖：非 delegate 显式 domains → payload 盖章 domains+binding；未知 id 400；
 * payload.domains 作为显式来源；payload.domains 非字符串数组按空处理走别名扫描；
 * delegate 通道继承 payload.domains 且不重跑 resolver。
 */

import { describe, expect, it } from "vitest";
import { PgTaskStore, type DisciplineResolverPort } from "../../src/pth/kernel/storage/task-store-pg.js";
import { DisciplineCatalogBuilder } from "../../src/pth/catalog/discipline-catalog.js";
import { createDisciplineResolver } from "../../src/pth/catalog/discipline-resolver.js";

function buildCatalog() {
  return new DisciplineCatalogBuilder()
    .add({
      id: "mathematics",
      names: { "zh-CN": "数学：代数/几何/分析", en: "mathematics" },
      aliases: ["math"],
      parents: [],
      level: "category",
      description: "数学",
      methodAnchors: [],
      sourceRegistryIds: [],
      toolAnchors: [],
    })
    .add({
      id: "statistics",
      names: { "zh-CN": "统计学：概率/推断/回归", en: "statistics" },
      aliases: ["stats"],
      parents: ["mathematics"],
      level: "discipline",
      description: "统计学",
      methodAnchors: [],
      sourceRegistryIds: [],
      toolAnchors: [],
    })
    .add({
      id: "biology",
      names: { "zh-CN": "生物学：细胞/遗传/生态", en: "biology" },
      aliases: ["bio"],
      parents: [],
      level: "category",
      description: "生物学",
      methodAnchors: [],
      sourceRegistryIds: [],
      toolAnchors: [],
    })
    .build();
}

function fakePool() {
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  const pool = {
    query: async (sql: string, values: unknown[]) => {
      queries.push({ sql, values });
      const [id, tenantId, title, text, createdBy, tags, payload] = values;
      return {
        rows: [{
          id,
          tenant_id: tenantId,
          title,
          text,
          created_by: createdBy,
          tags,
          payload,
          status: "pending",
          claimed_by: null,
          claims_count: 0,
          created_at: new Date(),
          assigned_role: values[8] ?? null,
          job_id: values[9] ?? null,
          lease_id: null,
          lease_generation: 0,
          lease_expires_at: null,
        }],
      };
    },
  };
  return { queries, pool: pool as any };
}

describe("PgTaskStore.publish 域名盖章（fake pool）", () => {
  it("非 delegate：input.domains 显式声明 → payload 盖章 domains + domainBinding", async () => {
    const { queries, pool } = fakePool();
    const catalog = buildCatalog();
    const store = new PgTaskStore(pool, undefined, createDisciplineResolver(catalog));

    const task = await store.publish({
      title: "统计学习",
      text: "用 stats 方法",
      createdBy: "me",
      domains: ["statistics"],
    });

    const insertedPayload = queries[0]!.values[6] as Record<string, unknown>;
    expect(task.payload).toEqual(insertedPayload);
    expect(insertedPayload.domains).toEqual(["statistics"]);
    expect(insertedPayload.domainBinding).toMatchObject({
      primaryDomain: "statistics",
      catalogVersion: catalog.version,
      resolverVersion: "v1-explicit-alias",
    });
    expect((insertedPayload.domainBinding as { matches: Array<{ domainId: string; confidence: number; evidence: string[] }> }).matches).toEqual([
      { domainId: "statistics", confidence: 1, evidence: ["explicit:statistics"] },
    ]);
  });

  it("未知显式 id fail-closed 400", async () => {
    const { pool } = fakePool();
    const catalog = buildCatalog();
    const store = new PgTaskStore(pool, undefined, createDisciplineResolver(catalog));

    const err = await store.publish({
      title: "占星",
      text: "astrology",
      createdBy: "me",
      domains: ["astrology"],
    }).then(
      () => null,
      (e: Error & { statusCode?: number }) => e,
    );

    expect(err).not.toBeNull();
    expect(err!.statusCode).toBe(400);
    expect(err!.message).toContain("astrology");
  });

  it("input.domains 缺失时，payload.domains 字符串数组作为显式来源", async () => {
    const { queries, pool } = fakePool();
    const catalog = buildCatalog();
    const store = new PgTaskStore(pool, undefined, createDisciplineResolver(catalog));

    await store.publish({
      title: "t",
      text: "x",
      createdBy: "me",
      payload: { domains: ["biology", "statistics"] },
    });

    const insertedPayload = queries[0]!.values[6] as Record<string, unknown>;
    expect(insertedPayload.domains).toEqual(["biology", "statistics"]);
    expect((insertedPayload.domainBinding as { matches: Array<{ domainId: string }> }).matches.map((m) => m.domainId)).toEqual(["biology", "statistics"]);
  });

  it("payload.domains 非字符串数组 → 按空处理并走别名扫描", async () => {
    const { queries, pool } = fakePool();
    const catalog = buildCatalog();
    const store = new PgTaskStore(pool, undefined, createDisciplineResolver(catalog));

    await store.publish({
      title: "BIO 作业",
      text: "cell biology",
      createdBy: "me",
      payload: { domains: "biology" },
    });

    const insertedPayload = queries[0]!.values[6] as Record<string, unknown>;
    expect(insertedPayload.domains).toEqual(["biology"]);
    expect((insertedPayload.domainBinding as { matches: Array<{ evidence: string[] }> }).matches[0]!.evidence).toEqual(["text:bio"]);
  });

  it("delegate 通道继承 payload.domains，不重跑 resolver", async () => {
    const { queries, pool } = fakePool();
    const failingResolver: DisciplineResolverPort = {
      resolve: () => ({ ok: false, error: "resolver must not run for delegate" }),
    };
    const store = new PgTaskStore(pool, undefined, failingResolver);

    await store.publish({
      title: "child",
      text: "child text",
      createdBy: "worker:developer",
      payload: { domains: ["statistics"], delivery: { path: ["origin", "developer"] } },
      deliveryMode: "delegate",
      delegateTarget: "coder",
    });

    const insertedPayload = queries[0]!.values[6] as Record<string, unknown>;
    expect(insertedPayload.domains).toEqual(["statistics"]);
    expect(insertedPayload.domainBinding).toBeUndefined();
  });
});
