import { describe, it, expect } from "vitest";
import { CognitiveLedgerOutbox } from "../../src/pth/execution/task-cognitive-ledger-outbox.js";

describe("N28 认知账本 outbox", () => {
  it("append/drain/pending", () => {
    const outbox = new CognitiveLedgerOutbox();
    outbox.append({ id: "e1", type: "factor-recorded", taskId: "t1", workerId: "w1", payload: { factor: "x" }, at: 1 });
    expect(outbox.pending()).toHaveLength(1);
    expect(outbox.drain()).toHaveLength(1);
    expect(outbox.pending()).toHaveLength(0);
  });
});
