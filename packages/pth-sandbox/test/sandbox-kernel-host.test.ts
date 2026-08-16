import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KernelPool, createSandboxGrantIssuer, createSandboxGrantVerifier } from "@away_from/pth-sandbox";
import { buildKernelHostApp } from "@away_from/pth-sandbox";
import type { FastifyInstance } from "fastify";
import type { SandboxLease } from "@away_from/pth-sandbox";

/**
 * Kernel sandbox 宿主（P5）——池 + 协议单测（P0-4：opaque lease 协议）。
 * 真实 spawn python/bash（本机）；fastify inject 测协议；认证/敏感约束全覆盖。
 */

const SECRET = "test-kernel-secret";
const GRANT_SECRET = "kernel-host-grant-secret-0123456789";
const grantIssuer = createSandboxGrantIssuer({ secret: GRANT_SECRET });
function makeGrant() {
  return grantIssuer.issue({
    lease: { taskId: "task-host", leaseId: "bb7d7e7e-c3ec-4e58-b34d-2f6a2a70e0a6", generation: 1 },
    scope: { tenantId: "tenant-a", principalId: "worker:developer", roles: ["developer"], traceId: "trace-host" },
    workspace: { tenantId: "tenant-a", workspaceId: "ws-host", taskId: "task-host" },
    language: "python",
    capabilities: ["memory.read"],
  });
}

function auth(secret = SECRET) {
  return { authorization: `Bearer ${secret}` };
}

