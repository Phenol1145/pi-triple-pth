import { describe, it, expect, vi } from "vitest";
import { PgTranscriptStore } from "@away_from/pth-kernel-storage";

/** W-a：listRecent 的 SQL 形态单测（不依赖真实 PG）。 */
describe("PgTranscriptStore.listRecent", () => {
  it("按 created_at desc 查询，带 agentId 过滤与 limit 参数", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: "t1" }] });
    const store = new PgTranscriptStore({ query } as never);
    const since = new Date("2026-01-01T00:00:00Z");
    const rows = await store.listRecent({ since, agentId: "developer", limit: 5 });
    expect(rows).toEqual([{ id: "t1" }]);
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("created_at >= $1");
    expect(sql).toContain("AND agent_id = $2");
    expect(sql).toContain("ORDER BY created_at DESC");
    expect(sql).toContain("LIMIT $3");
    expect(params).toEqual([since, "developer", 5]);
  });

  it("无 agentId 时只按时间窗过滤", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const store = new PgTranscriptStore({ query } as never);
    const since = new Date("2026-01-01T00:00:00Z");
    await store.listRecent({ since, limit: 20 });
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).not.toContain("agent_id");
    expect(sql).toContain("LIMIT $2");
    expect(params).toEqual([since, 20]);
  });

  it("limit 默认 50、上限 200", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const store = new PgTranscriptStore({ query } as never);
    await store.listRecent({ since: new Date(), limit: 999 });
    expect((query.mock.calls[0] as [string, unknown[]])[1].at(-1)).toBe(200);
    await store.listRecent({ since: new Date() });
    expect((query.mock.calls[1] as [string, unknown[]])[1].at(-1)).toBe(50);
  });
});
