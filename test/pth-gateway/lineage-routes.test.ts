import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { registerLineageRoutes } from "../../src/pth/gateway/routes-lineage";

/**
 * 监督层通道（2026-08-12 审计 MEDIUM-HIGH-3 修复）：approve/reject 仅限 platform-admin。
 * 本测试不含全局 auth hook——req.auth undefined 也须 403（防遗漏 auth 装配的部署）。
 */
function buildApp(kernel: unknown) {
  const app = Fastify();
  registerLineageRoutes(app, kernel as never);
  return app;
}

describe("lineage 监督层通道鉴权", () => {
  it("approve 无 auth（undefined）→ 403", async () => {
    const app = buildApp(null);
    const res = await app.inject({ method: "POST", url: "/api/v1/kernel/lineage/approve", payload: { proposalId: "p1" } });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("reject 无 auth → 403", async () => {
    const app = buildApp(null);
    const res = await app.inject({ method: "POST", url: "/api/v1/kernel/lineage/reject", payload: { proposalId: "p1" } });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});
