/**
 * test/unit/hub-debug.test.ts — F/WP4 Task 22 hub debug WebSocket 交互调试通道
 *
 * 覆盖：WS 握手（真实 listen + Node 内置 WebSocket 客户端，零新增依赖）/
 * 双向回显（mock sandbox 网关）/权限拒绝（无 Bearer→401、tenant-agent→closed）/
 * 协议（非法 JSON/未知类型/close）/审计 / PTL connectDebugSession 全链路 / 默认 sandbox 网关映射。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import type { AddressInfo } from "node:net";
import { createAuthHook } from "../../src/pth/gateway/auth.js";
import {
  registerDebugRoutes,
  createSandboxDebugGatewayFactory,
  type DebugGateway,
  type DebugGatewayFactory,
} from "../../src/pth/gateway/routes-debug.js";
import { AuditWriter } from "../../src/pth/observability/audit.js";
import { SandboxExecClient, SandboxForwardError } from "@away_from/pth-sandbox";
import { connectDebugSession } from "../../packages/pth-console/src/commands/debug.js";

// ── mock Redis（auth get + audit xadd/xtrim）──────

class MockRedis {
  store = new Map<string, string>();
  streams = new Map<string, { id: string; fields: Record<string, string> }[]>();

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.store.get(key) ?? null);
  }
  set(key: string, value: string): Promise<"OK"> {
    this.store.set(key, value);
    return Promise.resolve("OK");
  }
  xadd(key: string, _id: string, ...fields: string[]): Promise<string> {
    const rec: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) rec[fields[i]!] = fields[i + 1]!;
    const arr = this.streams.get(key) ?? [];
    arr.push({ id: `${arr.length + 1}-0`, fields: rec });
    this.streams.set(key, arr);
    return Promise.resolve(`${arr.length}-0`);
  }
  xtrim(): Promise<number> { return Promise.resolve(0); }
}

function auditEvents(redis: MockRedis): Array<Record<string, unknown>> {
  const entries = redis.streams.get("audit:log") ?? [];
  return entries.map((e) => JSON.parse(e.fields.data ?? "{}"));
}

// ── 回显网关（mock sandbox：收到什么回什么，sessionId 透传）──────

function echoGatewayFactory(): DebugGatewayFactory {
  return (sessionId: string): DebugGateway => ({
    async send(input: string) {
      return { kind: "output", data: `echo:${sessionId}:${input}` };
    },
  });
}

// ── WS 客户端辅助（Node 内置 WebSocket + headers 握手）──────

function nextMessage(ws: WebSocket, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", onMsg);
      reject(new Error("WS message timeout"));
    }, timeoutMs);
    const onMsg = (ev: MessageEvent) => {
      clearTimeout(timer);
      ws.removeEventListener("message", onMsg);
      resolve(JSON.parse(String(ev.data)));
    };
    ws.addEventListener("message", onMsg);
  });
}

describe("hub debug WS 通道", () => {
  let redis: MockRedis;
  let app: ReturnType<typeof Fastify>;
  let port: number;
  const sockets: WebSocket[] = [];

  const ADMIN_TOKEN = "admin-token";
  const AGENT_TOKEN = "agent-token";

  async function build(gwFactory: DebugGatewayFactory) {
    app = Fastify({ logger: false });
    await app.register(websocket);
    app.addHook("onRequest", createAuthHook(redis as any));
    registerDebugRoutes(app, { gatewayFactory: gwFactory, audit: new AuditWriter(redis as any) });
    await app.ready();
    await app.listen({ port: 0, host: "127.0.0.1" });
    port = (app.server.address() as AddressInfo).port;
  }

  function wsUrl(sessionId?: string): string {
    const q = sessionId ? `?sessionId=${sessionId}` : "";
    return `ws://127.0.0.1:${port}/ws/debug${q}`;
  }

  function openWs(token: string, sessionId?: string): Promise<WebSocket> {
    const ws = new WebSocket(wsUrl(sessionId), { headers: { authorization: `Bearer ${token}` } });
    sockets.push(ws);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("WS open timeout")), 5000);
      ws.addEventListener("open", () => { clearTimeout(timer); resolve(ws); });
      ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("WS error")); });
    });
  }

  beforeEach(async () => {
    redis = new MockRedis();
    await redis.set(`auth:token:${ADMIN_TOKEN}`, JSON.stringify({ tenantId: "tenant-a", role: "platform-admin" }));
    await redis.set(`auth:token:${AGENT_TOKEN}`, JSON.stringify({ tenantId: "tenant-a", role: "tenant-agent" }));
  });

  afterEach(async () => {
    for (const s of sockets) { try { s.close(); } catch { /* ignore */ } }
    sockets.length = 0;
    if (app) await app.close();
  });

  it("权限断言：无 Bearer 的 /ws/debug → 401（auth hook 终止握手）", async () => {
    await build(echoGatewayFactory());
    const res = await app.inject({ method: "GET", url: "/ws/debug" });
    expect(res.statusCode).toBe(401);
  });

  it("权限拒绝：tenant-agent 角色 → closed（forbidden: platform-admin）", async () => {
    await build(echoGatewayFactory());
    const ws = await openWs(AGENT_TOKEN);
    const msg = await nextMessage(ws);
    expect(msg.type).toBe("closed");
    expect(msg.reason).toMatch(/platform-admin/);
  });

  it("握手 + 双向回显：platform-admin 输入 → 网关 output 回传", async () => {
    await build(echoGatewayFactory());
    const ws = await openWs(ADMIN_TOKEN);
    ws.send(JSON.stringify({ type: "input", data: "ls -la" }));
    const msg = await nextMessage(ws);
    expect(msg).toEqual({ type: "output", data: "echo:sandbox:ls -la" });
  });

  it("sessionId 透传：?sessionId=abc → 网关收到 abc", async () => {
    await build(echoGatewayFactory());
    const ws = await openWs(ADMIN_TOKEN, "abc");
    ws.send(JSON.stringify({ type: "input", data: "pwd" }));
    const msg = await nextMessage(ws);
    expect(msg.data).toBe("echo:abc:pwd");
  });

  it("协议：非法 JSON → error；未知消息类型 → error", async () => {
    await build(echoGatewayFactory());
    const ws = await openWs(ADMIN_TOKEN);
    ws.send("not-json");
    const e1 = await nextMessage(ws);
    expect(e1.type).toBe("error");
    expect(e1.error).toMatch(/invalid JSON/);

    ws.send(JSON.stringify({ type: "bogus" }));
    const e2 = await nextMessage(ws);
    expect(e2.type).toBe("error");
    expect(e2.error).toMatch(/unknown message type/);
  });

  it("协议：client close → 收到 closed", async () => {
    await build(echoGatewayFactory());
    const ws = await openWs(ADMIN_TOKEN);
    ws.send(JSON.stringify({ type: "close" }));
    const msg = await nextMessage(ws);
    expect(msg.type).toBe("closed");
  });

  it("会话审计：成功连接写 debug_session_open（tenantId 归属）", async () => {
    await build(echoGatewayFactory());
    const ws = await openWs(ADMIN_TOKEN, "sess-x");
    ws.send(JSON.stringify({ type: "input", data: "x" }));
    await nextMessage(ws);

    const events = auditEvents(redis);
    const open = events.find((e) => e.action === "debug_session_open");
    expect(open).toBeDefined();
    expect(open!.tenantId).toBe("tenant-a");
    expect((open!.details as any).sessionId).toBe("sess-x");
  });

  it("PTL connectDebugSession 全链路：sendInput → 输出回显 → close", async () => {
    await build(echoGatewayFactory());
    const outputs: string[] = [];
    let opened = false;
    const sess = connectDebugSession(wsUrl(), ADMIN_TOKEN, {
      onOpen: () => { opened = true; },
      onOutput: (d) => outputs.push(d),
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("open timeout")), 5000);
      const poll = setInterval(() => {
        if (opened) { clearTimeout(timer); clearInterval(poll); resolve(); }
      }, 20);
    });
    sess.sendInput("hello");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("output timeout")), 5000);
      const poll = setInterval(() => {
        if (outputs.length > 0) { clearTimeout(timer); clearInterval(poll); resolve(); }
      }, 20);
    });
    expect(outputs).toEqual(["echo:sandbox:hello"]);
    sess.close();
  });
});

