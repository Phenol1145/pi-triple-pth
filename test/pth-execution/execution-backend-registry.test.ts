import { describe, expect, it } from "vitest";
import {
  buildExecutionBackendRegistry,
  probeExecutionBackends,
  type ExecutionBackendRegistry,
} from "../../src/pth/execution/backend-registry.js";
import type { ExecutionCapabilities } from "@away_from/shared/execution";

const V1_CAPS: ExecutionCapabilities = {
  version: "execution/v1",
  streaming: true,
  cancel: true,
  cwdWhitelist: true,
  uidIsolation: true,
  egressLocked: true,
  pathMapping: false,
};

function okCapsResponse(): Response {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(V1_CAPS),
    json: async () => V1_CAPS,
  } as unknown as Response;
}

function failingFetch(error = new Error("backend down")): typeof fetch {
  return (async () => { throw error; }) as unknown as typeof fetch;
}

const QUIET = { warn: () => {}, error: () => {} };

describe("P1.2：execution backend registry（fail-closed 合成/校验/路由/探测）", () => {
  it("空配置 + sandbox alias 开 → 合成 sandbox（required 跟随 strict）", () => {
    const dev = buildExecutionBackendRegistry({ env: {}, strict: false });
    expect([...dev.registry.list().keys()]).toEqual(["sandbox"]);
    expect(dev.registry.get("sandbox")?.descriptor).toMatchObject({
      url: "http://localhost:8080",
      profile: "sandbox-untrusted",
      tokenEnv: "SANDBOX_SHARED_SECRET",
      required: false,
    });
    expect(dev.warnings).toHaveLength(1); // token env 缺失（dev 仅告警）

    // strict 下合成 sandbox required=true → 缺 token 直接拒绝启动（fail-closed）
    expect(() => buildExecutionBackendRegistry({ env: {}, strict: true }))
      .toThrow(/requires env SANDBOX_SHARED_SECRET/);

    const prod = buildExecutionBackendRegistry({
      env: { SANDBOX_SHARED_SECRET: "s3cret-s3cret-s3cret" },
      strict: true,
    });
    expect(prod.registry.get("sandbox")?.descriptor.required).toBe(true);
    expect(prod.warnings).toHaveLength(0);
  });

  it("alias off → 不合成 sandbox；显式配置 sandbox 时不重复合成", () => {
    const off = buildExecutionBackendRegistry({
      env: { PTH_EXEC_SANDBOX_ALIAS: "off" },
      strict: false,
    });
    expect(off.registry.list().size).toBe(0);

    // 退出门：strict + 零 backend → 启动即失败
    expect(() => buildExecutionBackendRegistry({
      env: { PTH_EXEC_SANDBOX_ALIAS: "off" },
      strict: true,
    })).toThrow(/no execution backends configured/);

    const explicit = buildExecutionBackendRegistry({
      descriptorsJson: JSON.stringify([
        { id: "sandbox", url: "http://custom-sandbox:9999", profile: "sandbox-untrusted" },
      ]),
      env: {},
      strict: false,
    });
    expect(explicit.registry.list().size).toBe(1);
    expect(explicit.registry.get("sandbox")?.descriptor.url).toBe("http://custom-sandbox:9999");
  });

  it("descriptor JSON 解析：合法多后端 + 约定 routes；非法 JSON/未知字段/重复 id fail-closed", () => {
    const { registry } = buildExecutionBackendRegistry({
      descriptorsJson: JSON.stringify([
        { id: "local-lean", url: "http://host.docker.internal:8787", profile: "host" },
        { id: "local-asm", url: "http://host.docker.internal:8788", profile: "host" },
      ]),
      routesJson: JSON.stringify({ lean4: "local-lean", assembly: "local-asm" }),
      env: { PTH_EXEC_SANDBOX_ALIAS: "off" },
      strict: false,
    });
    expect([...registry.list().keys()]).toEqual(["local-lean", "local-asm"]);
    expect(registry.routes).toEqual({ lean4: "local-lean", assembly: "local-asm" });

    const bad = (input: Parameters<typeof buildExecutionBackendRegistry>[0]) => () =>
      buildExecutionBackendRegistry({ env: {}, strict: false, ...input });
    expect(bad({ descriptorsJson: "{nope" })).toThrow(/PTH_EXEC_BACKENDS 不是合法 JSON/);
    expect(bad({ descriptorsJson: JSON.stringify({ id: "x", url: "http://x", profile: "host" }) })).toThrow(/array/);
    expect(bad({ descriptorsJson: JSON.stringify([{ id: "x", url: "http://x", profile: "host", unknown: 1 }]) })).toThrow(/unknown backend descriptor field/);
    expect(bad({
      descriptorsJson: JSON.stringify([
        { id: "x", url: "http://a", profile: "host" },
        { id: "x", url: "http://b", profile: "host" },
      ]),
    })).toThrow(/duplicate backend id/);
  });

  it("routes fail-closed：非法 runtime id / 指向未注册 backend", () => {
    expect(() => buildExecutionBackendRegistry({
      env: { PTH_EXEC_SANDBOX_ALIAS: "off" },
      strict: false,
      routesJson: JSON.stringify({ "not-a-runtime": "sandbox" }),
    })).toThrow(/非法 runtime id/);

    expect(() => buildExecutionBackendRegistry({
      env: { PTH_EXEC_SANDBOX_ALIAS: "off" },
      strict: false,
      routesJson: JSON.stringify({ lean4: "ghost" }),
    })).toThrow(/指向未注册 backend/);
  });

  it("tokenEnv 缺失：strict+required 抛错，否则告警", () => {
    const descriptor = { id: "secured", url: "http://secured:8080", profile: "host" as const, tokenEnv: "SECURED_TOKEN", required: true };
    expect(() => buildExecutionBackendRegistry({
      descriptorsJson: JSON.stringify([descriptor]),
      env: { PTH_EXEC_SANDBOX_ALIAS: "off" },
      strict: true,
    })).toThrow(/requires env SECURED_TOKEN/);

    const dev = buildExecutionBackendRegistry({
      descriptorsJson: JSON.stringify([{ ...descriptor, required: false }]),
      env: { PTH_EXEC_SANDBOX_ALIAS: "off" },
      strict: false,
    });
    expect(dev.warnings.some((w) => w.includes("SECURED_TOKEN"))).toBe(true);
  });

  it("probe：并行探测；strict+required 失败抛错 / 非 required 记 error / dev 仅告警", async () => {
    const build = (strict: boolean, ids: string[]): ExecutionBackendRegistry =>
      buildExecutionBackendRegistry({
        descriptorsJson: JSON.stringify(ids.map((id) => ({
          id,
          url: `http://${id}:8080`,
          profile: "host",
          ...(id === "must" ? { required: true } : {}),
        }))),
        env: { PTH_EXEC_SANDBOX_ALIAS: "off" },
        strict,
        fetchLike: failingFetch(),
      }).registry;

    await expect(probeExecutionBackends(build(true, ["must", "best-effort"]), {
      strict: true,
      timeoutMs: 500,
      logger: QUIET,
    })).rejects.toThrow(/backend must probe failed/);

    const errors: string[] = [];
    await probeExecutionBackends(build(true, ["best-effort"]), {
      strict: true,
      timeoutMs: 500,
      logger: { warn: () => {}, error: (m) => errors.push(m) },
    });
    expect(errors.some((m) => m.includes("best-effort"))).toBe(true);

    const devErrors: string[] = [];
    const devWarnings: string[] = [];
    await expect(probeExecutionBackends(build(false, ["a", "b"]), {
      strict: false,
      timeoutMs: 500,
      logger: { warn: (m) => devWarnings.push(m), error: (m) => devErrors.push(m) },
    })).resolves.toBeUndefined();
    expect(devErrors).toHaveLength(0);
    expect(devWarnings).toHaveLength(2);
  });

  it("probe 成功不写日志；capabilities 版本不匹配视为失败", async () => {
    const okRegistry = buildExecutionBackendRegistry({
      descriptorsJson: JSON.stringify([{ id: "ok", url: "http://ok:8080", profile: "host" }]),
      env: { PTH_EXEC_SANDBOX_ALIAS: "off" },
      strict: false,
      fetchLike: (async () => okCapsResponse()) as unknown as typeof fetch,
    }).registry;
    const logs: string[] = [];
    await probeExecutionBackends(okRegistry, {
      strict: true,
      timeoutMs: 500,
      logger: { warn: (m) => logs.push(m), error: (m) => logs.push(m) },
    });
    expect(logs).toHaveLength(0);

    const badRegistry = buildExecutionBackendRegistry({
      descriptorsJson: JSON.stringify([{ id: "v0", url: "http://v0:8080", profile: "host" }]),
      env: { PTH_EXEC_SANDBOX_ALIAS: "off" },
      strict: false,
      fetchLike: (async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ...V1_CAPS, version: "execution/v0" }),
        json: async () => ({ ...V1_CAPS, version: "execution/v0" }),
      } as unknown as Response)) as unknown as typeof fetch,
    }).registry;
    const badLogs: string[] = [];
    await probeExecutionBackends(badRegistry, {
      strict: true,
      timeoutMs: 500,
      logger: { warn: (m) => badLogs.push(m), error: (m) => badLogs.push(m) },
    });
    expect(badLogs.some((m) => m.includes("v0") && m.includes("capabilities"))).toBe(true);
  });

  it("registry get/list 契约：未知 id → undefined；routes 冻结语义", () => {
    const { registry } = buildExecutionBackendRegistry({ env: { PTH_EXEC_SANDBOX_ALIAS: "off" }, strict: false });
    expect(registry.get("ghost")).toBeUndefined();
    expect(registry.list().size).toBe(0);
    expect(registry.routes).toEqual({});
    expect(QUIET.warn).toBeTruthy();
  });
});
