import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildExecApp } from "@away_from/pth-sandbox";
import { EXECUTION_WIRE } from "@away_from/shared/execution";

const SECRET = "secret-123";
function authHeaders() {
  return { authorization: `Bearer ${SECRET}` };
}

function makeApp() {
  const wsRoot = mkdtempSync(join(tmpdir(), "exec-v1-"));
  const app = buildExecApp({ workspacesRoot: wsRoot, getSecret: () => SECRET });
  return { app, wsRoot };
}

describe("execution/v1 alignment（P1）", () => {
  it("GET /capabilities 声明 sandbox 能力（认证保护）", async () => {
    const { app, wsRoot } = makeApp();
    try {
      const unauthorized = await app.inject({ method: "GET", url: EXECUTION_WIRE.paths.capabilities });
      expect(unauthorized.statusCode).toBe(401);
      const ok = await app.inject({ method: "GET", url: EXECUTION_WIRE.paths.capabilities, headers: authHeaders() });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toEqual({
        version: "execution/v1",
        streaming: true,
        cancel: true,
        cwdWhitelist: true,
        uidIsolation: true,
        egressLocked: true,
        pathMapping: false,
      });
    } finally {
      await app.close();
      rmSync(wsRoot, { recursive: true, force: true });
    }
  });

  it("规范字段 timeoutMs 生效；旧字段 timeout 过渡兼容", async () => {
    const { app, wsRoot } = makeApp();
    try {
      const canonical = await app.inject({
        method: "POST",
        url: EXECUTION_WIRE.paths.exec,
        headers: authHeaders(),
        payload: { cmd: "echo ok", cwd: wsRoot, timeoutMs: 1000 },
      });
      expect(canonical.statusCode).toBe(200);
      expect(canonical.json()).toMatchObject({ exitCode: 0, timedOut: false });
      const legacy = await app.inject({
        method: "POST",
        url: EXECUTION_WIRE.paths.exec,
        headers: authHeaders(),
        payload: { cmd: "echo legacy", cwd: wsRoot, timeout: 1000 },
      });
      expect(legacy.statusCode).toBe(200);
      expect(legacy.json()).toMatchObject({ exitCode: 0, timedOut: false });
    } finally {
      await app.close();
      rmSync(wsRoot, { recursive: true, force: true });
    }
  });

  it("profile 不得自我提升；pathMapping 按能力声明拒绝", async () => {
    const { app, wsRoot } = makeApp();
    try {
      const promoted = await app.inject({
        method: "POST",
        url: EXECUTION_WIRE.paths.exec,
        headers: authHeaders(),
        payload: { cmd: "true", cwd: wsRoot, profile: "host" },
      });
      expect(promoted.statusCode).toBe(400);
      const allowed = await app.inject({
        method: "POST",
        url: EXECUTION_WIRE.paths.exec,
        headers: authHeaders(),
        payload: { cmd: "true", cwd: wsRoot, profile: "sandbox-untrusted" },
      });
      expect(allowed.statusCode).toBe(200);
      const mapped = await app.inject({
        method: "POST",
        url: EXECUTION_WIRE.paths.exec,
        headers: authHeaders(),
        payload: { cmd: "true", cwd: wsRoot, pathMapping: { hostRoot: "/h", execRoot: "/e" } },
      });
      expect(mapped.statusCode).toBe(400);
    } finally {
      await app.close();
      rmSync(wsRoot, { recursive: true, force: true });
    }
  });

  it("POST /exec/:id/cancel 终止在飞 stream 任务（SIGKILL 进程组）", async () => {
    const { app, wsRoot } = makeApp();
    try {
      const start = await app.inject({
        method: "POST",
        url: EXECUTION_WIRE.paths.exec,
        headers: authHeaders(),
        payload: { cmd: "sleep 30", cwd: wsRoot, stream: true, timeoutMs: 30_000 },
      });
      expect(start.statusCode).toBe(200);
      const { execId } = start.json() as { execId: string };
      const cancel = await app.inject({
        method: "POST",
        url: `/exec/${execId}/cancel`,
        headers: authHeaders(),
      });
      expect(cancel.statusCode).toBe(200);
      expect(cancel.json()).toEqual({ ok: true });

      let state: any;
      for (let i = 0; i < 50; i += 1) {
        state = (
          await app.inject({ method: "GET", url: `/exec/${execId}`, headers: authHeaders() })
        ).json();
        if (state.status === "done") break;
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(state.status).toBe("done");
      expect(state.result.signal).toBe("SIGKILL");
      expect(state.result.exitCode).toBe(137);
    } finally {
      await app.close();
      rmSync(wsRoot, { recursive: true, force: true });
    }
  });
});
