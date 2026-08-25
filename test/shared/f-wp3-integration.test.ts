import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { Redis } from "ioredis";
import type { Redis as RedisType } from "ioredis";
import {
  SandboxExecClient,
  SandboxHealthMonitor,
  createSandboxBashDefinition,
  SANDBOX_ERROR_UNAVAILABLE,
} from "@away_from/pth-sandbox";
import { registerSelfRoutes } from "../../src/pth/gateway/routes-self.js";
import { AgentEngine } from "../../src/pth/core/agent-engine.js";
import { SessionPool } from "../../src/pth/core/session-pool.js";
import { WorkspaceManager, detectPlatform } from "@away_from/infra";

/**
 * F/WP3 Task 15 — WP3 集成验证：代码执行全沙箱化闭环（Task 10-14 端到端）。
 *
 * 场景：
 *  1. bash 调用全沙箱化——pth 会话内 bash 工具调用 → 请求发往 sandbox（mock sandbox 捕获
 *     cmd/cwd/共享密钥头）→ 结果回传模型侧（tool_result 内容为 sandbox 返回）
 *  2. sandbox 不可达降级——mock sandbox 关闭/拒绝 → 连续 N 次 → degraded（/health 联动 503）→
 *     sandbox 恢复 → 自动清除（/health 200）
 *  3. 密钥隔离——转发 payload 白名单 {cmd, cwd, timeout}，不含 pth 进程 env（无 LLM 密钥泄漏）
 *  4. 统一接口名——模型侧可见工具名 = bash（customTools 含同名 bash，无第二套接口名）
 *
 * mock 策略（沿袭 sandbox-bash-forward / f-wp2-integration）：本地 http server 模拟 sandbox
 * （/exec + /health，可切换 fail/ok）；保留真实 SessionManager + 真实 Redis（同 f-wp2 惯例）；
 * mock createAgentSession 在 prompt 时模拟 SDK 工具循环——调用 customTools 中的 bash 工具并
 * 把返回值作为模型侧 tool_result 文本。
 */

// ── mock sandbox 服务（可切换 fail/ok 双态 + 请求捕获）────────────────
interface SandboxRequest {
  method: string;
  url: string;
  authorization: string | undefined;
  body: any;
}
interface MockSandbox {
  baseUrl: string;
  requests: SandboxRequest[];
  failExec: (failing: boolean) => void;
  healthy: (ok: boolean) => void;
  close: () => Promise<void>;
}

async function startMockSandbox(secret: string): Promise<MockSandbox> {
  let execFailing = false;
  let healthOk = true;
  const requests: SandboxRequest[] = [];
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
      requests.push({ method: req.method ?? "", url: req.url ?? "", authorization: req.headers.authorization, body });
      if (req.headers.authorization !== `Bearer ${secret}`) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      if (execFailing) {
        res.destroy(); // 模拟 sandbox 挂掉：连接后立即断开（客户端视为转发失败）
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ stdout: `out:${body.cmd}`, stderr: "", exitCode: 0, timedOut: false }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    requests,
    failExec: (f) => { execFailing = f; },
    healthy: (ok) => { healthOk = ok; },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * 确定性"关闭/拒绝"sandbox：/exec 一律断开连接、/health 一律 503。
 * 说明：closedPortUrl（释放临时端口）模式存在跨 worker 端口复用竞态（全量并行下其他
 * 测试进程 listen(0) 可能拿到刚释放的端口）；ECONNREFUSED 路径已由 sandbox-bash-forward/
 * sandbox-degraded 单测覆盖。集成层用连接断开服务替代——客户端路径等价（fetch 抛错 →
 * recordFailure → sandbox-unavailable → degraded），且不占端口回收窗口。
 */
async function startDeadSandbox(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "degraded" }));
      return;
    }
    req.on("data", () => {});
    req.on("end", () => res.destroy()); // 模拟 sandbox 关闭：连接断开（客户端视为转发失败）
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ── SDK mock（engine 接线 + 模拟 SDK 工具循环）────────────────────────
const sdkMocks = vi.hoisted(() => ({
  createdOptions: [] as any[],
  /** 模拟 SDK 侧模型可见的 tool_result 文本（每次 bash 调用一条） */
  toolResults: [] as string[],
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...mod,
    createAgentSession: vi.fn(async (options: any) => {
      sdkMocks.createdOptions.push(options);
      const sm = options.sessionManager;
      const subscribers: Array<(ev: any) => void> = [];
      const session = {
        prompt: async (text: string) => {
          // 模拟 SDK：user 消息入会话
          sm.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
          // 模拟 SDK 工具循环：模型请求调用 custom bash → SDK 调用 custom tool execute
          // （ctx.cwd = 会话 cwd，与真实 SDK 行为一致——转发层无需路径映射）
          const bashDef = (options.customTools ?? []).find((t: any) => t.name === "bash");
          if (bashDef) {
            for (const cb of [...subscribers]) cb({ type: "tool_execution_start", toolName: "bash", toolCallId: "call-1" });
            const result: any = await bashDef.execute("call-1", { command: text }, undefined, undefined, { cwd: options.cwd });
            const toolText = result?.content?.[0]?.text ?? String(result);
            sdkMocks.toolResults.push(toolText);
            for (const cb of [...subscribers]) cb({ type: "tool_execution_end", toolName: "bash", toolCallId: "call-1", isError: false });
            // 模拟 SDK：tool_result 作为 assistant 消息回传模型侧
            sm.appendMessage({ role: "assistant", content: [{ type: "text", text: toolText }], timestamp: Date.now() });
          } else {
            sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: Date.now() });
          }
          for (const cb of [...subscribers]) {
            cb({ type: "message_end", message: { role: "assistant", content: [], timestamp: Date.now(), usage: { input: 1, output: 1 } } });
          }
          for (const cb of [...subscribers]) cb({ type: "agent_end" });
        },
        abort: async () => {},
        subscribe: (cb: (ev: any) => void) => { subscribers.push(cb); return () => {}; },
        dispose: () => {},
      };
      return { session };
    }),
  };
});

