import { describe, it, expect, vi } from "vitest";
import {
  PgSideEffectOutbox,
  createSideEffectDrainer,
  type SideEffectRow,
} from "../../src/pth/tasking/side-effect-outbox.js";

/** fake 表：复刻 PgSideEffectOutbox 语义（幂等 key / pending 重放 / attempts≥3 failed）。 */
class FakeSideEffectOutbox {
  rows = new Map<string, SideEffectRow>();
  private seq = 0;

  async enqueue(input: { key: string; tenantId: string; kind: string; payload: unknown }): Promise<void> {
    if (this.rows.has(input.key)) return;
    this.rows.set(input.key, {
      id: String(++this.seq),
      key: input.key,
      tenantId: input.tenantId,
      kind: input.kind,
      payload: input.payload,
      status: "pending",
      attempts: 0,
      createdAt: new Date(),
      doneAt: null,
    });
  }

  async claimPending(limit: number): Promise<SideEffectRow[]> {
    return [...this.rows.values()]
      .filter((r) => r.status === "pending")
      .sort((a, b) => Number(a.id) - Number(b.id))
      .slice(0, limit)
      .map((r) => ({ ...r, payload: structuredClone(r.payload) }));
  }

  async complete(key: string): Promise<void> {
    const row = this.rows.get(key);
    if (row) {
      row.status = "done";
      row.doneAt = new Date();
    }
  }

  async markFailed(key: string, attempts: number): Promise<void> {
    const row = this.rows.get(key);
    if (!row) return;
    row.attempts = attempts;
    row.status = attempts >= 3 ? "failed" : "pending";
    row.doneAt = attempts >= 3 ? new Date() : null;
  }
}

describe("PgSideEffectOutbox SQL", () => {
  it("enqueue 使用幂等 ON CONFLICT (key) DO NOTHING", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const outbox = new PgSideEffectOutbox({ query } as never);
    await outbox.enqueue({ key: "k1", tenantId: "tenant-a", kind: "refine", payload: { a: 1 } });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("ON CONFLICT (key) DO NOTHING"),
      ["k1", "tenant-a", "refine", JSON.stringify({ a: 1 })],
    );
  });

  it("claimPending/complete/markFailed 使用对应 SQL", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const outbox = new PgSideEffectOutbox({ query } as never);
    await outbox.claimPending(10);
    await outbox.complete("k1");
    await outbox.markFailed("k2", 3);
    expect(query).toHaveBeenNthCalledWith(1, expect.stringContaining("FOR UPDATE SKIP LOCKED"), [10]);
    expect(query).toHaveBeenNthCalledWith(2, expect.stringContaining("status = 'done'"), ["k1"]);
    expect(query).toHaveBeenNthCalledWith(3, expect.stringContaining("CASE WHEN $2 >= 3"), ["k2", 3]);
  });
});

describe("createSideEffectDrainer（fake outbox）", () => {
  it("enqueue 幂等：同 key 只保留首写", async () => {
    const outbox = new FakeSideEffectOutbox();
    await outbox.enqueue({ key: "refine:default:t1:1", tenantId: "default", kind: "refine", payload: { n: 1 } });
    await outbox.enqueue({ key: "refine:default:t1:1", tenantId: "default", kind: "refine", payload: { n: 2 } });
    const rows = await outbox.claimPending(10);
    expect(rows).toHaveLength(1);
    expect((rows[0]!.payload as { n: number }).n).toBe(1);
  });

  it("claim→handler 成功→complete", async () => {
    const outbox = new FakeSideEffectOutbox();
    await outbox.enqueue({ key: "k1", tenantId: "default", kind: "refine", payload: { x: 1 } });
    const handled: unknown[] = [];
    const drainer = createSideEffectDrainer({
      outbox,
      handlers: {
        refine: async (payload) => { handled.push(payload); },
      },
    });
    await drainer.drainOnce();
    expect(handled).toEqual([{ x: 1 }]);
    expect((await outbox.claimPending(10))).toHaveLength(0);
    expect(outbox.rows.get("k1")!.status).toBe("done");
  });

  it("handler 抛错 → markFailed+attempts；attempts≥3 置 failed 留审计且不再领取", async () => {
    const outbox = new FakeSideEffectOutbox();
    await outbox.enqueue({ key: "k1", tenantId: "default", kind: "refine", payload: { x: 1 } });
    const handler = vi.fn(async () => { throw new Error("llm down"); });
    const drainer = createSideEffectDrainer({ outbox, handlers: { refine: handler } });
    await drainer.drainOnce();
    expect(outbox.rows.get("k1")!.attempts).toBe(1);
    expect(outbox.rows.get("k1")!.status).toBe("pending");   // 回 pending 重试
    await drainer.drainOnce();
    expect(outbox.rows.get("k1")!.attempts).toBe(2);
    expect(outbox.rows.get("k1")!.status).toBe("pending");
    await drainer.drainOnce();
    expect(outbox.rows.get("k1")!.attempts).toBe(3);
    expect(outbox.rows.get("k1")!.status).toBe("failed");    // 留审计
    expect(handler).toHaveBeenCalledTimes(3);
    await drainer.drainOnce();
    expect(handler).toHaveBeenCalledTimes(3);                // failed 不再领取
  });

  it("进程“重启”：同一 fake 表 pending 行被新 drainer 重放", async () => {
    const outbox = new FakeSideEffectOutbox();
    await outbox.enqueue({ key: "k1", tenantId: "default", kind: "refine", payload: { x: 1 } });
    await outbox.enqueue({ key: "k2", tenantId: "default", kind: "refine", payload: { x: 2 } });

    // 第一次“进程”：只处理 k1 后崩溃（k2 仍 pending）
    const crashHandler = vi.fn(async (_payload: unknown, row: SideEffectRow) => {
      if (row.key === "k1") return;
      throw new Error("crash before complete");
    });
    const first = createSideEffectDrainer({ outbox, handlers: { refine: crashHandler } });
    await first.drainOnce();
    expect(outbox.rows.get("k1")!.status).toBe("done");
    expect(outbox.rows.get("k2")!.status).toBe("pending");

    // 重启后新 drainer 重放 pending
    const handled: string[] = [];
    const second = createSideEffectDrainer({
      outbox,
      handlers: { refine: async (payload) => { handled.push(String((payload as { x: number }).x)); } },
    });
    await second.drainOnce();
    expect(handled).toEqual(["2"]);
    expect(outbox.rows.get("k2")!.status).toBe("done");
  });

  it("start/stop 使用 unref timer", async () => {
    const outbox = new FakeSideEffectOutbox();
    const drainer = createSideEffectDrainer({ outbox, handlers: {}, tickMs: 5 });
    drainer.start();
    drainer.stop();   // 停止后不抛
  });
});
