import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildKernelHostApp,
  createSandboxGrantIssuer,
  createSandboxGrantVerifier,
  sandboxGrantToHeader,
} from "@away_from/pth-sandbox";
import type { FastifyInstance } from "fastify";

/**
 * P4：persistent /sessions 宿主（2026-08-22 裁决）
 *  - wire body 不变；x-sandbox-kernel-lang + x-sandbox-grant 私有头会话层绑定
 *  - snapshot 只导出；reset 仅支持回初始；reset(snapshotId) = MODE_NOT_SUPPORTED
 */

const SECRET = "test-session-secret";
const GRANT_SECRET = "session-grant-secret-0123456789";
const issuer = createSandboxGrantIssuer({ secret: GRANT_SECRET });

function makeGrant(taskId = "task-session", tenantId = "tenant-a") {
  return issuer.issue({
    lease: { taskId, leaseId: "aa7d7e7e-c3ec-4e58-b34d-2f6a2a70e000", generation: 1 },
    scope: { tenantId, principalId: "worker:developer", roles: ["developer"], traceId: "trace-session" },
    workspace: { tenantId, workspaceId: "ws-session", taskId },
    language: "python",
    capabilities: ["memory.read"],
  });
}

let app: FastifyInstance;

beforeAll(async () => {
  app = buildKernelHostApp({
    getSecret: () => SECRET,
    grantVerifier: createSandboxGrantVerifier({ secret: GRANT_SECRET }),
    registerSessions: true,
    poolSize: 6,
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

function headers(lang = "python", grant = makeGrant()): Record<string, string> {
  return {
    authorization: `Bearer ${SECRET}`,
    "content-type": "application/json",
    "x-sandbox-kernel-lang": lang,
    "x-sandbox-grant": sandboxGrantToHeader(grant),
  };
}

describe("kernel persistent /sessions（P4）", () => {
  it("create 校验私有头（lang/grant）并盖章绑定；缺 grant 401、缺 lang 400", async () => {
    const missingGrant = await app.inject({ method: "POST", url: "/sessions", headers: { ...headers(), "x-sandbox-grant": "" }, payload: {} });
    expect(missingGrant.statusCode).toBe(401);
    expect(missingGrant.json()).toMatchObject({ error: { code: "UNAUTHORIZED" } });

    const missingLang = await app.inject({ method: "POST", url: "/sessions", headers: { ...headers(), "x-sandbox-kernel-lang": "lua" }, payload: {} });
    expect(missingLang.statusCode).toBe(400);
    expect(missingLang.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });

    const created = await app.inject({ method: "POST", url: "/sessions", headers: headers(), payload: { leaseMs: 30_000 } });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ status: "active", leaseMs: 30_000 });
  });

  it("execute 在真实 python 内核上执行并续租；wire 不回传内部 lease id", async () => {
    const created = await app.inject({ method: "POST", url: "/sessions", headers: headers(), payload: {} });
    const { sessionId } = created.json() as { sessionId: string };
    expect(JSON.stringify(created.json())).not.toMatch(/leaseId|kernelId/);

    const exec = await app.inject({
      method: "POST",
      url: `/sessions/${sessionId}/execute`,
      headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
      payload: { cmd: "print('session-ok')" },
    });
    expect(exec.statusCode).toBe(200);
    expect(exec.json()).toMatchObject({ sessionId, exitCode: 0, stdout: expect.stringContaining("session-ok") });

    const got = await app.inject({ method: "GET", url: `/sessions/${sessionId}`, headers: { authorization: `Bearer ${SECRET}` } });
    expect(got.json()).toMatchObject({ status: "active", lastResult: { exitCode: 0 } });
  });

  it("grant 绑定：execute 带不同任务 grant → 403；不带 grant 沿用创建时绑定", async () => {
    const created = await app.inject({ method: "POST", url: "/sessions", headers: headers("python", makeGrant("task-a")), payload: {} });
    expect(created.statusCode).toBe(200);
    const { sessionId } = created.json() as { sessionId: string };

    const wrong = await app.inject({
      method: "POST",
      url: `/sessions/${sessionId}/execute`,
      headers: { ...headers("python", makeGrant("task-b")), "content-type": "application/json" },
      payload: { cmd: "print(1)" },
    });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json()).toMatchObject({ error: { code: "UNAUTHORIZED" } });

    const noGrant = await app.inject({
      method: "POST",
      url: `/sessions/${sessionId}/execute`,
      headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
      payload: { cmd: "print(2)" },
    });
    expect(noGrant.statusCode).toBe(200);
    expect(noGrant.json()).toMatchObject({ exitCode: 0 });
  });

  it("snapshot 只导出；reset() 回初始；reset(snapshotId) → MODE_NOT_SUPPORTED", async () => {
    const created = await app.inject({ method: "POST", url: "/sessions", headers: headers(), payload: {} });
    expect(created.statusCode).toBe(200);
    const { sessionId } = created.json() as { sessionId: string };

    await app.inject({ method: "POST", url: `/sessions/${sessionId}/execute`, headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" }, payload: { cmd: "carry = 123" } });
    const snap = await app.inject({ method: "POST", url: `/sessions/${sessionId}/snapshot`, headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" }, payload: { tag: "t1" } });
    expect(snap.statusCode).toBe(200);
    const snapBody = snap.json() as { snapshotId: string; tag?: string };
    expect(snapBody).toMatchObject({ sessionId, tag: "t1" });
    expect(snapBody.snapshotId).toMatch(/^[0-9a-f-]{36}$/);

    const restore = await app.inject({ method: "POST", url: `/sessions/${sessionId}/reset`, headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" }, payload: { snapshotId: snapBody.snapshotId } });
    expect(restore.statusCode).toBe(400);
    expect(restore.json()).toMatchObject({ error: { code: "MODE_NOT_SUPPORTED" } });

    const reset = await app.inject({ method: "POST", url: `/sessions/${sessionId}/reset`, headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" }, payload: {} });
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toEqual({ ok: true });

    const after = await app.inject({ method: "POST", url: `/sessions/${sessionId}/execute`, headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" }, payload: { cmd: "print(carry)" } });
    expect(after.json()).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("NameError") });
  });

  it("release 幂等并归还池条目；released 后 execute → SESSION_EXPIRED", async () => {
    const created = await app.inject({ method: "POST", url: "/sessions", headers: headers(), payload: {} });
    expect(created.statusCode).toBe(200);
    const { sessionId } = created.json() as { sessionId: string };

    const release = await app.inject({ method: "POST", url: `/sessions/${sessionId}/release`, headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" }, payload: {} });
    expect(release.statusCode).toBe(200);
    expect(release.json()).toEqual({ ok: true });

    const exec = await app.inject({ method: "POST", url: `/sessions/${sessionId}/execute`, headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" }, payload: { cmd: "print(1)" } });
    expect(exec.statusCode).toBe(400);
    expect(exec.json()).toMatchObject({ error: { code: "SESSION_EXPIRED" } });
  });

  it("会话受共享密钥保护：无 Bearer → 401", async () => {
    const res = await app.inject({ method: "POST", url: "/sessions", payload: {} });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: "UNAUTHORIZED" } });
  });
});
