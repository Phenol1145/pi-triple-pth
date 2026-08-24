import { describe, it, expect } from "vitest";
import { expandMatrix } from "../../src/pth/bench/matrix.js";
import type { BenchScenario } from "../../src/pth/bench/core.js";

describe("PTH Bench W4 matrix", () => {
  it("场景×模式展开", () => {
    const scenarios: BenchScenario[] = [
      { id: "s1", title: "S", graders: [{ kind: "status", expect: "completed" }] },
    ];
    const expanded = expandMatrix(scenarios, ["tool-call", "ptc"]);
    expect(expanded).toHaveLength(2);
    expect(expanded[0]!.id).toBe("s1::tool-call");
    expect(expanded[0]!.execPolicy?.execMode).toBe("tool-call");
    expect(expanded[1]!.execPolicy?.execMode).toBe("ptc");
  });
});