describe("KernelPool（sandbox 侧共享池，lease 协议）", () => {
  it("acquire：返回高熵 lease（不可预测），并执行代码", async () => {
    const pool = new KernelPool({ lang: "python", max: 2 });
    const lease = await pool.acquire();
    expect(lease.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(lease.generation).toBeGreaterThan(0);
    const r = await pool.execute(lease, "x = 6 * 7\n_result = x");
    expect(r.ok).toBe(true);
    expect(r.value).toBe(42);
    await pool.dispose();
  });

  it("release 后复用同一内核，但新 lease id 不同（状态延续）", async () => {
    const pool = new KernelPool({ lang: "python", max: 2 });
    const lease1 = await pool.acquire();
    await pool.execute(lease1, "carry = 'state-kept'");
    pool.release(lease1);
    const lease2 = await pool.acquire();
    expect(lease2.id).not.toBe(lease1.id); // 外部标识不可复用
    const r = await pool.execute(lease2, "_result = carry");
    expect(r.value).toBe("state-kept"); // 内部条目状态延续
    await pool.dispose();
  });

  it("metrics（S1-1）：acquire/release 幂等/lease 拒绝计数", async () => {
    const pool = new KernelPool({ lang: "python", max: 2 });
    const lease = await pool.acquire();
    pool.release(lease);
    pool.release(lease);   // 同 lease 重复 release = 幂等
    const fake: SandboxLease = { id: "00000000-0000-4000-8000-000000000000", generation: 1, expiresAt: "" };
    await expect(pool.execute(fake, "1 + 1")).rejects.toThrow(/stale lease/i);

    const m = pool.status().metrics;
    expect(m.acquireSuccess).toBe(1);
    expect(m.releaseActive).toBe(1);
    expect(m.releaseIdempotent).toBe(1);
    expect(m.leaseRejections).toBeGreaterThanOrEqual(1);
    await pool.dispose();
  });

  it("metrics（S1-1）：池满排队拒绝 + TTL dispose 计数", async () => {
    let now = 100;
    const pool = new KernelPool({
      lang: "python",
      max: 1,
      acquireTimeoutMs: 30,
      entryTtlMsMs: 50,
      clock: () => now,
    });
    const lease = await pool.acquire();
    await expect(pool.acquire()).rejects.toThrow(/pool exhausted/);
    now = 200;
    pool.sweepForTest();

    const m = pool.status().metrics;
    expect(m.acquireSuccess).toBe(1);
    expect(m.acquireQueueRejected).toBe(1);
    expect(m.ttlDisposals).toBe(1);
    await expect(pool.execute(lease, "1 + 1")).rejects.toThrow(/stale lease/i);
    expect(pool.status().metrics.leaseRejections).toBeGreaterThanOrEqual(1);
    await pool.dispose();
  });

  it("容量内新建、满则排队（FIFO）", async () => {
    const pool = new KernelPool({ lang: "bash", max: 1 });
    const lease1 = await pool.acquire();
    const wait = pool.acquire(); // 满 → 排队
    let resolved = false;
    wait.then(() => (resolved = true));
    await new Promise((r) => setTimeout(r, 50));
    expect(resolved).toBe(false);
    pool.release(lease1);
    const lease2 = await wait;
    expect(lease2.id).toBeTruthy();
    await pool.dispose();
  });

  it("reset：ns 清命名空间（变量不延续）", async () => {
    const pool = new KernelPool({ lang: "python", max: 1 });
    const lease = await pool.acquire();
    await pool.execute(lease, "secret_var = 123");
    await pool.reset(lease);
    const r = await pool.execute(lease, "_result = 'secret_var' in dir()");
    expect(r.value).toBe(false);
    await pool.dispose();
  });

  it("status：inFlight/idle/容量报告", async () => {
    const pool = new KernelPool({ lang: "python", max: 3 });
    await pool.acquire();
    const s = pool.status();
    expect(s.inFlight).toBe(1);
    expect(s.idle).toBe(0);
    expect(s.capacity).toBe(3);
    await pool.dispose();
  });

  it("snapshot：聚合 kernel 状态（变量枚举）", async () => {
    const pool = new KernelPool({ lang: "python", max: 1 });
    const lease = await pool.acquire();
    await pool.execute(lease, "fib = 75025");
    const snap = await pool.snapshot(lease);
    expect(snap.variables.some((v) => v.key === "fib" && v.value === 75025)).toBe(true);
    await pool.dispose();
  });

  it("P0-4：release 后旧 lease 执行/重置/再次 release 全部拒绝", async () => {
    const pool = new KernelPool({ lang: "python", max: 1 });
    const lease1 = await pool.acquire();
    pool.release(lease1);
    const lease2 = await pool.acquire();
    await expect(pool.execute(lease1, "1+1")).rejects.toThrow(/stale lease/i);
    await expect(pool.reset(lease1)).rejects.toThrow(/stale lease/i);
    await expect(() => pool.release({ ...lease1, generation: lease1.generation + 1 })).toThrow(/stale lease/i);
    await pool.execute(lease2, "_result = 1");
    await pool.dispose();
  });

  it("P0-4：TTL 过期 → 先销毁移出池，旧 lease 失效且不被复用", async () => {
    let now = 0;
    const pool = new KernelPool({ lang: "python", max: 1, entryTtlMsMs: 100, clock: () => now });
    const lease1 = await pool.acquire();
    expect(pool.status().size).toBe(1);
    now = 200;
    pool.sweepForTest();
    expect(pool.status().size).toBe(0); // 条目已销毁，不是 idle
    await expect(pool.execute(lease1, "_result = 1")).rejects.toThrow(/stale lease/i);
    const lease2 = await pool.acquire();
    expect(lease2.id).not.toBe(lease1.id);
    await pool.dispose();
  });

  it("未知 lease → 拒绝", async () => {
    const pool = new KernelPool({ lang: "python", max: 1 });
    const fake: SandboxLease = { id: "00000000-0000-4000-8000-000000000000", generation: 1, expiresAt: "" };
    await expect(pool.execute(fake, "1+1")).rejects.toThrow(/stale lease/i);
    await pool.dispose();
  });
});

describe("kernel host 协议（buildKernelHostApp，lease）", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.SANDBOX_SHARED_SECRET = SECRET;
    app = buildKernelHostApp({ grantVerifier: createSandboxGrantVerifier({ secret: GRANT_SECRET }) });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.SANDBOX_SHARED_SECRET;
  });

  it("认证：无 grant/篡改签名拒绝，合法 grant 通过（共享密钥不再参与 acquire）", async () => {
    const noGrant = await app.inject({ method: "POST", url: "/kernel/acquire", payload: { lang: "python" } });
    expect(noGrant.statusCode).toBe(401);
    const tampered = { ...makeGrant(), capabilities: ["memory.write"] };
    const badSig = await app.inject({ method: "POST", url: "/kernel/acquire", payload: { lang: "python", grant: tampered } });
    expect(badSig.statusCode).toBe(401);
    expect(badSig.json().error).toContain("signature");
    const ok = await app.inject({ method: "POST", url: "/kernel/acquire", payload: { lang: "python", grant: makeGrant() } });
    expect(ok.statusCode).toBe(200);
  });


  it("grant 动态绑定：execute 任务不匹配拒绝（403）", async () => {
    const acq = await app.inject({ method: "POST", url: "/kernel/acquire", payload: { lang: "python", grant: makeGrant() }, headers: auth() });
    const { lease } = acq.json() as { lease: SandboxLease };
    const bad = await app.inject({
      method: "POST", url: "/kernel/execute",
      payload: { lease, code: "1+1", taskId: "other-task", tenantId: "tenant-a" }, headers: auth(),
    });
    expect(bad.statusCode).toBe(403);
    expect(bad.json().error).toContain("task binding mismatch");
    const ok = await app.inject({
      method: "POST", url: "/kernel/execute",
      payload: { lease, code: "_result = 6 * 7", taskId: "task-host", tenantId: "tenant-a" }, headers: auth(),
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().value).toBe(42);
  });

  it("acquire/execute/reset/release 全链路（python，lease）", async () => {
    const acq = await app.inject({ method: "POST", url: "/kernel/acquire", payload: { lang: "python", grant: makeGrant() }, headers: auth() });
    expect(acq.statusCode).toBe(200);
    const { lease } = acq.json() as { lease: SandboxLease };
    expect(lease.id).toBeTruthy();

    const ex = await app.inject({ method: "POST", url: "/kernel/execute", payload: { lease, code: "total = 5050\n_result = total" }, headers: auth() });
    expect(ex.statusCode).toBe(200);
    expect(ex.json().ok).toBe(true);
    expect(ex.json().value).toBe(5050);

    // kernelId 已退役
    const legacy = await app.inject({ method: "POST", url: "/kernel/execute", payload: { kernelId: "py-1", code: "1" }, headers: auth() });
    expect(legacy.statusCode).toBe(400);
    expect(legacy.json().error).toContain("kernelId retired");

    // 敏感约束：execute 带 env 字段 → 400
    const envReq = await app.inject({ method: "POST", url: "/kernel/execute", payload: { lease, code: "1", env: { API_KEY: "x" } }, headers: auth() });
    expect(envReq.statusCode).toBe(400);

    const reset = await app.inject({ method: "POST", url: "/kernel/reset", payload: { lease }, headers: auth() });
    expect(reset.statusCode).toBe(200);
    const rel = await app.inject({ method: "POST", url: "/kernel/release", payload: { lease }, headers: auth() });
    expect(rel.statusCode).toBe(200);
    // release 后旧 lease 执行被拒
    const after = await app.inject({ method: "POST", url: "/kernel/execute", payload: { lease, code: "1" }, headers: auth() });
    expect(after.statusCode).toBe(400);
    expect(after.json().error).toContain("stale lease");
  });

  it("snapshot 端点返回三字段结构", async () => {
    const acq = await app.inject({ method: "POST", url: "/kernel/acquire", payload: { lang: "python", grant: makeGrant() }, headers: auth() });
    const { lease } = acq.json() as { lease: SandboxLease };
    await app.inject({ method: "POST", url: "/kernel/execute", payload: { lease, code: "marker = 1" }, headers: auth() });
    const snap = await app.inject({ method: "POST", url: "/kernel/snapshot", payload: { lease }, headers: auth() });
    expect(snap.statusCode).toBe(200);
    const body = snap.json();
    expect(body).toHaveProperty("variables");
    expect(body).toHaveProperty("functions");
    expect(body).toHaveProperty("oversized");
    await app.inject({ method: "POST", url: "/kernel/release", payload: { lease }, headers: auth() });
  });

  it("status 端点报告池状态（不含 kernel ID）", async () => {
    const st = await app.inject({ method: "GET", url: "/kernel/status", headers: auth() });
    expect(st.statusCode).toBe(200);
    const body = st.json() as { pools: Array<Record<string, unknown>>; degraded: boolean; reasons: string[] };
    const pools = body.pools;
    expect(pools).toBeInstanceOf(Array);
    // S1-5：健康时 degraded=false + reasons=[]
    expect(body.degraded).toBe(false);
    expect(body.reasons).toEqual([]);
    for (const p of pools) {
      expect(p).not.toHaveProperty("kernelIds");
      expect(p).not.toHaveProperty("ids");
      // S1-1：池容量/回收/TTL 观测进 /kernel/status
      expect(p.metrics).toMatchObject({
        acquireSuccess: expect.any(Number),
        acquireQueueRejected: expect.any(Number),
        ttlDisposals: expect.any(Number),
        leaseRejections: expect.any(Number),
        releaseActive: expect.any(Number),
        releaseIdempotent: expect.any(Number),
      });
    }
  });

  it("S1-4：kernelHostHandle.dispose 释放全部池条目（幂等，后续 acquire 用新条目）", async () => {
    const local = buildKernelHostApp({ grantVerifier: createSandboxGrantVerifier({ secret: GRANT_SECRET }) });
    await local.ready();
    const handle = (local as unknown as { kernelHostHandle: { dispose(): Promise<void>; status(): { pools: Array<{ size: number }>; debugSessions: number } } }).kernelHostHandle;
    const acq = await local.inject({ method: "POST", url: "/kernel/acquire", payload: { lang: "python", grant: makeGrant() }, headers: auth() });
    expect(acq.statusCode).toBe(200);
    const { lease } = acq.json() as { lease: SandboxLease };
    expect(handle.status().pools.some((p) => p.size > 0)).toBe(true);
    await handle.dispose();
    await handle.dispose();   // 幂等
    expect(handle.status().pools.every((p) => p.size === 0)).toBe(true);
    const stale = await local.inject({ method: "POST", url: "/kernel/execute", payload: { lease, code: "1 + 1" }, headers: auth() });
    expect(stale.statusCode).toBe(400);
    await local.close();
  });

  it("非法 lang → 400", async () => {
    const r = await app.inject({ method: "POST", url: "/kernel/acquire", payload: { lang: "ruby", grant: makeGrant() }, headers: auth() });
    expect(r.statusCode).toBe(400);
  });
});

