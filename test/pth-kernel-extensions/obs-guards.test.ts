import { describe, it, expect } from "vitest";

/**
 * N14 P1 / N12 二期观测面：obs.guards——scorecard.guards（D1 已落 trace 聚合）出 obs。
 * dataWorld 用 mock（queryReadOnly 返回 task-scorecard 行——content::jsonb->'guards' 段）。
 */
async function makeObs(rows: Array<{ role: string | null; guards: unknown }>) {
  const { obsExtension } = await import("@away_from/pth-kernel-interpreter");
  const calls: string[] = [];
  const obs = obsExtension.provide!({
    dataWorld: {
      queryReadOnly: async (sql: string) => { calls.push(sql); return rows; },
    } as never,
  } as never)["obs"] as Record<string, (opts?: Record<string, unknown>) => Promise<Record<string, unknown>>>;
  return { obs, calls };
}

const row = (role: string, guards: unknown) => ({ role, guards });

describe("obs.guards（N12 二期观测面——sensor:rule 数据源）", () => {
  it("按护栏分账聚合 hits/guide/soft/hard + killRatio", async () => {
    const { obs } = await makeObs([
      row("developer", { hits: { "repeat-action": 4, "unknown-tool": 2 }, guide: { "repeat-action": 2 }, soft: { "repeat-action": 1 }, hard: { "unknown-tool": 1 } }),
      row("coder", { hits: { "repeat-action": 2 }, soft: { "repeat-action": 1 }, hard: {} }),
    ]);
    const r = await obs.guards();
    expect(r.tasks).toBe(2);
    const guards = r.guards as Record<string, { hits: number; guide: number; soft: number; hard: number; killRatio: number }>;
    expect(guards["repeat-action"]).toEqual({ hits: 6, guide: 2, soft: 2, hard: 0, killRatio: 0.33 });
    expect(guards["unknown-tool"]).toEqual({ hits: 2, guide: 0, soft: 0, hard: 1, killRatio: 0.5 });
  });

  it("byRole 分角色聚合", async () => {
    const { obs } = await makeObs([
      row("developer", { hits: { "empty-done": 3 }, hard: { "empty-done": 1 } }),
      row("coder", { hits: { "empty-done": 1 } }),
    ]);
    const r = await obs.guards();
    const byRole = r.byRole as Record<string, Record<string, { hits: number; hard: number; killRatio: number }>>;
    expect(byRole["developer"]?.["empty-done"]).toMatchObject({ hits: 3, hard: 1, killRatio: 0.33 });
    expect(byRole["coder"]?.["empty-done"]).toMatchObject({ hits: 1, hard: 0, killRatio: 0 });
  });

  it("pre-D1 旧条目（无 guards 段）跳过不计", async () => {
    const { obs } = await makeObs([
      row("developer", null),
      row("coder", { hits: { "unknown-tool": 1 } }),
    ]);
    const r = await obs.guards();
    expect(r.tasks).toBe(1);
    expect((r.guards as Record<string, unknown>)["unknown-tool"]).toMatchObject({ hits: 1 });
  });

  it("role 过滤白名单含冒号（治理角色 sensor:rule 可查——与 callpoint 的 [a-z0-9-] 不同）", async () => {
    const { obs, calls } = await makeObs([]);
    await obs.guards({ role: "sensor:rule", since: "3600" });
    expect(calls[0]).toContain("meta->>'role' = 'sensor:rule'");
    expect(calls[0]).toContain("make_interval(secs => 3600)");
  });

  it("非法 role 不进 SQL（注入防线）；空结果返回零值面", async () => {
    const { obs, calls } = await makeObs([]);
    await obs.guards({ role: "x'; DROP TABLE tasks;--" });
    expect(calls[0]).not.toContain("DROP");
    const r = await obs.guards();
    expect(r).toMatchObject({ tasks: 0, guards: {}, byRole: {} });
  });

  it("数据源失败降级 error 对象（不打崩调用方）", async () => {
    const { obsExtension } = await import("@away_from/pth-kernel-interpreter");
    const obs = obsExtension.provide!({
      dataWorld: { queryReadOnly: async () => { throw new Error("pg down"); } } as never,
    } as never)["obs"] as Record<string, () => Promise<Record<string, unknown>>>;
    const r = await obs.guards();
    expect(r).toMatchObject({ error: expect.stringContaining("pg down") });
  });
});
