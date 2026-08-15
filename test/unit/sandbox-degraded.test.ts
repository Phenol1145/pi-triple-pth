import { describe, it, expect, vi, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import Fastify from "fastify";
import {
  SandboxHealthMonitor,
  SandboxExecClient,
  SandboxForwardError,
  SANDBOX_ERROR_UNAVAILABLE,
  SANDBOX_ERROR_TIMEOUT,
} from "@away_from/pth-sandbox";
import { registerSelfRoutes } from "../../src/pth/gateway/routes-self.js";

/**
 * F/WP3 Task 13 — sandbox 失效降级：
 *  - 连续 N 次转发失败（sandbox-unavailable）→ degraded；N-1 次不降级（阈值边界）
 *  - 成功 / 定期探活（/health）→ 自动清除 degraded
 *  - sandbox-timeout 不计入降级（sandbox 可达但慢——探活以 /health 为准）
 *  - /health 联动：degraded → 503 unhealthy + sandbox 子状态；恢复 → 200 ok
 *  - 进入/退出审计回调（main.ts 接线审计事件）
 */

const SECRET = "degraded-test-secret";

// ── 可切换 mock sandbox（fail/ok 双态）──────────────────────────────
interface ToggleSandbox {
  baseUrl: string;
  failExec: (failing: boolean) => void;
  healthy: (ok: boolean) => void;
  /** 响应延迟 ms（模拟慢 sandbox → 客户端超时） */
  setDelayMs: (ms: number) => void;
  close: () => Promise<void>;
}

async function startToggleSandbox(): Promise<ToggleSandbox> {
  let execFailing = false;
  let healthOk = true;
  let delayMs = 0;
  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(healthOk ? 200 : 503, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: healthOk ? "ok" : "degraded" }));
      return;
    }
    // POST /exec
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      const auth = req.headers.authorization ?? "";
      const okAuth = auth === `Bearer ${SECRET}`;
      if (!okAuth) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      if (execFailing) {
        // 模拟 sandbox 挂掉：连接后立即断开（客户端视为转发失败）
        res.destroy();
        return;
      }
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ stdout: `echo:${body.cmd}`, stderr: "", exitCode: 0, timedOut: false }));
      }, delayMs);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    failExec: (f) => { execFailing = f; },
    healthy: (ok) => { healthOk = ok; },
    setDelayMs: (ms) => { delayMs = ms; },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function closedPortUrl(): Promise<string> {
  const probe = http.createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const addr = probe.address() as AddressInfo;
  await new Promise<void>((r) => probe.close(() => r()));
  return `http://127.0.0.1:${addr.port}`;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("SandboxHealthMonitor 阈值边界（F/WP3 Task 13）", () => {
  it("连续 N-1 次失败不降级，第 N 次（默认 3）降级", () => {
    const changes: boolean[] = [];
    const mon = new SandboxHealthMonitor({ onStateChange: (d) => changes.push(d) });
    mon.recordFailure();
    mon.recordFailure();
    expect(mon.isDegraded()).toBe(false);
    expect(mon.getConsecutiveFailures()).toBe(2);
    mon.recordFailure();
    expect(mon.isDegraded()).toBe(true);
    expect(changes).toEqual([true]);
    mon.dispose();
  });

  it("阈值可配置（failureThreshold=1 → 首次失败即降级；=2 边界）", () => {
    const m1 = new SandboxHealthMonitor({ failureThreshold: 1 });
    m1.recordFailure();
    expect(m1.isDegraded()).toBe(true);
    m1.dispose();

    const m2 = new SandboxHealthMonitor({ failureThreshold: 2 });
    m2.recordFailure();
    expect(m2.isDegraded()).toBe(false);
    m2.recordFailure();
    expect(m2.isDegraded()).toBe(true);
    m2.dispose();
  });

  it("中途成功清零计数 → 不降级（阈值内的失败可被成功抵消）", () => {
    const mon = new SandboxHealthMonitor();
    mon.recordFailure();
    mon.recordFailure();
    mon.recordSuccess();
    expect(mon.getConsecutiveFailures()).toBe(0);
    expect(mon.isDegraded()).toBe(false);
    // 再累积到阈值（成功已清零）→ 仍需 N 次
    mon.recordFailure();
    mon.recordFailure();
    expect(mon.isDegraded()).toBe(false);
    mon.dispose();
  });
});

describe("SandboxExecClient ↔ 监控联动（F/WP3 Task 13）", () => {
  it("sandbox 挂掉（连接拒绝）→ 连续失败计数 → 达阈值 degraded", async () => {
    const url = await closedPortUrl();
    const mon = new SandboxHealthMonitor({ failureThreshold: 3, baseUrl: url });
    const client = new SandboxExecClient({ baseUrl: url, secret: SECRET, monitor: mon });
    try {
      for (let i = 0; i < 2; i++) {
        await expect(client.exec({ cmd: "ls" })).rejects.toBeInstanceOf(SandboxForwardError);
      }
      expect(mon.isDegraded()).toBe(false);
      await expect(client.exec({ cmd: "ls" })).rejects.toMatchObject({ code: SANDBOX_ERROR_UNAVAILABLE });
      expect(mon.isDegraded()).toBe(true);
      expect(mon.getConsecutiveFailures()).toBe(3);
    } finally {
      mon.dispose();
    }
  });

  it("HTTP 非 2xx（认证/配置错）也计入失败 → 降级", async () => {
    const sb = await startToggleSandbox();
    const mon = new SandboxHealthMonitor({ failureThreshold: 2, baseUrl: sb.baseUrl });
    try {
      const client = new SandboxExecClient({ baseUrl: sb.baseUrl, secret: "wrong-secret", monitor: mon });
      await client.exec({ cmd: "ls" }).catch(() => {});
      await client.exec({ cmd: "ls" }).catch(() => {});
      expect(mon.isDegraded()).toBe(true);
    } finally {
      sb.close();
      mon.dispose();
    }
  });

  it("sandbox-timeout（慢响应）不计入降级——转发超时后仍 non-degraded", async () => {
    const sb = await startToggleSandbox();
    const mon = new SandboxHealthMonitor({ failureThreshold: 2, baseUrl: sb.baseUrl });
    try {
      // 慢响应：handler 延迟超过客户端超时 → sandbox-timeout
      const slow = await startToggleSandbox();
      slow.setDelayMs(500);
      const err = await new SandboxExecClient({ baseUrl: slow.baseUrl, secret: SECRET, monitor: mon, timeoutMs: 30 })
        .exec({ cmd: "sleep" }).catch((e) => e);
      expect(err).toBeInstanceOf(SandboxForwardError);
      expect(err.code).toBe(SANDBOX_ERROR_TIMEOUT);
      expect(mon.isDegraded()).toBe(false);
      expect(mon.getConsecutiveFailures()).toBe(0);
      await slow.close();
    } finally {
      await sb.close();
      mon.dispose();
    }
  });

  it("degraded 后转发成功 → 自动清除 + 审计回调（true→false）", async () => {
    const sb = await startToggleSandbox();
    const changes: Array<{ degraded: boolean; failures: number }> = [];
    const mon = new SandboxHealthMonitor({
      failureThreshold: 2, baseUrl: sb.baseUrl,
      onStateChange: (d, n) => changes.push({ degraded: d, failures: n }),
    });
    try {
      const client = new SandboxExecClient({ baseUrl: sb.baseUrl, secret: SECRET, monitor: mon });
      sb.failExec(true);
      await client.exec({ cmd: "ls" }).catch(() => {});
      await client.exec({ cmd: "ls" }).catch(() => {});
      expect(mon.isDegraded()).toBe(true);
      sb.failExec(false);
      const result = await client.exec({ cmd: "ls" });
      expect(result.exitCode).toBe(0);
      expect(mon.isDegraded()).toBe(false);
      expect(mon.getConsecutiveFailures()).toBe(0);
      expect(changes).toEqual([{ degraded: true, failures: 2 }, { degraded: false, failures: 0 }]);
    } finally {
      await sb.close();
      mon.dispose();
    }
  });
});

describe("SandboxHealthMonitor 自动恢复探活（F/WP3 Task 13）", () => {
  it("degraded 后注入 probe 通过 → probeNow 清除", async () => {
    let healthy = false;
    const changes: boolean[] = [];
    const mon = new SandboxHealthMonitor({ probe: async () => healthy, onStateChange: (d) => changes.push(d) });
    for (let i = 0; i < 3; i++) mon.recordFailure();
    expect(mon.isDegraded()).toBe(true);
    expect(await mon.probeNow()).toBe(false); // 仍不健康
    expect(mon.isDegraded()).toBe(true);
    healthy = true;
    expect(await mon.probeNow()).toBe(true);
    expect(mon.isDegraded()).toBe(false);
    expect(changes).toEqual([true, false]);
    mon.dispose();
  });

  it("degraded 后定时探活自动恢复（probeIntervalMs 到期；fake timers；定时器 unref）", async () => {
    vi.useFakeTimers();
    let healthy = false;
    const probe = vi.fn(async () => healthy);
    const changes: boolean[] = [];
    const mon = new SandboxHealthMonitor({ probeIntervalMs: 1000, probe, onStateChange: (d) => changes.push(d) });
    try {
      for (let i = 0; i < 3; i++) mon.recordFailure();
      expect(mon.isDegraded()).toBe(true);
      expect(probe).not.toHaveBeenCalled(); // 定时器未到期
      healthy = true;
      await vi.advanceTimersByTimeAsync(1000);
      expect(probe).toHaveBeenCalledTimes(1);
      expect(mon.isDegraded()).toBe(false);
      expect(changes).toEqual([true, false]);
    } finally {
      mon.dispose();
    }
  });

  it("默认探活走 <baseUrl>/health；sandbox health 恢复 → probeNow true", async () => {
    const sb = await startToggleSandbox();
    const mon = new SandboxHealthMonitor({ baseUrl: sb.baseUrl });
    try {
      sb.healthy(false);
      expect(await mon.probeNow()).toBe(false);
      sb.healthy(true);
      expect(await mon.probeNow()).toBe(true);
    } finally {
      await sb.close();
      mon.dispose();
    }
  });
});

describe("/health 联动（F/WP3 Task 13）", () => {
  async function buildApp(mon?: SandboxHealthMonitor) {
    const app = Fastify();
    const fakeToolPlatform = { getAllowedTools: () => [] };
    registerSelfRoutes(app, fakeToolPlatform as any, "test", mon);
    await app.ready();
    return app;
  }

  it("未接线监控 → 原响应形状（status:ok + uptime）", async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("ok");
      expect(res.json().uptime).toBeTypeOf("number");
      expect(res.json().sandbox).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("接线监控 + healthy → 200 ok + sandbox 子状态", async () => {
    const mon = new SandboxHealthMonitor();
    const app = await buildApp(mon);
    try {
      const res = await app.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe("ok");
      expect(body.sandbox).toEqual({ status: "ok", consecutiveFailures: 0, threshold: 3 });
    } finally {
      await app.close();
      mon.dispose();
    }
  });

  it("degraded → 503 unhealthy + sandbox 子状态（含连续失败数/阈值）", async () => {
    const mon = new SandboxHealthMonitor({ failureThreshold: 2 });
    const app = await buildApp(mon);
    try {
      mon.recordFailure();
      mon.recordFailure();
      expect(mon.isDegraded()).toBe(true);
      const res = await app.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(503);
      const body = res.json();
      expect(body.status).toBe("degraded");
      expect(body.sandbox).toEqual({ status: "degraded", consecutiveFailures: 2, threshold: 2 });
    } finally {
      await app.close();
      mon.dispose();
    }
  });

  it("degraded → 恢复（recordSuccess）→ /health 200 ok", async () => {
    const mon = new SandboxHealthMonitor({ failureThreshold: 1 });
    const app = await buildApp(mon);
    try {
      mon.recordFailure();
      expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(503);
      mon.recordSuccess();
      expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    } finally {
      await app.close();
      mon.dispose();
    }
  });
});
