import { describe, expect, it } from "vitest";
import { seedOperatorTokenViaRedis, type TokenSeedClient } from "../../src/cli/runtime/token-seed.js";

describe("seedOperatorTokenViaRedis", () => {
  it("SET 格式正确并回收同 tenant+source 的旧 token", async () => {
    const setCalls: Array<[string, string]> = [];
    const delCalls: string[][] = [];
    const values: Record<string, string> = {
      "auth:token:old-ops": JSON.stringify({ tenantId: "ops", role: "platform-admin", source: "pth-operator" }),
      "auth:token:other-tenant": JSON.stringify({ tenantId: "other", role: "platform-admin", source: "pth-operator" }),
      "auth:token:other-source": JSON.stringify({ tenantId: "ops", role: "tenant-agent", source: "manual" }),
      "auth:token:new": JSON.stringify({ tenantId: "ops", role: "platform-admin", source: "pth-operator" }),
    };
    const client: TokenSeedClient = {
      set: async (key, value) => { setCalls.push([key, value]); },
      keys: async () => Object.keys(values),
      get: async (key) => values[key] ?? null,
      del: async (...keys) => { delCalls.push(keys); },
    };

    await seedOperatorTokenViaRedis(client, "new", "ops");

    expect(setCalls).toEqual([["auth:token:new", JSON.stringify({ tenantId: "ops", role: "platform-admin", source: "pth-operator" })]]);
    expect(delCalls.flat()).toEqual(["auth:token:old-ops"]);
  });

  it("回收失败不阻断种入", async () => {
    let setCalled = false;
    const client: TokenSeedClient = {
      set: async () => { setCalled = true; },
      keys: async () => ["auth:token:old"],
      get: async () => JSON.stringify({ tenantId: "ops", source: "pth-operator" }),
      del: async () => { throw new Error("del failed"); },
    };
    await expect(seedOperatorTokenViaRedis(client, "new", "ops")).resolves.toBeUndefined();
    expect(setCalled).toBe(true);
  });
});
