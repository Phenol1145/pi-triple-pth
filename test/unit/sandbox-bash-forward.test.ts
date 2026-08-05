import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Redis } from "ioredis";
import type { Redis as RedisType } from "ioredis";
import {
  SandboxExecClient,
  SandboxForwardError,
  createSandboxBashDefinition,
  SANDBOX_ERROR_UNAVAILABLE,
  SANDBOX_ERROR_TIMEOUT,
} from "../../src/pth/tools/sandbox-bash.js";
import { AgentEngine } from "../../src/pth/core/agent-engine.js";
import { SessionPool } from "../../src/pth/core/session-pool.js";
import { WorkspaceManager } from "../../src/shared/workspace/manager.js";
import { detectPlatform } from "../../src/shared/platform/index.js";

/**
 * F/WP3 Task 11 — bash 工具全量转发 sandbox（统一接口名 bash + 类型化错误）。
 * 用本地 http server 模拟 sandbox /exec：断言转发参数（cmd/cwd）、共享密钥头、
 * 类型化错误（sandbox-unavailable / sandbox-timeout）、AgentEngine customTools 合并接线。
 */

// ── mock sandbox 服务 ──────────────────────────────────────────────
interface MockRequest {
  method: string;
  url: string;
  authorization: string | undefined;
  body: any;
}
interface MockResponse {
  status?: number;
  body?: unknown;
  delayMs?: number;
}
interface MockSandbox {
  baseUrl: string;
  requests: MockRequest[];
  close: () => Promise<void>;
}