// ── helpers ──────────────────────────────────────────────────────────

const SECRET = "wp3-integration-secret";
const ALLOWED_TOOLS = ["read", "edit"];
const SDK_TOOL_DEFS = [{ name: "tenant-custom", type: "function", description: "tenant tool", parameters: { type: "object", properties: {} } }];

function mockDeps() {
  return {
    sessionStore: {
      saveMeta: vi.fn(async () => {}), appendEntry: vi.fn(async () => {}), getMeta: vi.fn(async () => null),
      getEntries: vi.fn(async () => []), saveSnapshot: vi.fn(async () => {}), getLatestSnapshot: vi.fn(async () => null),
      listSessions: vi.fn(async () => []), deleteSession: vi.fn(async () => {}),
      saveVersionSnapshot: vi.fn(async () => {}), getLatestVersionSnapshot: vi.fn(async () => null),
    } as any,
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } as any,
    metrics: {
      promptDuration: { startTimer: () => () => {} },
      sessionsActive: { set: vi.fn(), inc: vi.fn(), dec: vi.fn() },
      tokensTotal: { inc: vi.fn() },
    } as any,
    audit: { write: vi.fn(async () => {}) } as any,
  };
}

function makeWorkspaceMgr(tmp: string): { workspaceMgr: WorkspaceManager; basePath: string } {
  const basePath = path.join(tmp, "workspaces");
  return {
    workspaceMgr: new WorkspaceManager(detectPlatform(), basePath, path.join(tmp, "platform"), path.join(tmp, "tenants")),
    basePath,
  };
}

/** 真实 WorkspaceManager + 真实 SessionPool（Redis 写直通）+ sandbox bash 工具（真实转发客户端） */
function makeEngine(tmp: string, sessionsDir: string, workspaceMgr: WorkspaceManager, redis: RedisType, deps: ReturnType<typeof mockDeps>, sandboxBash: any) {
  const modelRuntime = {};
  const modelRouter = { resolve: () => ({ id: "test-model" }), getRuntime: () => modelRuntime } as any;
  const toolPlatform = {
    getAllowedTools: vi.fn(() => ALLOWED_TOOLS),
    getSdkToolDefinitions: vi.fn(() => SDK_TOOL_DEFS),
    getEffectiveTools: vi.fn(() => ALLOWED_TOOLS),
    recordToolStart: vi.fn(),
    recordToolEnd: vi.fn(),
  } as any;
  const pool = new SessionPool(
    { maxSessions: 20, maxSessionsPerTenant: 5, idleTimeoutMs: 300_000 },
    deps.sessionStore, deps.logger, deps.metrics, redis,
  );
  const engine = new AgentEngine(pool, modelRouter, workspaceMgr, deps.sessionStore, toolPlatform, deps.logger, deps.metrics, sessionsDir, deps.audit, undefined, sandboxBash);
  return { engine, toolPlatform };
}

