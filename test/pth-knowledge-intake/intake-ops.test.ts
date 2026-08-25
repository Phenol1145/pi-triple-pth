import { describe, it, expect } from "vitest";
import { IntakeOpsRegistry } from "../../src/pth/execution/knowledge-intake/intake-ops.js";

describe("N26 持续运营指标", () => {
  it("record/snapshot 计数", () => {
    const ops = new IntakeOpsRegistry();
    ops.record("fetched");
    ops.record("fetched");
    ops.record("promoted");
    expect(ops.snapshot()).toEqual({ fetched: 2, promoted: 1, failed: 0, deadLetters: 0 });
  });
});
