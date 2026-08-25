/**
 * test/unit/events-webhook.test.ts — F/WP5 Task 27 外部事件 webhook 入口
 *
 * 覆盖：权限拒绝（无 Bearer → 401）/+ 转发成功（202）+ 请求校验（400）+
 * 常驻会话不可用（503）+ 推送→订阅触发断言（mock 常驻会话/事件通道）+
 * 租户归属（事件 tenantId = 认证租户）+ 审计落库。
 *
 * mock 策略：mock Redis（auth 校验）+ mock engine（emitExternalEvent 记录调用）；
 * 订阅触发断言用真实 createEventBus 模拟常驻会话通道——路由→engine→bus→
 * 订阅回调的转发语义完整覆盖（pth 零引用、仅按线协议常量 EXTERNAL_EVENT_CHANNEL 耦合）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import { createAuthHook } from "../../src/pth/gateway/auth.js";
import { registerEventsRoutes } from "../../src/pth/gateway/routes-events.js";
import { EXTERNAL_EVENT_CHANNEL } from "../../src/pth/core/system-event-bus.js";
import { createEventBus } from "@earendil-works/pi-coding-agent";

class MockRedis {
  store = new Map<string, string>();
  get(key: string): Promise<string | null> {
    return Promise.resolve(this.store.get(key) ?? null);
  }
  set(key: string, value: string): Promise<"OK"> {
    this.store.set(key, value);
    return Promise.resolve("OK");
  }
  xadd(key: string, ...args: string[]): Promise<string> {
    // audit:log * data <json>
    const entry = args[args.length - 1] ?? "";
    this.store.set(`${key}:${Date.now()}:${Math.random()}`, entry);
    return Promise.resolve("1-1");
  }
  xtrim(_key: string, ..._args: unknown[]): Promise<number> {
    return Promise.resolve(0);
  }
}

describe("webhook 外部事件入口（F/WP5 Task 27）", () => {
  let redis: MockRedis;
  let app: ReturnType<typeof Fastify>;

  const TOKEN = "token-ok";
  const headers = { authorization: `Bearer ${TOKEN}` };

  beforeEach(async () => {
    redis = new MockRedis();
    await redis.set(`auth:token:${TOKEN}`, JSON.stringify({ tenantId: "tenant-a", role: "tenant-agent" }));
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  function buildApp(engine: { emitExternalEvent: (evt: any) => boolean }, audit?: { write: (e: any) => Promise<void> }) {
    const a = Fastify({ logger: false });
    a.addHook("onRequest", createAuthHook(redis as any));
    registerEventsRoutes(a, engine as any, audit as any);
    return a.ready().then(() => a);
  }

  it("权限拒绝：无 Bearer → 401（不触达 engine）", async () => {
    const emit = vi.fn(() => true);
    app = await buildApp({ emitExternalEvent: emit });
    const res = await app.inject({ method: "POST", url: "/api/v1/events", payload: { eventType: "x", payload: {} } });
    expect(res.statusCode).toBe(401);
    expect(emit).not.toHaveBeenCalled();
  });

  it("请求校验：缺 eventType / payload 非对象 / eventType 超长 → 400", async () => {
    const emit = vi.fn(() => true);
    app = await buildApp({ emitExternalEvent: emit });
    const cases = [
      {},
      { eventType: "" },
      { eventType: "   " },
      { eventType: "x".repeat(300) },
      { eventType: "ok", payload: [] },
      { eventType: "ok", payload: "str" },
      { eventType: "ok", source: 42 },
    ];
    for (const payload of cases) {
      const res = await app.inject({ method: "POST", url: "/api/v1/events", headers, payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(emit).not.toHaveBeenCalled();
  });

  it("转发成功：202 + engine.emitExternalEvent 收到带租户归属的事件 + 审计落库", async () => {
    const calls: any[] = [];
    const auditWrite = vi.fn(async () => {});
    app = await buildApp(
      {
        emitExternalEvent: (evt: any) => {
          calls.push(evt);
          return true;
        },
      },
      { write: auditWrite },
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/events",
      headers,
      payload: { eventType: "order.created", payload: { region: "cn" }, source: "shop-webhook" },
    });
    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body);
    expect(body.accepted).toBe(true);
    expect(body.tenantId).toBe("tenant-a");
    expect(body.eventType).toBe("order.created");

    expect(calls).toHaveLength(1);
    const evt = calls[0];
    expect(evt.eventType).toBe("order.created");
    expect(evt.tenantId).toBe("tenant-a"); // 事件归属 = 认证租户（服务端派生）
    expect(evt.payload).toEqual({ region: "cn" });
    expect(evt.source).toBe("shop-webhook");
    expect(evt.eventId).toBeTruthy();

    expect(auditWrite).toHaveBeenCalledTimes(1);
    const auditEvt = auditWrite.mock.calls[0][0];
    expect(auditEvt.tenantId).toBe("tenant-a");
    expect(auditEvt.action).toBe("external_event_received");
    expect(auditEvt.details.eventType).toBe("order.created");
  });

  it("租户归属隔离：tenant-b 的 token 转发事件带 tenant-b", async () => {
    await redis.set(`auth:token:token-b`, JSON.stringify({ tenantId: "tenant-b", role: "tenant-agent" }));
    const calls: any[] = [];
    app = await buildApp({
      emitExternalEvent: (evt: any) => {
        calls.push(evt);
        return true;
      },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/events",
      headers: { authorization: "Bearer token-b" },
      payload: { eventType: "e", payload: {} },
    });
    expect(res.statusCode).toBe(202);
    expect(calls[0].tenantId).toBe("tenant-b");
  });

  it("常驻会话不可用：emitExternalEvent 返回 false → 503（审计仍先落）", async () => {
    const auditWrite = vi.fn(async () => {});
    app = await buildApp({ emitExternalEvent: () => false }, { write: auditWrite });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/events",
      headers,
      payload: { eventType: "e", payload: {} },
    });
    expect(res.statusCode).toBe(503);
    expect(auditWrite).toHaveBeenCalledTimes(1);
  });

  it("push→订阅触发断言：路由→engine→事件通道→订阅回调收到事件（mock 常驻会话通道）", async () => {
    // 用真实 EventBus 模拟常驻会话共享总线：engine 转发即 emit，订阅回调即 agent-lab 侧消费。
    const bus = createEventBus();
    const received: any[] = [];
    const unsubscribe = bus.on(EXTERNAL_EVENT_CHANNEL, (data) => received.push(data));

    app = await buildApp({
      emitExternalEvent: (evt: any) => {
        bus.emit(EXTERNAL_EVENT_CHANNEL, { ...evt, receivedAt: Date.now() });
        return true;
      },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/events",
      headers,
      payload: { eventType: "order.created", payload: { region: "cn", amount: 1 }, source: "test" },
    });
    expect(res.statusCode).toBe(202);
    expect(received).toHaveLength(1);
    const got = received[0];
    expect(got.eventType).toBe("order.created");
    expect(got.tenantId).toBe("tenant-a");
    expect(got.payload).toEqual({ region: "cn", amount: 1 });
    expect(got.receivedAt).toBeGreaterThan(0);
    unsubscribe();
  });
});