/** 构造带监控的 sandbox bash 工具（对应 main.ts 接线方式） */
function makeSandboxBash(baseUrl: string, secret: string, monitor?: SandboxHealthMonitor): ReturnType<typeof createSandboxBashDefinition> {
  return createSandboxBashDefinition(new SandboxExecClient({ baseUrl, secret, monitor }));
}

/** 会话内触发一轮 prompt（模拟模型决定调用 bash），返回事件流 */
async function promptTurn(engine: AgentEngine, sid: string, tenant: string, text: string): Promise<any[]> {
  const events: any[] = [];
  for await (const ev of engine.prompt(sid, tenant, text)) events.push(ev);
  expect(events[events.length - 1].type).toBe("agent_end");
  return events;
}

/** 创建 /health 联动 app（对齐 main.ts：registerSelfRoutes 接线 sandboxMonitor） */
async function buildHealthApp(monitor: SandboxHealthMonitor) {
  const app = Fastify();
  registerSelfRoutes(app, { getAllowedTools: () => [] } as any, "test", monitor);
  await app.ready();
  return app;
}

// ── tests ────────────────────────────────────────────────────────────

describe("F/WP3 Task 15 — WP3 集成验证：代码执行全沙箱化闭环", () => {
  let redis: RedisType;
  const writtenKeys: string[] = [];

  beforeAll(() => {
    redis = new Redis({ host: "localhost", port: 6379, maxRetriesPerRequest: 1, lazyConnect: true });
  });

  afterAll(async () => {
    try {
      for (const k of writtenKeys) await redis.del(k);
    } catch { /* best-effort */ }
    redis.disconnect();
  });

  beforeEach(() => {
    sdkMocks.createdOptions.length = 0;
    sdkMocks.toolResults.length = 0;
  });

  it("核心闭环：会话内 bash 调用→sandbox 执行→结果回传模型侧（全沙箱化）", async () => {
    const sandbox = await startMockSandbox(SECRET);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wp3-int-"));
    const sessionsDir = path.join(tmp, "sessions");
    const { workspaceMgr, basePath } = makeWorkspaceMgr(tmp);
    try {
      const deps = mockDeps();
      const sandboxBash = makeSandboxBash(sandbox.baseUrl, SECRET);
      const { engine, toolPlatform } = makeEngine(tmp, sessionsDir, workspaceMgr, redis, deps, sandboxBash);
      const res = await engine.createSession({ tenantId: "tenant-a", project: "proj-1" });
      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error("unreachable");
      const sid = res.data.sessionId;
      writtenKeys.push(`pool:${sid}:meta`);

      // 会话内触发带 bash 调用的 prompt（mock SDK 工具循环走 custom bash 工具）
      await promptTurn(engine, sid, "tenant-a", "echo hello");

      // 断言：请求发往 sandbox（/exec + cmd/cwd + 共享密钥头）
      expect(sandbox.requests).toHaveLength(1);
      const req = sandbox.requests[0];
      expect(req.method).toBe("POST");
      expect(req.url).toBe("/exec");
      expect(req.authorization).toBe(`Bearer ${SECRET}`);
      expect(req.body.cmd).toBe("echo hello");
      // cwd 转发 = pth 工作区 cwd（共享卷路径约定——无需映射，Task 12）
      expect(req.body.cwd).toBe(path.join(basePath, "tenant-a", "proj-1"));

      // 断言：结果回传模型侧（tool_result 内容为 sandbox 返回 stdout）
      expect(sdkMocks.toolResults).toHaveLength(1);
      expect(sdkMocks.toolResults[0]).toContain("out:echo hello");

      // 断言：工具治理在链路上——记录名 = 统一接口名 bash
      expect(toolPlatform.recordToolStart).toHaveBeenCalledWith("tenant-a", "bash", "call-1");
      expect(toolPlatform.recordToolEnd).toHaveBeenCalledWith("tenant-a", "bash", "call-1", expect.any(Number), false);

      await engine.drain();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      await sandbox.close();
    }
  });

  it("密钥隔离：转发 payload 白名单 {cmd,cwd,timeout}，不含 pth 进程 env（无 LLM 密钥泄漏）", async () => {
    const sandbox = await startMockSandbox(SECRET);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wp3-int-"));
    const sessionsDir = path.join(tmp, "sessions");
    const { workspaceMgr } = makeWorkspaceMgr(tmp);
    // 模拟 pth 进程 env 携带 LLM 密钥（用户裁决：sandbox 不持 LLM 密钥）
    const envBackup = { ...process.env };
    process.env.OPENAI_API_KEY = "sk-leak-topsecret-42";
    process.env.ANTHROPIC_API_KEY = "sk-ant-leak-42";
    try {
      const deps = mockDeps();
      const sandboxBash = makeSandboxBash(sandbox.baseUrl, SECRET);
      const { engine } = makeEngine(tmp, sessionsDir, workspaceMgr, redis, deps, sandboxBash);
      const res = await engine.createSession({ tenantId: "tenant-a", project: "proj-1" });
      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error("unreachable");
      const sid = res.data.sessionId;
      writtenKeys.push(`pool:${sid}:meta`);

      await promptTurn(engine, sid, "tenant-a", "echo secret");

      expect(sandbox.requests).toHaveLength(1);
      const req = sandbox.requests[0];
      // 白名单：body 键 ⊆ {cmd, cwd, timeout}（未传 timeout 时 JSON 序列化省略该键——
      // 键集严格等于 {cmd, cwd}，即转发恒为白名单内字段，绝不携带进程 env）
      const bodyKeys = Object.keys(req.body).sort();
      expect(bodyKeys).toEqual(["cmd", "cwd"]);
      expect(Object.keys(req.body).every((k) => ["cmd", "cwd", "timeout"].includes(k))).toBe(true);
      // 密钥零泄漏：请求体/请求头均不含进程 env 中的密钥值
      const payload = JSON.stringify({ body: req.body, headers: req.headers });
      expect(payload).not.toContain("sk-leak-topsecret-42");
      expect(payload).not.toContain("sk-ant-leak-42");
      expect(payload).not.toContain("sk-");
      // 共享密钥头仅包含 sandbox 密钥（Bearer secret），无其他凭据
      expect(req.authorization).toBe(`Bearer ${SECRET}`);

      await engine.drain();
    } finally {
      process.env = envBackup;
      fs.rmSync(tmp, { recursive: true, force: true });
      await sandbox.close();
    }
  });

  it("统一接口名：customTools 含同名 bash（后置覆盖），无第二套接口名", async () => {
    const sandbox = await startMockSandbox(SECRET);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wp3-int-"));
    const sessionsDir = path.join(tmp, "sessions");
    const { workspaceMgr } = makeWorkspaceMgr(tmp);
    try {
      const deps = mockDeps();
      const sandboxBash = makeSandboxBash(sandbox.baseUrl, SECRET);
      const { engine } = makeEngine(tmp, sessionsDir, workspaceMgr, redis, deps, sandboxBash);
      const res = await engine.createSession({ tenantId: "tenant-a", project: "proj-1" });
      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error("unreachable");
      const sid = res.data.sessionId;
      writtenKeys.push(`pool:${sid}:meta`);

      const opts = sdkMocks.createdOptions[0];
      const names = opts.customTools.map((t: any) => t.name);
      // 模型侧可见工具名 = bash（租户自定义工具 + 平台级 sandbox bash 后置覆盖）
      expect(names).toEqual(["tenant-custom", "bash"]);
      // 无第二套接口名（sandbox-bash / bash-sandbox 均不得出现）
      expect(names.filter((n: string) => n.includes("sandbox"))).toEqual([]);
      // 平台级 bash 即 main.ts 接线的 sandbox 工具实例（同名覆盖已生效）
      expect(opts.customTools[1]).toBe(sandboxBash);
      expect(opts.customTools[1].label).toContain("sandbox");
      expect(sandbox.requests).toHaveLength(0); // createSession 不应触发任何 sandbox 调用

      await engine.drain();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      await sandbox.close();
    }
  });

  it("sandbox 关闭/拒绝（连接断开）→ 连续 N 次 → degraded（错误文本回传模型侧）+ /health 503", async () => {
    const dead = await startDeadSandbox();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wp3-int-"));
    const sessionsDir = path.join(tmp, "sessions");
    const { workspaceMgr } = makeWorkspaceMgr(tmp);
    const changes: boolean[] = [];
    const monitor = new SandboxHealthMonitor({
      failureThreshold: 3, baseUrl: dead.baseUrl,
      onStateChange: (d) => changes.push(d),
    });
    try {
      const deps = mockDeps();
      const sandboxBash = makeSandboxBash(dead.baseUrl, SECRET, monitor);
      const { engine } = makeEngine(tmp, sessionsDir, workspaceMgr, redis, deps, sandboxBash);
      const res = await engine.createSession({ tenantId: "tenant-a", project: "proj-1" });
      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error("unreachable");
      const sid = res.data.sessionId;
      writtenKeys.push(`pool:${sid}:meta`);

      // 连续 2 次失败（N-1）：未降级，但错误文本已回传模型侧（不静默）
      for (let i = 0; i < 2; i++) {
        await promptTurn(engine, sid, "tenant-a", `boom-${i}`);
        expect(sdkMocks.toolResults[i]).toContain(SANDBOX_ERROR_UNAVAILABLE);
      }
      expect(monitor.isDegraded()).toBe(false);
      expect(monitor.getConsecutiveFailures()).toBe(2);

      // 第 N 次（3）：degraded + /health 联动 503
      await promptTurn(engine, sid, "tenant-a", "boom-2");
      expect(monitor.isDegraded()).toBe(true);
      expect(changes).toEqual([true]);
      const app = await buildHealthApp(monitor);
      try {
        const resHealth = await app.inject({ method: "GET", url: "/health" });
        expect(resHealth.statusCode).toBe(503);
        expect(resHealth.json().status).toBe("degraded");
        expect(resHealth.json().sandbox).toMatchObject({ status: "degraded", consecutiveFailures: 3, threshold: 3 });
      } finally {
        await app.close();
      }

      await engine.drain();
    } finally {
      monitor.dispose();
      fs.rmSync(tmp, { recursive: true, force: true });
      await dead.close();
    }
  });

  it("sandbox 恢复 → 下次转发成功自动清除 degraded → /health 200", async () => {
    const sandbox = await startMockSandbox(SECRET);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wp3-int-"));
    const sessionsDir = path.join(tmp, "sessions");
    const { workspaceMgr } = makeWorkspaceMgr(tmp);
    const changes: Array<{ degraded: boolean; failures: number }> = [];
    const monitor = new SandboxHealthMonitor({
      failureThreshold: 3, baseUrl: sandbox.baseUrl,
      onStateChange: (d, n) => changes.push({ degraded: d, failures: n }),
    });
    try {
      const deps = mockDeps();
      const sandboxBash = makeSandboxBash(sandbox.baseUrl, SECRET, monitor);
      const { engine } = makeEngine(tmp, sessionsDir, workspaceMgr, redis, deps, sandboxBash);
      const res = await engine.createSession({ tenantId: "tenant-a", project: "proj-1" });
      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error("unreachable");
      const sid = res.data.sessionId;
      writtenKeys.push(`pool:${sid}:meta`);

      // sandbox 拒绝执行（挂掉）→ 3 次 → degraded
      sandbox.failExec(true);
      for (let i = 0; i < 3; i++) {
        await promptTurn(engine, sid, "tenant-a", `boom-${i}`);
      }
      expect(monitor.isDegraded()).toBe(true);
      expect(sdkMocks.toolResults[2]).toContain(SANDBOX_ERROR_UNAVAILABLE);
      const app = await buildHealthApp(monitor);
      try {
        expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(503);

        // sandbox 恢复 → 下次转发成功自动清除 degraded
        sandbox.failExec(false);
        await promptTurn(engine, sid, "tenant-a", "echo recovered");
        expect(monitor.isDegraded()).toBe(false);
        expect(monitor.getConsecutiveFailures()).toBe(0);
        // 恢复后的调用正常回传 sandbox 结果
        expect(sdkMocks.toolResults[3]).toContain("out:echo recovered");
        expect(changes).toEqual([
          { degraded: true, failures: 3 },
          { degraded: false, failures: 0 },
        ]);
        expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
      } finally {
        await app.close();
      }

      await engine.drain();
    } finally {
      monitor.dispose();
      fs.rmSync(tmp, { recursive: true, force: true });
      await sandbox.close();
    }
  });
});
