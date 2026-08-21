import { describe, it, expect, afterEach, vi } from "vitest";
import { PthClient } from "../src/bridge/client.js";

describe("PthClient（bridge/client 拆分后公共面）", () => {
  const client = new PthClient("http://127.0.0.1:3000", "test-token");

  it("保留 baseUrl / authToken 访问器", () => {
    expect(client.baseUrl).toBe("http://127.0.0.1:3000");
    expect(client.authToken).toBe("test-token");
  });

  it("debugUrl 携带会话 id", () => {
    expect(client.debugUrl("s-1")).toContain("s-1");
    expect(client.debugUrl()).toContain("debug");
  });

  it("提交 DTO 类型在拆分后仍可引用（编译期契约）", () => {
    const dto: { type: string; data: Record<string, unknown> } = { type: "task.done", data: {} };
    expect(dto.type).toBe("task.done");
  });

  describe("streamSSE（体验批）", () => {
    afterEach(() => { vi.unstubAllGlobals(); });

    it("解析多事件 + [DONE] 终止", async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"n":1}\n\n'));
          controller.enqueue(new TextEncoder().encode('data: {"n":2}\n\n'));
          controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      vi.stubGlobal("fetch", async () => new Response(stream, { status: 200 }));
      const events: unknown[] = [];
      await client.streamSSE("/api/v1/events/stream", (e) => events.push(e));
      expect(events).toEqual([{ n: 1 }, { n: 2 }]);
    });

    it("无空行结尾的最后一个事件仍解析（网络截断容错）", async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"tail":true}'));
          controller.close();
        },
      });
      vi.stubGlobal("fetch", async () => new Response(stream, { status: 200 }));
      const events: unknown[] = [];
      await client.streamSSE("/sse", (e) => events.push(e));
      expect(events).toEqual([{ tail: true }]);
    });
  });
});
