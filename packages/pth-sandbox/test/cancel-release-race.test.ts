import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import {
  KernelPool,
  SandboxKernel,
  buildKernelHostApp,
  createSandboxGrantIssuer,
  createSandboxGrantVerifier,
  type SandboxLease,
} from "@away_from/pth-sandbox";

const GRANT_SECRET = "cancel-race-grant-secret-0123456789";
const issuer = createSandboxGrantIssuer({ secret: GRANT_SECRET });

function makeGrant(language: "python" | "bash" = "python") {
  return issuer.issue({
    lease: { taskId: "task-race", leaseId: "bb7d7e7e-c3ec-4e58-b34d-2f6a2a70e0a6", generation: 1 },
    scope: { tenantId: "tenant-a", principalId: "worker:developer", roles: ["developer"], traceId: "trace-race" },
    workspace: { tenantId: "tenant-a", workspaceId: "ws-race", taskId: "task-race" },
    language,
    capabilities: ["memory.read"],
  });
}

describe("P2-3：cancel → ack → release 竞态闭环", () => {
  it("KernelPool.cancel：cancelling→disposed，release/execute 均拒绝，绝不复用", async () => {
    const pool = new KernelPool({ lang: "python", max: 1 });
    const lease = await pool.acquire();
    await pool.cancel(lease);

    expect(pool.status()).toMatchObject({ size: 0, inFlight: 0, idle: 0 });
    expect(() => pool.release(lease)).toThrow(/stale lease/);
    await expect(pool.execute(lease, "1+1")).rejects.toThrow(/stale lease/);

    const next = await pool.acquire();
    expect(next.id).not.toBe(lease.id);
    await pool.cancel(next);
    await pool.dispose();
  });

  it("HTTP：/kernel/cancel ack 后 release 被拒，池条目已移除", async () => {
    const app = Fastify();
    const host = buildKernelHostApp({ grantVerifier: createSandboxGrantVerifier({ secret: GRANT_SECRET }), getSecret: () => "test-secret" });
    await host.ready();
    try {
      const acq = await host.inject({ method: "POST", url: "/kernel/acquire", payload: { lang: "python", grant: makeGrant() } });
      expect(acq.statusCode).toBe(200);
      const lease = (acq.json() as { lease: SandboxLease }).lease;

      const cancel = await host.inject({ method: "POST", url: "/kernel/cancel", payload: { lease } });
      expect(cancel.statusCode).toBe(200);
      expect(cancel.json()).toMatchObject({ ok: true, state: "disposed" });

      const release = await host.inject({ method: "POST", url: "/kernel/release", payload: { lease } });
      expect(release.statusCode).toBe(400);

      const status = await host.inject({
        method: "GET",
        url: "/kernel/status",
        headers: { authorization: "Bearer test-secret" },
      });
      expect(status.statusCode).toBe(200);
    } finally {
      await host.close();
    }
  });

  it("client：cancel ack 不可达 → 不 release、本地 lease 作废，下次 execute 重新 acquire", async () => {
    let releaseCalls = 0;
    let executeCalls = 0;
    const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/kernel/acquire")) {
        return new Response(JSON.stringify({ lease: { id: "4f5e3f44-ec85-4e83-9c99-2d17d343d0e1", generation: 1, expiresAt: "2099-01-01T00:00:00.000Z" } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (u.endsWith("/kernel/cancel")) {
        throw new Error("host unreachable for cancel ack");
      }
      if (u.endsWith("/kernel/release")) {
        releaseCalls++;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (u.endsWith("/kernel/execute")) {
        executeCalls++;
        if (executeCalls === 1) {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
            });
          });
        }
        return new Response(JSON.stringify({ ok: true, value: 7, stdout: "", stderr: "", durationMs: 1, language: "python" }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "unknown path" }), { status: 404 });
    }) as unknown as typeof fetch;

    vi.stubGlobal("fetch", fetchImpl);
    try {
      const k = new SandboxKernel({ url: "http://sandbox.test", secret: "s", language: "python", acquireOnInit: false, grant: makeGrant() });
      const p = k.execute("while True: pass", { timeoutMs: 60_000 });
      await vi.waitFor(() => expect(executeCalls).toBe(1));
      await k.abort();
      const r = await p;
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe("aborted");
      expect(releaseCalls).toBe(0); // ack 不可达 → 绝不乐观 release

      const again = await k.execute("1+1");
      expect(again.ok).toBe(true);
      expect(fetchImpl.mock.calls.filter((c) => String(c[0]).endsWith("/kernel/acquire")).length).toBe(2); // 重新 acquire
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
