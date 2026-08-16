import { describe, it, expect, vi, afterEach } from "vitest";

/**
 * S1-1：obs.resource() 聚合纳入 kernels（N5 资源环 L3）。
 * dataWorld 用 mock（obs.resource 只经 pgStat/requestMain 走数据面）；fetch 注入模拟 /kernel/status。
 */
describe("obs.resource 聚合含 kernels（S1-1）", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.PTH_SANDBOX_KERNEL_URL;
    delete process.env.SANDBOX_URL;
    delete process.env.SANDBOX_SHARED_SECRET;
  });

  async function makeObs() {
    const { obsExtension } = await import("../../src/pth/kernel/extensions/obs.js");
    return obsExtension.provide!({
      dataWorld: {
        pgStat: async () => [],
        queryReadOnly: async () => [],
      } as never,
    } as never)["obs"] as Record<string, (...args: unknown[]) => Promise<Record<string, unknown>>>;
  }

  it("resource 聚合包含 kernels（受信 /kernel/status 通路）", async () => {
    process.env.PTH_SANDBOX_KERNEL_URL = "http://sandbox.test:8080";
    process.env.SANDBOX_SHARED_SECRET = "s1-secret";
    const fake = { pools: [{ lang: "python", metrics: { acquireSuccess: 3 } }], compiled: {}, debug: {} };
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => fake })) as never);

    const obs = await makeObs();
    const r = await obs.resource();
    expect(r.kernels).toEqual(fake);
    expect(r).toHaveProperty("container");
    expect(r).toHaveProperty("pg");
    expect(r).toHaveProperty("storage");
  });

  it("kernels 数据源失败时降级为 error，其余数据源照常", async () => {
    process.env.PTH_SANDBOX_KERNEL_URL = "http://sandbox.test:8080";
    process.env.SANDBOX_SHARED_SECRET = "s1-secret";
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }) as never);

    const obs = await makeObs();
    const r = await obs.resource();
    expect(r.kernels).toMatchObject({ error: expect.stringContaining("ECONNREFUSED") });
    expect(r).toHaveProperty("container");
    expect(r).toHaveProperty("storage");
  });

  it("sandbox URL 未配置时 kernels 返回明确 error", async () => {
    delete process.env.PTH_SANDBOX_KERNEL_URL;
    delete process.env.SANDBOX_URL;
    const obs = await makeObs();
    const r = await obs.resource();
    expect(r.kernels).toMatchObject({ error: expect.stringContaining("未配置") });
  });
});
