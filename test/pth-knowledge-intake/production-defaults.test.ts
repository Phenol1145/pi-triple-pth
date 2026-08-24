import { describe, it, expect } from "vitest";
import { INTAKE_PRODUCTION_DEFAULTS } from "../../src/pth/execution/knowledge-intake/production-defaults.js";

describe("N26 生产默认阈值", () => {
  it("默认值 fail-closed", () => {
    expect(INTAKE_PRODUCTION_DEFAULTS.maxConcurrentFetches).toBeGreaterThan(0);
    expect(INTAKE_PRODUCTION_DEFAULTS.verificationStrength).toBe("strong");
  });
});
