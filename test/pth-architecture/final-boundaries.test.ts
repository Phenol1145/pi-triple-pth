import { describe, expect, it } from "vitest";
import path from "node:path";
import { collectBoundaryViolations } from "../../scripts/check/pth-boundaries-core.js";
import { buildPthHost } from "../../src/pth/bootstrap/pth-host.js";
import { DEFAULT_MODULE_MANIFEST } from "../../src/pth/bootstrap/module-manifest.js";

describe("P3-5：最终边界（契约/模块/CI 语义）", () => {
  it("contracts/tasking/runner/execution/catalog/bootstrap/gateway 全量违规为 0", async () => {
    const src = path.resolve(import.meta.dirname, "../../src/pth");
    const violations = await collectBoundaryViolations(src);
    expect(violations).toEqual([]);
  });

  it("bootstrap 可组装 adapters（buildPthHost），业务模块不 import 他方 storage adapter", async () => {
    const host = await buildPthHost(DEFAULT_MODULE_MANIFEST);
    expect(host.catalog.roleIds().length).toBeGreaterThan(0);
  });
});
