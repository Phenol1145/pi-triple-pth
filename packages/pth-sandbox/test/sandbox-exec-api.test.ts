import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildExecApp } from "@away_from/pth-sandbox";
import type { FastifyInstance } from "fastify";

/**
 * F/WP3 Task 10 — sandbox 执行 API 单测。
 * 直接构建 fastify app（inject，不起真实监听端口）；执行用真实 spawn（简单命令）。
 * 认证拒绝 / cwd 白名单拒绝 / 超时强杀 / SSE 流式端点 全覆盖。
 * 注：SSE 端点用"完成后的重放"路径断言（inject 无法测 live 推送）。
 */

const SECRET = "test-sandbox-secret";

describe("sandbox 执行 API（F/WP3 Task 10）", () => {
  let app: FastifyInstance;
  let wsRoot: string;
  let wsDir: string;

  beforeAll(async () => {
    process.env.SANDBOX_SHARED_SECRET = SECRET;
    wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-ws-"));
    wsDir = path.join(wsRoot, "tenant-a", "proj-1");
    fs.mkdirSync(wsDir, { recursive: true });
    app = buildExecApp({ workspacesRoot: wsRoot });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(wsRoot, { recursive: true, force: true });
    delete process.env.SANDBOX_SHARED_SECRET;
  });

  function authHeaders() {
    return { authorization: `Bearer ${SECRET}` };
  }

  it("GET /health → {status:ok}（无认证——healthcheck 需要）", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("POST /exec 字符串命令 → {stdout, stderr, exitCode}", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/exec",
      headers: authHeaders(),
      payload: { cmd: "echo hello", cwd: wsDir },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.exitCode).toBe(0);
    expect(body.stdout).toContain("hello");
    expect(body.timedOut).toBe(false);
  });

  it("POST /exec argv 数组 → 直接 spawn", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/exec",
      headers: authHeaders(),
      payload: { cmd: ["node", "-e", "process.stdout.write('arr-ok')"], cwd: wsDir },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().stdout).toBe("arr-ok");
  });

  it("认证拒绝：缺 Authorization → 401；错误密钥 → 401", async () => {
    const r1 = await app.inject({ method: "POST", url: "/exec", payload: { cmd: "echo x", cwd: wsDir } });
    expect(r1.statusCode).toBe(401);
    const r2 = await app.inject({
      method: "POST", url: "/exec",
      headers: { authorization: "Bearer wrong" },
      payload: { cmd: "echo x", cwd: wsDir },
    });
    expect(r2.statusCode).toBe(401);
  });

  it("cwd 白名单：白名单外 → 400；穿越尝试 → 400；不存在 → 400", async () => {
    const r1 = await app.inject({
      method: "POST", url: "/exec", headers: authHeaders(),
      payload: { cmd: "echo x", cwd: path.join(os.tmpdir(), "evil-dir") },
    });
    expect(r1.statusCode).toBe(400);

    const r2 = await app.inject({
      method: "POST", url: "/exec", headers: authHeaders(),
      payload: { cmd: "echo x", cwd: path.join(wsRoot, "..", "..") },
    });
    expect(r2.statusCode).toBe(400);

    const r3 = await app.inject({
      method: "POST", url: "/exec", headers: authHeaders(),
      payload: { cmd: "echo x", cwd: path.join(wsRoot, "not-exist") },
    });
    expect(r3.statusCode).toBe(400);
  });

  it("cwd 白名单 realpath（评审 WP3-R1）：卷内 symlink 指向卷外 → 400（防 symlink 逃逸）", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-outside-"));
    const link = path.join(wsRoot, "escape-link");
    fs.symlinkSync(outside, link);
    try {
      const res = await app.inject({
        method: "POST", url: "/exec", headers: authHeaders(),
        payload: { cmd: "echo x", cwd: link },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain("within workspaces root");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
      fs.unlinkSync(link);
    }
  });

  it("cwd 白名单 realpath：卷内合法 symlink（指向卷内目录）→ 200（不误伤）", async () => {
    const link = path.join(wsRoot, "in-link");
    fs.symlinkSync(wsDir, link);
    try {
      const res = await app.inject({
        method: "POST", url: "/exec", headers: authHeaders(),
        payload: { cmd: "echo linked-ok", cwd: link },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().stdout).toContain("linked-ok");
    } finally {
      fs.unlinkSync(link);
    }
  });

  it("超时强杀：timeout=200ms → SIGKILL 进程组 + timedOut=true + exitCode 137", async () => {
    const start = Date.now();
    const res = await app.inject({
      method: "POST", url: "/exec", headers: authHeaders(),
      payload: { cmd: "sleep 30", cwd: wsDir, timeout: 200 },
    });
    const elapsed = Date.now() - start;
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.timedOut).toBe(true);
    expect(body.exitCode).toBe(137); // 128 + SIGKILL(9)
    expect(elapsed).toBeLessThan(5000);
  });

  it("非法 body：cmd 非字符串/数组 → 400；timeout 非正数 → 400", async () => {
    const r1 = await app.inject({
      method: "POST", url: "/exec", headers: authHeaders(),
      payload: { cmd: 123, cwd: wsDir },
    });
    expect(r1.statusCode).toBe(400);
    const r2 = await app.inject({
      method: "POST", url: "/exec", headers: authHeaders(),
      payload: { cmd: "echo x", cwd: wsDir, timeout: -5 },
    });
    expect(r2.statusCode).toBe(400);
  });

  it("流式：stream:true → {execId}，完成后 GET /exec/:id/stream 重放 SSE（output+done）", async () => {
    const res = await app.inject({
      method: "POST", url: "/exec", headers: authHeaders(),
      payload: { cmd: "echo streamed", cwd: wsDir, stream: true },
    });
    expect(res.statusCode).toBe(200);
    const { execId } = res.json();
    expect(execId).toBeTruthy();

    // 轮询状态端点直到 done
    let done = false;
    for (let i = 0; i < 200; i++) {
      const st = await app.inject({ method: "GET", url: `/exec/${execId}`, headers: authHeaders() });
      if (st.json().status === "done") { done = true; break; }
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(done).toBe(true);

    const stream = await app.inject({ method: "GET", url: `/exec/${execId}/stream`, headers: authHeaders() });
    expect(stream.statusCode).toBe(200);
    expect(stream.headers["content-type"]).toContain("text/event-stream");
    expect(stream.body).toContain("event: output");
    expect(stream.body).toContain("streamed");
    expect(stream.body).toContain("event: done");
    expect(stream.body).toContain('"exitCode":0');
  });

  it("流式任务 404：未知 execId → 404", async () => {
    const res = await app.inject({ method: "GET", url: "/exec/nope/stream", headers: authHeaders() });
    expect(res.statusCode).toBe(404);
  });
});