async function startSandbox(handler: (req: MockRequest) => MockResponse | Promise<MockResponse>): Promise<MockSandbox> {
  const requests: MockRequest[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", async () => {
      const body = raw ? JSON.parse(raw) : {};
      const entry: MockRequest = { method: req.method ?? "", url: req.url ?? "", authorization: req.headers.authorization, body };
      requests.push(entry);
      const r = await handler(entry);
      if (r.delayMs) await new Promise((x) => setTimeout(x, r.delayMs));
      res.writeHead(r.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(r.body ?? {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** 监听后立即关闭的端口——模拟 sandbox 不可达（ECONNREFUSED） */
async function closedPortUrl(): Promise<string> {
  const probe = http.createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const addr = probe.address() as AddressInfo;
  await new Promise<void>((r) => probe.close(() => r()));
  return `http://127.0.0.1:${addr.port}`;
}

// ── SDK mock（engine 接线断言）─────────────────────────────────────
const sdkMocks = vi.hoisted(() => ({ createdOptions: [] as any[] }));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...mod,
    createAgentSession: vi.fn(async (options: any) => {
      sdkMocks.createdOptions.push(options);
      return {
        session: {
          prompt: async () => {},
          abort: async () => {},
          subscribe: () => () => {},
          dispose: () => {},
        },
      };
    }),
  };
});

// ── 转发客户端 ─────────────────────────────────────────────────────
describe("SandboxExecClient 转发（F/WP3 Task 11）", () => {
  it("转发 cmd/cwd + 共享密钥头，解析结果", async () => {
    const sandbox = await startSandbox(() => ({ body: { stdout: "hi", stderr: "", exitCode: 0, timedOut: false } }));
    try {
      const client = new SandboxExecClient({ baseUrl: sandbox.baseUrl, secret: "s3cret" });
      const result = await client.exec({ cmd: "echo hi", cwd: "/data/workspaces/t/p" });
      expect(result.stdout).toBe("hi");
      expect(result.exitCode).toBe(0);
      expect(sandbox.requests).toHaveLength(1);
      expect(sandbox.requests[0].method).toBe("POST");
      expect(sandbox.requests[0].url).toBe("/exec");
      expect(sandbox.requests[0].authorization).toBe("Bearer s3cret");
      expect(sandbox.requests[0].body).toMatchObject({ cmd: "echo hi", cwd: "/data/workspaces/t/p" });
      expect(sandbox.requests[0].body.timeout).toBeUndefined();
    } finally {
      await sandbox.close();
    }
  });

  it("请求带 timeout → 透传 sandbox 侧超时", async () => {
    const sandbox = await startSandbox(() => ({ body: { stdout: "", stderr: "", exitCode: 137, timedOut: true } }));
    try {
      const client = new SandboxExecClient({ baseUrl: sandbox.baseUrl, secret: "s" });
      const result = await client.exec({ cmd: "sleep 1", timeout: 50 });
      expect(result.timedOut).toBe(true);
      expect(sandbox.requests[0].body.timeout).toBe(50);
    } finally {
      await sandbox.close();
    }
  });

  it("sandbox 不可达 → 类型化 sandbox-unavailable（不静默）", async () => {
    const url = await closedPortUrl();
    const client = new SandboxExecClient({ baseUrl: url, secret: "x" });
    await expect(client.exec({ cmd: "echo hi" })).rejects.toBeInstanceOf(SandboxForwardError);
    await expect(client.exec({ cmd: "echo hi" })).rejects.toMatchObject({ code: SANDBOX_ERROR_UNAVAILABLE });
  });

  it("HTTP 非 2xx（认证失败/配置错）→ 类型化 sandbox-unavailable", async () => {
    const sandbox = await startSandbox(() => ({ status: 401, body: { error: "unauthorized" } }));
    try {
      const client = new SandboxExecClient({ baseUrl: sandbox.baseUrl, secret: "wrong" });
      await expect(client.exec({ cmd: "echo hi" })).rejects.toMatchObject({ code: SANDBOX_ERROR_UNAVAILABLE });
    } finally {
      await sandbox.close();
    }
  });

  it("客户端请求超时（慢 sandbox）→ 类型化 sandbox-timeout", async () => {
    const sandbox = await startSandbox(() => ({ delayMs: 500, body: {} }));
    try {
      const client = new SandboxExecClient({ baseUrl: sandbox.baseUrl, secret: "x", timeoutMs: 80 });
      const err = await client.exec({ cmd: "sleep" }).catch((e) => e);
      expect(err).toBeInstanceOf(SandboxForwardError);
      expect(err.code).toBe(SANDBOX_ERROR_TIMEOUT);
    } finally {
      await sandbox.close();
    }
  });
});

// ── SDK 工具定义 execute ───────────────────────────────────────────
describe("createSandboxBashDefinition execute（统一接口名 bash）", () => {
  it("定义名为 bash（接口名统一，无第二套 API）", async () => {
    const sandbox = await startSandbox(() => ({ body: { stdout: "", stderr: "", exitCode: 0, timedOut: false } }));
    try {
      const def = createSandboxBashDefinition(new SandboxExecClient({ baseUrl: sandbox.baseUrl, secret: "s" }));
      expect(def.name).toBe("bash");
      expect(typeof def.execute).toBe("function");
    } finally {
      await sandbox.close();
    }
  });

  it("成功：聚合 stdout/stderr 一次性回传 + cwd 转发", async () => {
    const sandbox = await startSandbox(() => ({ body: { stdout: "out-1", stderr: "err-1", exitCode: 0, timedOut: false } }));
    try {
      const def = createSandboxBashDefinition(new SandboxExecClient({ baseUrl: sandbox.baseUrl, secret: "s" }));
      const result: any = await def.execute("tid", { command: "ls" }, undefined, undefined, { cwd: "/data/workspaces/t/p" });
      expect(result.content[0].type).toBe("text");
      expect(result.content[0].text).toContain("out-1");
      expect(result.content[0].text).toContain("err-1");
      expect(sandbox.requests[0].body.cwd).toBe("/data/workspaces/t/p");
      expect(sandbox.requests[0].body.cmd).toBe("ls");
    } finally {
      await sandbox.close();
    }
  });

  it("sandbox 不可达 → 错误文本含 sandbox-unavailable（不静默）", async () => {
    const url = await closedPortUrl();
    const def = createSandboxBashDefinition(new SandboxExecClient({ baseUrl: url, secret: "s", timeoutMs: 1000 }));
    const result: any = await def.execute("tid", { command: "ls" }, undefined, undefined, { cwd: "/data/workspaces/t/p" });
    expect(result.content[0].text).toContain(SANDBOX_ERROR_UNAVAILABLE);
  });

  it("sandbox 超时标记 → 错误文本含 sandbox-timeout", async () => {
    const sandbox = await startSandbox(() => ({ body: { stdout: "", stderr: "", exitCode: 137, timedOut: true } }));
    try {
      const def = createSandboxBashDefinition(new SandboxExecClient({ baseUrl: sandbox.baseUrl, secret: "s" }));
      const result: any = await def.execute("tid", { command: "sleep", timeout: 50 }, undefined, undefined, { cwd: "/data/workspaces/t/p" });
      expect(result.content[0].text).toContain(SANDBOX_ERROR_TIMEOUT);
    } finally {
      await sandbox.close();
    }
  });
});

// ── AgentEngine 接线 ───────────────────────────────────────────────
describe("AgentEngine customTools 合并 sandbox bash（F/WP3 Task 11）", () => {
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
  });

  function makeEngine(tmp: string, sessionsDir: string, sandboxBashDef: any) {
    const workspaceMgr = new WorkspaceManager(
      detectPlatform(), path.join(tmp, "workspaces"), path.join(tmp, "platform"), path.join(tmp, "tenants"),
    );
    const deps = {
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
    const pool = new SessionPool(
      { maxSessions: 20, maxSessionsPerTenant: 5, idleTimeoutMs: 300_000 },
      deps.sessionStore, deps.logger, deps.metrics, redis,
    );
    const modelRouter = { resolve: () => ({ id: "test-model" }), getRuntime: () => ({}) } as any;
    const toolPlatform = {
      getAllowedTools: vi.fn(() => ["read", "edit"]),
      getSdkToolDefinitions: vi.fn(() => [{ name: "tenant-custom", description: "tenant tool" }]),
      getEffectiveTools: vi.fn(() => ["read", "edit"]),
      recordToolStart: vi.fn(),
      recordToolEnd: vi.fn(),
    } as any;
    const engine = new AgentEngine(
      pool, modelRouter, workspaceMgr, deps.sessionStore, toolPlatform,
      deps.logger, deps.metrics, sessionsDir, deps.audit, undefined, sandboxBashDef,
    );
    return { engine, deps };
  }

  it("createSession 的 customTools = 租户工具 + sandbox bash（后置同名覆盖）", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sb-fwd-"));
    const sessionsDir = path.join(tmp, "sessions");
    const sandboxBashDef = {
      name: "bash", label: "Bash", description: "d", parameters: {},
      execute: async () => ({ content: [], details: {} }),
    };
    try {
      const { engine } = makeEngine(tmp, sessionsDir, sandboxBashDef);
      const res = await engine.createSession({ tenantId: "tenant-a", project: "proj-1" });
      expect(res.ok).toBe(true);
      const sid = (res as any).data.sessionId;
      writtenKeys.push(`pool:${sid}:meta`);
      const opts = sdkMocks.createdOptions[0];
      const names = opts.customTools.map((t: any) => t.name);
      // 接口名统一：平台级 bash（非 sandbox-bash）；租户工具在前，平台 bash 后置覆盖
      expect(names).toEqual(["tenant-custom", "bash"]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("未接线 sandboxBash（可选参数缺省）→ customTools 不含 bash 覆盖", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sb-fwd-nobash-"));
    const sessionsDir = path.join(tmp, "sessions");
    try {
      const { engine } = makeEngine(tmp, sessionsDir, undefined);
      const res = await engine.createSession({ tenantId: "tenant-a", project: "proj-1" });
      expect(res.ok).toBe(true);
      const sid = (res as any).data.sessionId;
      writtenKeys.push(`pool:${sid}:meta`);
      const opts = sdkMocks.createdOptions[0];
      const names = opts.customTools.map((t: any) => t.name);
      expect(names).toEqual(["tenant-custom"]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
