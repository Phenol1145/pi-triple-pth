/**
 * product-boundaries.test.ts —— PTL/PTH 产品边界回归。
 * 归属与例外见 docs/pth/module-ownership.md。
 */

import { describe, expect, it } from "vitest";
import { collectProductBoundaryViolations } from "../../scripts/check-product-boundaries.js";

describe("PTL/PTH product boundaries", () => {
  it("PTH core 不 import PTL-only，PTL-only 不 import PTH core", () => {
    const report = collectProductBoundaryViolations();
    expect(report.violations, JSON.stringify(report.violations, null, 2)).toEqual([]);
  });

  it("过渡区（bridge/operator-console）已被显式记录", () => {
    const report = collectProductBoundaryViolations();
    expect(report.transitionalFiles.length).toBeGreaterThan(0);
    for (const file of report.transitionalFiles) {
      expect(file).toMatch(/^packages\/pth-console\/src\/(bridge|operator-console)\//);
    }
  });
});
