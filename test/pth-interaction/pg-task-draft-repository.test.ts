import { describe, it, expect } from "vitest";
import { PgTaskDraftRepository, type Queryable } from "../../src/pth/interaction/pg-task-draft-repository.js";
import type { TaskDraft } from "@away_from/pth-contracts";

function fakePool(): Queryable & { rows: Array<Record<string, unknown>> } {
  const rows: Array<Record<string, unknown>> = [];
  return {
    rows,
    async query(text: string, params?: unknown[]) {
      if (text.startsWith("CREATE TABLE")) return { rows: [] };
      if (text.startsWith("INSERT")) {
        rows.length = 0;
        rows.push({
          id: params![0], revision: params![1], tenantId: params![2], principalId: params![3],
          title: params![4], text: params![5], status: params![6], createdAt: params![7], updatedAt: params![8], contentHash: params![9],
        });
        return { rows };
      }
      return { rows };
    },
  };
}

describe("N25 PG TaskDraft Repository", () => {
  it("save/get round-trip", async () => {
    const pool = fakePool();
    const repo = new PgTaskDraftRepository(pool);
    await repo.ensureTable();
    const draft: TaskDraft = {
      id: "d1", revision: 1, tenantId: "t", principalId: "p",
      title: "T", text: "X", status: "draft",
      createdAt: "2026-08-24T00:00:00.000Z", updatedAt: "2026-08-24T00:00:00.000Z", contentHash: "h".repeat(64),
    };
    await repo.save(draft);
    const got = await repo.get("d1");
    expect(got?.title).toBe("T");
    expect(got?.contentHash).toBe("h".repeat(64));
  });
});
