/**
 * operator-console-reacceptance.test.ts —— N33 复验收 P0 关闭证据。
 *
 * 真实 loopback HTTP 探针（不替代源码近似测试）：
 *  - 完整 ES module graph：/ 与 app.js 引用的 debug/memory/config 全部 200；
 *  - 上游错误正文/凭据泄露为 0：token/URL credential/DB URL/专业软件凭据 sentinel 全检查；
 *  - 生产 DTO 经唯一 browser-dto adapter 进入真实 ViewModel；
 *  - run/task.publish 原生幂等键贯通到 PTH 客户端调用。
 */

import { describe, expect, it, afterAll, beforeAll, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createOperatorConsoleServer, type OperatorConsoleServer } from "../../packages/pth-console/src/operator-console/index.js";
import {
  toBrowserDebugWorkers,
  toBrowserMemoryDetail,
  toBrowserMemoryPage,
  toBrowserMemoryRevisions,
  toBrowserPthConfig,
  toBrowserRoles,
} from "../../packages/pth-console/src/operator-console/index.js";
import { createDebugViewModel } from "../../packages/pth-console/web-src/src/view-models/debug.js";
import { createMemoryViewModel } from "../../packages/pth-console/web-src/src/view-models/memory.js";
import { createConfigViewModel } from "../../packages/pth-console/web-src/src/view-models/config.js";
import { createRunTaskPublishAdapter } from "../../packages/pth-console/src/operator-console/actions/run-actions.js";

const BOOTSTRAP_TOKEN = "b".repeat(64);

interface RawResponse { status: number; headers: http.IncomingHttpHeaders; body: string }