describe("sandbox main 组合形态（exec + kernel 同端口共存）", () => {
  it("同一 app 挂 /exec 与 /kernel/* 路由", async () => {
    process.env.SANDBOX_SHARED_SECRET = SECRET;
    const { buildExecApp } = await import("@away_from/pth-sandbox");
    const { registerKernelHost } = await import("@away_from/pth-sandbox");
    const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-combo-"));
    const app = buildExecApp({ workspacesRoot: wsRoot });
    registerKernelHost(app, { grantVerifier: createSandboxGrantVerifier({ secret: GRANT_SECRET }) });
    await app.ready();

    const exec = await app.inject({ method: "POST", url: "/exec", payload: { cmd: "echo combo-ok" }, headers: auth() });
    expect(exec.statusCode).toBe(200);
    expect(exec.json().stdout).toContain("combo-ok");

    const acq = await app.inject({ method: "POST", url: "/kernel/acquire", payload: { lang: "python", grant: makeGrant() }, headers: auth() });
    expect(acq.statusCode).toBe(200);
    const { lease } = acq.json() as { lease: SandboxLease };
    const ex = await app.inject({ method: "POST", url: "/kernel/execute", payload: { lease, code: "combo = 'kernel-ok'\n_result = combo" }, headers: auth() });
    expect(ex.statusCode).toBe(200);
    expect(ex.json().value).toBe("kernel-ok");
    await app.close();
    delete process.env.SANDBOX_SHARED_SECRET;
  });
});

