import { describe, expect, it } from "vitest";
import { analyzeImportCycles } from "../../scripts/check-import-cycles.js";

describe("PTH import cycle gate", () => {
  it("static-runtime import graph has zero SCCs", async () => {
    const report = await analyzeImportCycles();
    const keys = report.staticRuntime.map((scc) => scc.join(" -> "));
    expect(keys, JSON.stringify(keys, null, 2)).toEqual([]);
  });
});
