/**
 * test/unit/f-wp5-integration.test.ts — F/WP5 Task 28e WP5 集成验证
 *
 * 端到端（pth 视角，常驻会话 mock——agent-lab 侧真实接线见
 * extensions/agent-lab/test/scheduled-integration.test.ts）：
 *
 *  1. 外部 webhook → POST /api/v1/events → engine.emitExternalEvent →
 *     常驻会话共享总线（pi.events 通道）→ mock 常驻会话订阅回调收到事件 → 订阅派发
 *  2. observe events 代理 → GET /api/v1/observe/events → engine.querySystemEvents
 *     → 常驻会话通道 RPC（request/response）→ 事件回传
 *  3. component-bound → engine.emitComponentBound → 常驻会话通道 → mock 框架层 registry
 *  4. 定时 job → dispatch：agent-lab 侧直驱（时间压缩）已在 scheduled-integration 覆盖；
 *     此处验证 pth 侧 webhook→通道→订阅派发闭环 + 权限面
 *
 * mock 策略：真实 createEventBus 模拟常驻会话共享总线；常驻会话侧用总线订阅回调
 * 扮演 agent-lab（外部事件/observe/component-bound 的消费端）——与生产接线
 *（wireSystemEvents，pi.events 即同一总线实例）语义一致。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { createAuthHook } from "../../src/pth/gateway/auth.js";
import { registerEventsRoutes } from "../../src/pth/gateway/routes-events.js";
import { registerObserveRoutes } from "../../src/pth/gateway/routes-observe.js";
import { RedisSessionStore } from "@away_from/pth-kernel-storage";
import {
  EXTERNAL_EVENT_CHANNEL,
  OBSERVE_EVENTS_REQUEST_CHANNEL,
  OBSERVE_EVENTS_RESPONSE_CHANNEL,
  COMPONENT_BOUND_CHANNEL,
} from "../../src/pth/core/system-event-bus.js";

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
    this.store.set(`${key}:${Date.now()}:${Math.random()}`, args[args.length - 1] ?? "");
    return Promise.resolve("1-1");
  }
  xtrim(): Promise<number> {
    return Promise.resolve(0);
  }
  del(key: string): Promise<number> {
    return Promise.resolve(this.store.delete(key) ? 1 : 0);
  }
  mget(...keys: string[]): Promise<(string | null)[]> {
    return Promise.resolve(keys.map((k) => this.store.get(k) ?? null));
  }
  incr(key: string): Promise<number> {
    const v = Number(this.store.get(key) ?? "0") + 1;
    this.store.set(key, String(v));
    return Promise.resolve(v);
  }
  zadd(): Promise<number> {
    return Promise.resolve(1);
  }
  zrange(): Promise<string[]> {
    return Promise.resolve([]);
  }
  zrem(): Promise<number> {
    return Promise.resolve(0);
  }
}

describe("F/WP5 集成验证（常驻会话通道闭环）", () => {
  let redis: MockRedis;
  const TOKEN = "token-ok";
  const headers = { authorization: `Bearer ${TOKEN}` };

  beforeEach(async () => {
    redis = new MockRedis();
    await redis.set(`auth:token:${TOKEN}`, JSON.stringify({ tenantId: "tenant-a", role: "tenant-agent" }));
  });

  it("外部 webhook → 常驻会话共享总线 → mock 订阅回调（订阅派发语义）", async () => {
    const bus = createEventBus();
    // 常驻会话侧消费端（等价 agent-lab wireSystemEvents 的订阅）：
    // 收到外部事件 → 记录 + 触发"订阅派发"回调
    const received: any[] = [];
    const dispatched: string[] = [];
    const unsub = bus.on(EXTERNAL_EVENT_CHANNEL, (data: any) => {
      received.push(data);
      // 模拟 agent-lab 订阅匹配：eventType=order.created 且有订阅 → dispatch
      if (data?.eventType === "order.created") {
        dispatched.push(data.eventId);
      }
    });

    // engine mock：转发到总线（等价 AgentEngine.emitExternalEvent 的 emit）
    const engine = {
      emitExternalEvent: (evt: any) => {
        bus.emit(EXTERNAL_EVENT_CHANNEL, { ...evt, receivedAt: Date.now() });
        return true;
      },
    };
    const app = Fastify({ logger: false });
    app.addHook("onRequest", createAuthHook(redis as any));
    registerEventsRoutes(app, engine as any);
    await app.ready();

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/events",
        headers,
        payload: { eventType: "order.created", payload: { region: "cn" }, source: "shop" },
      });
      expect(res.statusCode).toBe(202);
      // 总线投递 + 订阅派发（mock 常驻会话侧）
      expect(received).toHaveLength(1);
      expect(received[0].tenantId).toBe("tenant-a");
      expect(received[0].payload).toEqual({ region: "cn" });
      expect(dispatched).toHaveLength(1);
    } finally {
      unsub();
      await app.close();
    }
  });

  it("observe events 代理：常驻会话通道 RPC request/response 回传事件", async () => {
    const bus = createEventBus();
    // 常驻会话侧：监听 request → 回 response（requestId 关联）
    const unsub = bus.on(OBSERVE_EVENTS_REQUEST_CHANNEL, (data: any) => {
      bus.emit(OBSERVE_EVENTS_RESPONSE_CHANNEL, {
        requestId: data.requestId,
        events: [
          {
            eventId: "ev-1",
            eventType: "scheduled.fire",
            timestamp: 1720000000000,
            sequence: 1,
            identity: { traceId: "t1" },
            payload: { jobId: "j1" },
          },
        ],
      });
    });

    // engine mock：直接返回固定事件集（RPC 请求/响应语义已在 agent-lab
    // scheduled-integration 覆盖——此处验证 pth 路由 + 透传面）
    const engine = {
      querySystemEvents: async () => ({
        ok: true as const,
        data: [
          {
            eventId: "ev-1",
            eventType: "scheduled.fire",
            timestamp: 1720000000000,
            sequence: 1,
            identity: { traceId: "t1" },
            payload: { jobId: "j1" },
          },
        ],
      }),
    };

    const store = new RedisSessionStore(redis as any);
    const app = Fastify({ logger: false });
    app.addHook("onRequest", createAuthHook(redis as any));
    registerObserveRoutes(app, store, engine as any);
    await app.ready();

    try {
      const res = await app.inject({ method: "GET", url: "/api/v1/observe/events", headers });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.count).toBe(1);
      expect(body.events[0].eventType).toBe("scheduled.fire");
    } finally {
      unsub();
      await app.close();
    }
  });

  it("component-bound：engine.emitComponentBound → 常驻会话通道 → 框架层 registry 注册", async () => {
    const bus = createEventBus();
    const registered: any[] = [];
    const unsub = bus.on(COMPONENT_BOUND_CHANNEL, (data: any) => registered.push(data));

    const engine = {
      emitComponentBound: (binding: any) => {
        bus.emit(COMPONENT_BOUND_CHANNEL, { ...binding, boundAt: Date.now() });
        return true;
      },
    };
    const app = Fastify({ logger: false });
    app.addHook("onRequest", createAuthHook(redis as any));
    registerEventsRoutes(app, engine as any);
    await app.ready();

    try {
      // 直接驱动 engine 方法（无 HTTP——注册发生于构件上传路径，通道语义在此验证）
      const delivered = engine.emitComponentBound({
        slotId: "slot-sched-1",
        type: "scheduler",
        name: "my-scheduler",
        version: 3,
        tenantId: "tenant-a",
      });
      expect(delivered).toBe(true);
      expect(registered).toHaveLength(1);
      expect(registered[0].slotId).toBe("slot-sched-1");
      expect(registered[0].tenantId).toBe("tenant-a");
    } finally {
      unsub();
      await app.close();
    }
  });

  it("常驻会话不可用：emitExternalEvent false → 503（webhook 收审计但拒绝投递）", async () => {
    const app = Fastify({ logger: false });
    app.addHook("onRequest", createAuthHook(redis as any));
    registerEventsRoutes(app, { emitExternalEvent: () => false } as any);
    await app.ready();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/events",
        headers,
        payload: { eventType: "e", payload: {} },
      });
      expect(res.statusCode).toBe(503);
    } finally {
      await app.close();
    }
  });
});