describe("默认 sandbox 调试网关（createSandboxDebugGatewayFactory）", () => {
  it("exec 成功 → output（stdout+stderr 聚合）", async () => {
    const client = {
      exec: async () => ({ stdout: "hello out", stderr: "warn line", exitCode: 0, timedOut: false }),
    } as unknown as SandboxExecClient;
    const gw = createSandboxDebugGatewayFactory(client)("s1");
    const r = await gw.send("echo hi");
    expect(r).toEqual({ kind: "output", data: "hello out\nwarn line" });
  });

  it("非零退出码 → output 附带 [exit N] 标记", async () => {
    const client = {
      exec: async () => ({ stdout: "", stderr: "boom", exitCode: 2, timedOut: false }),
    } as unknown as SandboxExecClient;
    const gw = createSandboxDebugGatewayFactory(client)("s1");
    const r = await gw.send("ls /nonexistent");
    expect(r.kind).toBe("output");
    expect(r.data).toContain("boom");
    expect(r.data).toContain("[exit 2]");
  });

  it("sandbox 不可达 → error（类型化）", async () => {
    const client = {
      exec: async () => {
        throw new SandboxForwardError("sandbox-unavailable", "unreachable");
      },
    } as unknown as SandboxExecClient;
    const gw = createSandboxDebugGatewayFactory(client)("s1");
    const r = await gw.send("echo hi");
    expect(r).toEqual({ kind: "error", data: "sandbox-unavailable: unreachable" });
  });
});
