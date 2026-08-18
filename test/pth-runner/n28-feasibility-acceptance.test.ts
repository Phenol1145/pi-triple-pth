import { describe, expect, it } from "vitest";
import { decideN28Acceptance, parseVitestSkipManifest, type N28AcceptanceEnvelope } from "../../scripts/accept-n28-feasibility.js";

function gate(overrides: Partial<N28AcceptanceEnvelope["focused"]> = {}): N28AcceptanceEnvelope["focused"] {
  return {
    command: "cmd", started: true, exitCode: 0, skipped: [], environmentStatus: "available", ...overrides,
  };
}

function evaluatorGo() {
  const provisional = {
    decision: "GO" as const,
    hypotheses: {
      H1: { passed: true, evidence: [] }, H2: { passed: true, evidence: [] }, H3: { passed: true, evidence: [] },
      H4: { passed: true, evidence: [] }, H5: { passed: true, evidence: [] }, H6: { passed: true, evidence: [] },
    },
    metrics: {},
  } as unknown as N28AcceptanceEnvelope["evaluator"]["first"];
  return provisional;
}

function passingEnvelope(overrides: Partial<N28AcceptanceEnvelope> = {}): N28AcceptanceEnvelope {
  const first = evaluatorGo();
  return {
    evaluatedCommit: "head", implementationTreeClean: true,
    evaluator: { first, second: first, byteIdentical: true },
    focused: gate(),
    n28Typecheck: gate(),
    fullRegression: gate({ skipped: [{ file: "test/pth-execution/sandbox-security.integration.test.ts", tests: 9 }] }),
    lint: gate(),
    decision: "GO",
    reasons: [],
    ...overrides,
  };
}

describe("N28 acceptance 决策（纯函数）", () => {
  it("完整通过 envelope → GO", () => {
    expect(decideN28Acceptance(passingEnvelope(), { currentHead: "head" })).toBe("GO");
  });

  it("任一字段/gate 变异 → 不返回 GO", () => {
    const first = evaluatorGo();
    const variants: Array<Partial<N28AcceptanceEnvelope>> = [
      { evaluatedCommit: "other" },
      { implementationTreeClean: false },
      { evaluator: { first, second: { ...first, decision: "NO-GO" }, byteIdentical: true } },
      { evaluator: { first, second: first, byteIdentical: false } },
      { focused: gate({ exitCode: 1 }) },
      { focused: gate({ skipped: [{ file: "x.test.ts", tests: 1 }] }) },
      { n28Typecheck: gate({ exitCode: 2 }) },
      { fullRegression: gate({ exitCode: 1 }) },
      { fullRegression: gate({ skipped: [] }) },
      { fullRegression: gate({ skipped: [{ file: "other.test.ts", tests: 9 }] }) },
      { lint: gate({ exitCode: 3 }) },
      { focused: gate({ started: false }) },
      { focused: gate({ environmentStatus: "unavailable", unavailableReason: "postgres" }) },
      { lint: gate({ environmentStatus: "unavailable", unavailableReason: "toolchain" }) },
    ];
    for (const variant of variants) {
      expect(decideN28Acceptance(passingEnvelope(variant), { currentHead: "head" })).not.toBe("GO");
    }
  });

  it("parseVitestSkipManifest 归一化路径并聚合；未知 shape 抛错", () => {
    const json = {
      testResults: [
        {
          name: "/repo/test/a.test.ts",
          assertionResults: [{ status: "skipped" }, { status: "passed" }, { status: "pending" }],
        },
        {
          name: "/repo/test/a.test.ts",
          assertionResults: [{ status: "skipped" }],
        },
      ],
    };
    expect(parseVitestSkipManifest(json, "/repo")).toEqual([{ file: "test/a.test.ts", tests: 3 }]);
    expect(() => parseVitestSkipManifest({}, "/repo")).toThrow(/unknown vitest json shape/);
  });
});