describe("kernel-pool 兜底（acquire 排队超时 + 条目 TTL 回收）", () => {
  it("池满 acquire 排队 → 超时拒绝（不无限卡）", async () => {
    const pool = new KernelPool({ lang: "python", max: 1, acquireTimeoutMs: 100, entryTtlMsMs: 0 });
    await pool.acquire();  // 占满
    await expect(pool.acquire()).rejects.toThrow(/pool exhausted/);
  });

  it("release 唤醒排队者（清 timer）", async () => {
    const pool = new KernelPool({ lang: "python", max: 1, acquireTimeoutMs: 5000, entryTtlMsMs: 0 });
    const lease1 = await pool.acquire();
    const p2 = pool.acquire();
    pool.release(lease1);
    await expect(p2).resolves.toBeTruthy();
  });

  it("条目 TTL：active 超时强制回收（崩溃泄漏兜底，不标 idle）", async () => {
    let now = 0;
    const pool = new KernelPool({ lang: "python", max: 2, acquireTimeoutMs: 5000, entryTtlMsMs: 100, clock: () => now });
    const lease1 = await pool.acquire();  // entry1 active
    expect(pool.status().inFlight).toBe(1);
    now = 200;
    pool.sweepForTest();
    expect(pool.status().inFlight).toBe(0);
    const lease2 = await pool.acquire();
    expect(lease2.id).not.toBe(lease1.id);
    await pool.dispose();
  });
});

