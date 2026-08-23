import { describe, expect, it } from "vitest";
import { InternalExecutorRegistry } from "../../src/pth/execution/internal-executor-registry.js";

describe("InternalExecutorRegistry", () => {
  it("register/get/execute 基础行为", async () => {
    const reg = new InternalExecutorRegistry();
    reg.register("obs.query", async (_cap, args) => ({
      ok: true,
      value: { sql: args.sql },
      durationMs: 1,
    }));
    expect(reg.has("obs.query")).toBe(true);
    const r = await reg.execute("obs.query", { sql: "select 1" });
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ sql: "select 1" });
  });

  it("未注册返回结构化错误", async () => {
    const reg = new InternalExecutorRegistry();
    const r = await reg.execute("dev.write", {});
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain("未注册");
  });

  it("executor 抛错归一化为 ok:false", async () => {
    const reg = new InternalExecutorRegistry();
    reg.register("boom", async () => { throw new Error("boom"); });
    const r = await reg.execute("boom", {});
    expect(r.ok).toBe(false);
    expect(r.error?.message).toBe("boom");
  });
});