function rawRequest(port: number, path: string, headers: Record<string, string> = {}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method: "GET", headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("N33 reacceptance P0 evidence（loopback HTTP + DTO adapter）", () => {
  let app: OperatorConsoleServer;
  let cookie = "";

  beforeAll(async () => {
    app = createOperatorConsoleServer({
      host: "127.0.0.1",
      bootstrapToken: BOOTSTRAP_TOKEN,
      operatorPrincipalId: "human-local-alice",
      pth: { baseUrl: "http://127.0.0.1:1", token: "server-held-pth-token" },
      n30: {},
    });
    await app.listen();
    const res = await new Promise<RawResponse>((resolve, reject) => {
      const body = JSON.stringify({ token: BOOTSTRAP_TOKEN });
      const req = http.request(
        { host: "127.0.0.1", port: app.port, path: "/api/session/bootstrap", method: "POST", headers: { origin: app.origin, host: `127.0.0.1:${app.port}`, "content-type": "application/json", "content-length": Buffer.byteLength(body) } },
        (response) => {
          let raw = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => { raw += chunk; });
          response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: raw }));
        },
      );
      req.on("error", reject);
      req.write(body);
      req.end();
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers["set-cookie"];
    cookie = Array.isArray(setCookie) ? (setCookie.find((c) => c.startsWith("ptl-operator=")) ?? "").split(";")[0]! : String(setCookie ?? "").split(";")[0] ?? "";
  });

  afterAll(async () => {
    await app?.close();
  });

  it("P0-1：/ 起点的完整 module graph 全部 200", async () => {
    const root = await rawRequest(app.port, "/");
    expect(root.status).toBe(200);
    const appSource = (await rawRequest(app.port, "/app.js")).body;
    expect(appSource).toContain('from "./debug.js"');
    expect(appSource).toContain('from "./memory.js"');
    expect(appSource).toContain('from "./config.js"');
    for (const name of ["app.js", "debug.js", "memory.js", "config.js", "styles.css"]) {
      const res = await rawRequest(app.port, `/${name}`);
      expect(res.status, name).toBe(200);
    }
  });

  it("P0-3：生产 DTO 经 adapter 进入真实 ViewModel 不丢关键字段", () => {
    const workers = toBrowserDebugWorkers([{
      workerId: "w-1",
      batchId: "b-1",
      role: { roleId: "assembly-engineer", revision: "rev-9" },
      lifecycle: "busy",
      workMode: "run",
      currentTaskId: "task-1",
      leaseId: "lease-1",
      regionIds: ["r-1"],
      regionWeights: { "r-1": 3 },
      workingSet: {
        entryIds: ["e-1"],
        skillIndexIds: ["s-1"],
        activeSkillIds: ["s-1"],
        counts: { memoryEntries: 1, skillIndexEntries: 1, activeSkills: 1, tools: 1 },
        usage: { memoryEntries: 1, memoryChars: 9, skillIndexEntries: 1, activeSkills: 1, skillChars: 9, tools: 1 },
        omitted: {},
      },
      toolNames: ["memory"],
      skillIds: ["s-1"],
      heartbeatLagMs: 42,
    }]);
    const debug = createDebugViewModel();
    debug.ingest(workers, 100);
    const projected = debug.view().workers[0]!;
    expect(projected.roleId).toBe("assembly-engineer");
    expect(projected.roleRevision).toBe("rev-9");
    expect(projected.taskId).toBe("task-1");
    expect(projected.regions).toHaveLength(1);
    expect(projected.workingSet.ids).toEqual(["e-1", "s-1", "s-1"]);
    expect(projected.toolNames).toEqual(["memory"]);

    const memory = createMemoryViewModel();
    memory.ingestPage(toBrowserMemoryPage({
      items: [{ id: "m-1", kind: "domain-fact", status: "official", memoryType: "wiki", version: 2, createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T01:00:00.000Z", contentBytes: 123 }],
      nextCursor: "cursor-1",
      collectedAt: 1,
    }));
    expect(memory.view().entries[0]!.type).toBe("wiki");
    expect(memory.view().cursor).toBe("cursor-1");
    memory.ingestRevisions(toBrowserMemoryRevisions({ entryId: "m-1", revisions: [{ entryId: "m-1", revision: 2, status: "official", createdAt: "2026-08-20T01:00:00.000Z", reason: "promote" }] }));
    expect(memory.view().revisions[0]).toMatchObject({ revision: 2, type: "official", action: "promote" });
    memory.ingestDetail(toBrowserMemoryDetail({ id: "m-1", kind: "domain-fact", status: "official", memoryType: "wiki", version: 2, createdAt: "x", updatedAt: "y", contentBytes: 123 }));
    expect(memory.view().detail).toMatchObject({ type: "wiki", contentBytes: 123 });

    const config = createConfigViewModel();
    config.ingestPth(toBrowserPthConfig([{ key: "PTH_SECRET", type: "string", group: "pth", scope: "both", description: "secret", secret: true, runtime: true, source: "env", effectiveValue: "RAW-SECRET", defaultValue: "RAW-DEFAULT" }]).items);
    const configRow = config.view().pthConfig[0]!;
    expect(configRow.effectiveValue).toBe("***");
    expect(configRow.defaultValue).toBe("***");
    expect(configRow.runtimeMutable).toBe(true);

    config.ingestRoles(toBrowserRoles([{ roleId: "assembly-engineer", revision: "role-sha256:r", parent: "developer", generation: 3, tags: ["code"], capabilities: ["memory"], thinking: "medium", acceptanceRole: "read-only" }]).items);
    expect(config.view().roles[0]).toMatchObject({ id: "assembly-engineer", revision: "role-sha256:r" });
  });

  it("P0-4：run adapter 把幂等键传进原生 publishTask 调用", async () => {
    const publishTask = vi.fn(async () => ({ id: "task-1", status: "pending" }));
    const adapter = createRunTaskPublishAdapter({ client: { publishTask } as never });
    const ref = await adapter.submit({
      previewId: "preview-1",
      previewDigest: "sha256:" + "c".repeat(64),
      normalizedInput: { title: "t", text: "x" },
    } as never, { tenant: "tenant-a", space: "ts" } as never, "idem-key-1");
    expect(ref.id).toBe("task-1");
    expect(publishTask).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: "idem-key-1" }));
  });

  it("P0-2：上游 500 正文与凭据 sentinel 泄露计数为 0", async () => {
    const sentinels = [
      "pth-secret-sentinel-XYZ",
      "postgres://user:secret@db.internal/mydb",
      "http://user:secret@upstream.internal",
      "WOLFRAM_LICENSE_XYZ",
      "server-held-pth-token",
    ];
    const upstream = http.createServer((_req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: sentinels.join(" | ") }));
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upstreamPort = (upstream.address() as AddressInfo).port;
    const leakingApp = createOperatorConsoleServer({
      host: "127.0.0.1",
      bootstrapToken: BOOTSTRAP_TOKEN,
      operatorPrincipalId: "human-local-alice",
      pth: { baseUrl: `http://127.0.0.1:${upstreamPort}`, token: "server-held-pth-token" },
      n30: {},
    });
    await leakingApp.listen();
    try {
      const boot = await new Promise<RawResponse>((resolve, reject) => {
        const body = JSON.stringify({ token: BOOTSTRAP_TOKEN });
        const req = http.request(
          { host: "127.0.0.1", port: leakingApp.port, path: "/api/session/bootstrap", method: "POST", headers: { origin: leakingApp.origin, host: `127.0.0.1:${leakingApp.port}`, "content-type": "application/json", "content-length": Buffer.byteLength(body) } },
          (response) => {
            let raw = "";
            response.setEncoding("utf8");
            response.on("data", (chunk: string) => { raw += chunk; });
            response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: raw }));
          },
        );
        req.on("error", reject);
        req.write(body);
        req.end();
      });
      const leakCookie = (Array.isArray(boot.headers["set-cookie"]) ? boot.headers["set-cookie"]!.find((c) => c.startsWith("ptl-operator=")) : undefined)?.split(";")[0] ?? "";
      for (const path of ["/api/config/pth", "/api/memory/entries", "/api/debug/workers"]) {
        const res = await rawRequest(leakingApp.port, path, { cookie: leakCookie });
        expect(res.status, path).toBe(502);
        const parsed = JSON.parse(res.body) as { error?: { code?: string; requestId?: string; message?: string } };
        expect(parsed.error?.requestId).toBeTruthy();
        for (const sentinel of sentinels) {
          expect(res.body, `${path} must not leak ${sentinel}`).not.toContain(sentinel);
        }
      }
    } finally {
      await leakingApp.close();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  }, 30_000);
});