describe("sandbox 侧 degraded 观测（S1-5）", () => {
  type Handle = { dispose(): Promise<void>; status(): { pools: Array<{ size: number }>; debugSessions: number; health: { degraded: boolean; reasons: string[] } } };

  it("共享密钥缺失 → degraded，恢复后清除", async () => {
    let secret: string | undefined;
    const app = buildKernelHostApp({
      getSecret: () => secret,
      getBridgeToken: () => undefined,
      grantVerifier: createSandboxGrantVerifier({ secret: GRANT_SECRET }),
    });
    await app.ready();
    const handle = (app as unknown as { kernelHostHandle: Handle }).kernelHostHandle;
    // P2-2 后 acquire/execute 只走 lease/grant——用仍持共享密钥认证的 /kernel/status 触发缺失条件
    const fail = await app.inject({ method: "GET", url: "/kernel/status", headers: auth() });
    expect(fail.statusCode).toBe(503);
    expect(handle.status().health.degraded).toBe(true);
    expect(handle.status().health.reasons).toContain("shared-secret-missing");

    secret = SECRET;
    const ok = await app.inject({ method: "GET", url: "/kernel/status", headers: auth() });
    expect(ok.statusCode).toBe(200);
    expect(handle.status().health.degraded).toBe(false);
    await app.close();
  });

  it("bridge token 缺失 → degraded + reasons 进 /kernel/status", async () => {
    process.env.SANDBOX_SHARED_SECRET = SECRET;
    const app = buildKernelHostApp({
      getSecret: () => SECRET,
      getBridgeToken: () => undefined,
      grantVerifier: createSandboxGrantVerifier({ secret: GRANT_SECRET }),
    });
    await app.ready();
    try {
      const res = await app.inject({ method: "POST", url: "/kernel/memory-bridge", payload: { op: "get", id: "x" }, headers: auth() });
      expect(res.statusCode).toBe(503);
      const st = await app.inject({ method: "GET", url: "/kernel/status", headers: auth() });
      expect(st.json().degraded).toBe(true);
      expect(st.json().reasons).toContain("bridge-token-missing");
    } finally {
      await app.close();
      delete process.env.SANDBOX_SHARED_SECRET;
    }
  });

  it("池满 acquire 拒绝 → pool-exhausted reason，成功后再清除", async () => {
    const prev = process.env.PTH_KERNEL_ACQUIRE_TIMEOUT_MS;
    process.env.SANDBOX_SHARED_SECRET = SECRET;
    process.env.PTH_KERNEL_ACQUIRE_TIMEOUT_MS = "100";
    const app = buildKernelHostApp({
      poolSize: 1,
      getSecret: () => SECRET,
      getBridgeToken: () => undefined,
      grantVerifier: createSandboxGrantVerifier({ secret: GRANT_SECRET }),
    });
    await app.ready();
    const handle = (app as unknown as { kernelHostHandle: Handle }).kernelHostHandle;
    try {
      const first = await app.inject({ method: "POST", url: "/kernel/acquire", payload: { lang: "python", grant: makeGrant() }, headers: auth() });
      expect(first.statusCode).toBe(200);
      const second = await app.inject({ method: "POST", url: "/kernel/acquire", payload: { lang: "python", grant: makeGrant() }, headers: auth() });
      expect(second.statusCode).toBe(503);
      expect(handle.status().health.reasons).toContain("pool-exhausted-python");

      const { lease } = first.json() as { lease: SandboxLease };
      await app.inject({ method: "POST", url: "/kernel/release", payload: { lease }, headers: auth() });
      const third = await app.inject({ method: "POST", url: "/kernel/acquire", payload: { lang: "python", grant: makeGrant() }, headers: auth() });
      expect(third.statusCode).toBe(200);
      expect(handle.status().health.degraded).toBe(false);
    } finally {
      await app.close();
      delete process.env.SANDBOX_SHARED_SECRET;
      if (prev === undefined) delete process.env.PTH_KERNEL_ACQUIRE_TIMEOUT_MS;
      else process.env.PTH_KERNEL_ACQUIRE_TIMEOUT_MS = prev;
    }
  });

  it("编译并发饱和 → compiled-concurrency-saturated reason", async () => {
    const prev = process.env.PTH_COMPILED_CONCURRENCY;
    process.env.SANDBOX_SHARED_SECRET = SECRET;
    process.env.PTH_COMPILED_CONCURRENCY = "0";
    const app = buildKernelHostApp({
      getSecret: () => SECRET,
      getBridgeToken: () => undefined,
      grantVerifier: createSandboxGrantVerifier({ secret: GRANT_SECRET }),
    });
    await app.ready();
    try {
      const res = await app.inject({ method: "POST", url: "/kernel/compiled", payload: { code: "int main(void){return 0;}" }, headers: auth() });
      expect(res.statusCode).toBe(503);
      const st = await app.inject({ method: "GET", url: "/kernel/status", headers: auth() });
      expect(st.json().reasons).toContain("compiled-concurrency-saturated");
    } finally {
      await app.close();
      delete process.env.SANDBOX_SHARED_SECRET;
      if (prev === undefined) delete process.env.PTH_COMPILED_CONCURRENCY;
      else process.env.PTH_COMPILED_CONCURRENCY = prev;
    }
  });
});
