import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildExecBackends,
  confirmLocalProcessTrust,
  createLocalProcessTarget,
  localProcessTarget,
  parseUrlHostPort,
  type TargetContext,
} from "../../src/cli/runtime/targets/index.js";

describe("localProcessTarget.envPresets", () => {
  it("sandbox=process 快照", () => {
    const presets = localProcessTarget.envPresets({ sandbox: "process", workspacesHost: "/tmp/ws", compiledCacheDir: "/tmp/cache" });
    expect(presets).toMatchObject({
      PTH_CONFIG_STRICT: "0",
      SANDBOX_URL: "http://127.0.0.1:8080",
      PTH_SANDBOX_KERNEL_URL: "http://127.0.0.1:8080",
      PTH_WORKSPACES_PATH: "/tmp/ws",
      PTH_COMPILED_CACHE_DIR: "/tmp/cache",
      PTH_PYTHON_MODE: "sandbox-kernel",
      PTH_BASH_MODE: "sandbox-kernel",
      PTH_EXEC_SANDBOX_ALIAS: "on",
    });
  });

  it("sandbox=none 快照", () => {
    const presets = localProcessTarget.envPresets({ sandbox: "none" });
    expect(presets).toMatchObject({
      PTH_CONFIG_STRICT: "0",
      PTH_PYTHON_MODE: "kernel",
      PTH_BASH_MODE: "kernel",
      PTH_EXEC_SANDBOX_ALIAS: "off",
    });
    expect(presets.PTH_WORKSPACES_PATH).toBeUndefined();
  });
});

describe("buildExecBackends", () => {
  it("sandbox=process 必含 sandbox；lean/u8 按需加入且无 pathMapping", () => {
    const onlySandbox = JSON.parse(buildExecBackends({ sandbox: "process", includeLean: false, includeU8: false })) as Array<Record<string, unknown>>;
    expect(onlySandbox).toEqual([
      { id: "sandbox", url: "http://127.0.0.1:8080", profile: "sandbox-untrusted", tokenEnv: "SANDBOX_SHARED_SECRET", required: true },
    ]);

    const full = JSON.parse(buildExecBackends({ sandbox: "process", includeLean: true, includeU8: true })) as Array<Record<string, unknown>>;
    expect(full.map((b) => b.id)).toEqual(["sandbox", "local-lean", "local-u8"]);
    expect(full.every((b) => !("pathMapping" in b))).toBe(true);
  });

  it("sandbox=none 不含 sandbox backend", () => {
    const backends = JSON.parse(buildExecBackends({ sandbox: "none", includeLean: true, includeU8: false })) as Array<Record<string, unknown>>;
    expect(backends.map((b) => b.id)).toEqual(["local-lean"]);
  });
});

describe("parseUrlHostPort", () => {
  it("解析认证 URL / 缺省端口 / IPv6", () => {
    expect(parseUrlHostPort("redis://:pass@127.0.0.1:6380/0", 6379)).toEqual({ host: "127.0.0.1", port: 6380 });
    expect(parseUrlHostPort("redis://localhost", 6379)).toEqual({ host: "localhost", port: 6379 });
    expect(parseUrlHostPort("postgresql://u:p@[::1]:5433/db", 5432)).toEqual({ host: "[::1]", port: 5433 });
  });
});

describe("createLocalProcessTarget up/down 顺序", () => {
  it("数据层跳过 → sandbox spawn → engine spawn → seed → verify → down 反向", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "pth-local-process-"));
    await mkdir(join(repoRoot, "dist", "pth"), { recursive: true });
    await mkdir(join(repoRoot, "packages", "pth-sandbox", "dist"), { recursive: true });
    await writeFile(join(repoRoot, "dist", "pth", "main.js"), "// engine");
    await writeFile(join(repoRoot, "packages", "pth-sandbox", "dist", "main.js"), "// sandbox");

    const order: string[] = [];
    const target = createLocalProcessTarget({
      runDir: join(repoRoot, ".run"),
      spawnDetached: async (opts) => {
        order.push(`spawn:${opts.name}`);
        return { pid: 100 + order.length };
      },
      stopDetached: async (name) => { order.push(`stop:${name}`); },
      detachedStatus: async () => ({ running: false }),
      fetchLike: (async (url: string) => {
        order.push(`fetch:${url}`);
        return { ok: true, status: 200, text: async () => "" } as unknown as Response;
      }) as typeof fetch,
      createRedisClient: () => ({
        set: async () => { order.push("seed:set"); },
        keys: async () => [],
        get: async () => null,
        del: async () => {},
      }),
      randomToken: () => "test-token-123",
    });

    const log: string[] = [];
    const ctx: TargetContext = {
      repoRoot,
      env: { REDIS_URL: "redis://127.0.0.1:6379", PTH_WORKSPACES_HOST: repoRoot },
      envFile: join(repoRoot, "deploy", ".env.pth.secrets"),
      runner: async () => ({ code: 0, stdout: "", stderr: "" }),
      timeoutMs: 1000,
      log: (line) => log.push(line),
      sandbox: "process",
      components: [],
    };

    await target.upData(ctx, ["redis"]);
    await target.upData(ctx, ["postgres"]);
    await target.upData(ctx, ["sandbox"]);
    await target.engineUp(ctx, []);
    await target.down(ctx, []);

    expect(order).toEqual([
      "spawn:pth-sandbox",
      "fetch:http://127.0.0.1:8080/ready",
      "spawn:pth-engine",
      "fetch:http://127.0.0.1:3000/health",
      "fetch:http://127.0.0.1:3000/api/v1/self/version",
      "seed:set",
      "stop:pth-sandbox",
      "stop:pth-engine",
    ]);
    expect(log.join("\n")).toContain("外部数据层");
  });
});

describe("confirmLocalProcessTrust", () => {
  it("--yes-i-know 写入 ack 文件", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pth-trust-"));
    const ackFile = join(dir, "ack");
    await confirmLocalProcessTrust({ yes: true, ackFile });
    expect(await readFile(ackFile, "utf8")).toContain("ok");
  });

  it("非 TTY 且未带 flag → 报错", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pth-trust-"));
    await expect(confirmLocalProcessTrust({ yes: false, stdinIsTTY: false, ackFile: join(dir, "ack") }))
      .rejects.toThrow(/--yes-i-know/);
  });

  it("已有 ack 文件则不再要求确认", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pth-trust-"));
    const ackFile = join(dir, "ack");
    await writeFile(ackFile, "ok\n");
    await expect(confirmLocalProcessTrust({ yes: false, stdinIsTTY: false, ackFile })).resolves.toBeUndefined();
  });
});
