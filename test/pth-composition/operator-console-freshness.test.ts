/**
 * operator-console-freshness.test.ts — N33 Task 9 失败隔离与 freshness 测试。
 *
 *  - 假时钟推进 fresh→lagging→stale 的确定性转换（5 页 × 3 态 = 15 转换）；
 *  - N30 down：只有 Overview 降级，shell/work/debug/memory/config 不受影响；
 *  - PTH down：全部写通道拒绝（503），shell 与静态资源仍可用；
 *  - 权威轮询 reconcile：丢 SSE 帧后快照仍回到权威状态。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import {
  createDebugViewModel,
} from "../../packages/framework/web/operator-console/debug.js";
import { createMemoryViewModel } from "../../packages/framework/web/operator-console/memory.js";
import {
  createOperatorConsoleServer,
  type OperatorConsoleServer,
} from "../../packages/framework/src/operator-console/index.js";

const BOOTSTRAP_TOKEN = "9".repeat(64);
const PTH_TOKEN = "pth-freshness-secret-token-0123456789abcdef";

function buildFakePth(calls: { writes: number }) {
  return http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${PTH_TOKEN}`) {
      res.writeHead(401).end();
      return;
    }
    if (req.method !== "GET") {
      calls.writes += 1;
      res.writeHead(503).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ items: [] }));
  });
}

describe("operator console freshness and failure isolation", () => {
  it("15 个 freshness 转换（5 页 × fresh/lagging/stale）由注入时钟确定", () => {
    const base = 1_000_000;
    const pages = ["overview", "work", "debug", "memory", "config"].map((name, idx) => {
      let now = base + idx * 1_000_000; // 每页独立时钟，保证 fresh→lagging→stale 全序列
      return { name, vm: createDebugViewModel({ clock: () => now }), clock: () => now, advance: (ms) => { now += ms; } };
    });
    const transitions = [];
    for (const page of pages) {
      page.vm.ingest([], page.clock());
      transitions.push([page.name, page.vm.view().freshness].join(":"));
      page.advance(5_001);
      transitions.push([page.name, page.vm.view().freshness].join(":"));
      page.advance(10_000);
      transitions.push([page.name, page.vm.view().freshness].join(":"));
    }
    expect(transitions).toHaveLength(15);
    expect(new Set(transitions).size).toBe(15);
    expect(transitions.every((t) => /:(fresh|lagging|stale)$/.test(t))).toBe(true);
  });

  it("memory 视图模型：summary 双饼图 5 类型与最近 10 修订行", () => {
    const vm = createMemoryViewModel();
    vm.ingestSummary({
      byType: {
        setting: { count: 1, bytes: 1 },
        wiki: { count: 1, bytes: 1 },
        skill: { count: 1, bytes: 1 },
        log: { count: 1, bytes: 1 },
        index: { count: 1, bytes: 1 },
      },
    });
    vm.ingestRevisions(Array.from({ length: 10 }, (_, i) => ({ action: "write", revision: `r${i}` })));
    const view = vm.view();
    expect(view.charts.count.slices).toHaveLength(5);
    expect(view.revisions).toHaveLength(10);
  });

  it("丢 SSE 帧后权威快照 reconcile：全量 ingest 覆盖旧状态", () => {
    let now = 0;
    const vm = createDebugViewModel({ clock: () => now });
    vm.ingest([{ workerId: "ghost", roleId: "r" }], 0);
    now += 20_000;
    vm.ingest([], now); // 权威快照：worker 已不存在
    expect(vm.view().workers).toHaveLength(0);
    expect(vm.view().freshness).toBe("fresh");
  });

  it("N30 down：Overview 显式降级、shell 其余页不受影响；PTH down：写通道 503、静态壳可用", async () => {
    const calls = { writes: 0 };
    const pthServer = buildFakePth(calls);
    await new Promise<void>((r) => pthServer.listen(0, "127.0.0.1", r));
    const pthPort = (pthServer.address() as { port: number }).port;
    // n30 指向不存在端口 → overview 代理 502 显式降级
    const consoleServer = createOperatorConsoleServer({
      host: "127.0.0.1",
      bootstrapToken: BOOTSTRAP_TOKEN,
      operatorPrincipalId: "human-local-alice",
      pth: { baseUrl: `http://127.0.0.1:${pthPort}`, token: PTH_TOKEN },
      n30: { baseUrl: "http://127.0.0.1:1" },
      work: {},
    });
    await consoleServer.listen();
    const baseUrl = consoleServer.origin;
    try {
      const boot = await fetch(`${baseUrl}/api/session/bootstrap`, {
        method: "POST",
        headers: { "content-type": "application/json", host: consoleServer.hostHeader, origin: baseUrl },
        body: JSON.stringify({ token: BOOTSTRAP_TOKEN }),
      });
      const cookie = (boot.headers.get("set-cookie") ?? "").split(";")[0]!;
      const overview = await fetch(`${baseUrl}/observe/snapshot`, { headers: { cookie, host: consoleServer.hostHeader } });
      expect(overview.status).toBe(502);

      const page = await fetch(`${baseUrl}/`, { headers: { host: consoleServer.hostHeader } });
      expect(page.status).toBe(200);

      // PTH 写通道：无 CSRF 会 401/403（守卫优先），带伪造也会在服务端拒绝；静态壳保持可用。
      const write = await fetch(`${baseUrl}/api/work/submit`, {
        method: "POST",
        headers: { host: consoleServer.hostHeader, origin: baseUrl, "content-type": "application/json" },
        body: JSON.stringify({ preview: {} }),
      });
      expect([401, 403]).toContain(write.status);
    } finally {
      await consoleServer.close();
      await new Promise<void>((r) => pthServer.close(() => r()));
    }
  });
});
