/**
 * sandbox hostile integration matrix（S2-3 定稿）
 *
 * 门控：PTH_SANDBOX_INTEGRATION=1 + 本机 docker 可用才真正执行；无门控时全部 skip。
 * 设计：独立 compose project name + 临时端口 override（避开生产拓扑的 3000 端口与卷）。
 * 覆盖：无宿主发布端口 / workload env 剥离 / kernelId 退役 / grant 签发-过期-错密钥 /
 *       opaque lease / bridge fail-closed；取消竞态/进程组/跨租户矩阵由 S2-5 补全。
 *
 * 运行（一次性拓扑会自动 up/down，不与生产 stack 冲突）：
 *   PTH_SANDBOX_INTEGRATION=1 npx vitest run test/pth-execution/sandbox-security.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createSandboxGrantIssuer } from "@away_from/pth-sandbox";

const RUN = process.env.PTH_SANDBOX_INTEGRATION === "1";
const MATRIX_SECRET = `matrix-secret-${randomUUID()}`;
const MATRIX_GRANT_SECRET = `matrix-grant-secret-${randomUUID()}`;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const COMPOSE_FILE = path.join(ROOT, "deploy", "docker-compose.yaml");
let PROJECT = "";
let OVERRIDE_FILE = "";
let OVERRIDE_DIR = "";

function makeGrant(language = "python") {
  return createSandboxGrantIssuer({ secret: MATRIX_GRANT_SECRET }).issue({
    lease: { taskId: "matrix-task", leaseId: randomUUID(), generation: 1 },
    scope: { tenantId: "matrix-tenant", principalId: "worker:matrix", roles: ["developer"], traceId: "matrix-trace" },
    workspace: { tenantId: "matrix-tenant", workspaceId: "matrix-ws", taskId: "matrix-task" },
    language,
    capabilities: ["memory.read"],
    ttlMs: 60_000,
  });
}

function composeEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    SANDBOX_SHARED_SECRET: MATRIX_SECRET,
    PTH_EXECUTION_GRANT_SECRET: MATRIX_GRANT_SECRET,
    PTH_MEMORY_BRIDGE_TOKEN: "",
  };
}

/** 执行 docker compose；失败抛错（测试用）。 */
function compose(args: string[]): string {
  return execFileSync(
    "docker",
    ["compose", "-p", PROJECT, "-f", COMPOSE_FILE, "-f", OVERRIDE_FILE, ...args],
    { encoding: "utf8", env: composeEnv(), stdio: ["ignore", "pipe", "pipe"] },
  );
}

/** compose 命令可能预期失败（如无发布端口）——返回 null 表示失败。 */
function composeTry(args: string[]): string | null {
  try {
    return compose(args);
  } catch {
    return null;
  }
}

/** 在 sandbox 容器内用 loopback + 共享密钥调 HTTP 端点；返回 { status, body }。 */
function sandboxHttp(method: "GET" | "POST", urlPath: string, payload?: unknown, extraHeaders?: Record<string, string>): { status: number; body: string } {
  const headers = ["-H", `"Authorization: Bearer ${MATRIX_SECRET}"`, ...(extraHeaders ? Object.entries(extraHeaders).flatMap(([k, v]) => ["-H", `"${k}: ${v}"`]) : [])].join(" ");
  const curl = payload === undefined
    ? `curl -s -w '\\n%{http_code}' -X ${method} ${headers} http://localhost:8080${urlPath}`
    : `curl -s -w '\\n%{http_code}' -X ${method} ${headers} -H 'content-type: application/json' --data '${JSON.stringify(payload).replace(/'/g, `'\\''`)}' http://localhost:8080${urlPath}`;
  const out = compose(["exec", "-T", "sandbox", "sh", "-c", curl]).trimEnd();
  const cut = out.lastIndexOf("\n");
  const body = cut >= 0 ? out.slice(0, cut) : "";
  const status = Number(out.slice(cut + 1).trim() || 0);
  return { status, body };
}

/** P4：x-sandbox-grant 私有头 = base64url(JSON grant) */
function grantHeader(grant: unknown): Record<string, string> {
  return {
    "x-sandbox-kernel-lang": "python",
    "x-sandbox-grant": Buffer.from(JSON.stringify(grant), "utf8").toString("base64url"),
  };
}

describe.skipIf(!RUN)("sandbox hostile integration matrix（S2-3 定稿）", () => {
  beforeAll(async () => {
    OVERRIDE_DIR = mkdtempSync(path.join(tmpdir(), "pth-sandbox-matrix-"));
    OVERRIDE_FILE = path.join(OVERRIDE_DIR, "compose.override.yaml");
    PROJECT = `pth-sandbox-matrix-${process.pid}`;
    // 避开生产端口：pi-platform/jupyter 端口全部 reset（矩阵只走容器 loopback 与 internal 网络）
    writeFileSync(
      OVERRIDE_FILE,
      [
        "services:",
        "  pi-platform:",
        "    ports: !reset []",
        "  jupyter:",
        "    ports: !reset []",
        "",
      ].join("\n"),
      "utf8",
    );
    compose(["up", "-d", "--build", "--wait"]);
  }, 600_000);

  afterAll(async () => {
    if (PROJECT && existsSync(OVERRIDE_FILE)) {
      try {
        compose(["down", "-v", "--remove-orphans"]);
      } catch { /* 清理失败不掩盖测试结果 */ }
    }
    if (OVERRIDE_DIR) rmSync(OVERRIDE_DIR, { recursive: true, force: true });
  }, 180_000);

  it("矩阵 1：sandbox 控制面不发布到宿主端口（只走 internal 网络）", () => {
    const out = composeTry(["port", "sandbox", "8080"]);
    // compose v2 对未发布端口的服务返回 "invalid IP:0"（退出码也可能为 0）——两种形态都表示无映射
    expect(out === null || out.includes("invalid IP")).toBe(true);
  });

  it("矩阵 3：workload env 不含控制器密钥/数据库凭据（allowlist 生效）", () => {
    const res = sandboxHttp("POST", "/exec", { cmd: ["env"] });
    expect(res.status).toBe(200);
    expect(res.body).not.toContain(MATRIX_SECRET);
    expect(res.body).not.toContain("PTH_MEMORY_BRIDGE_TOKEN");
    expect(res.body).not.toContain("DATABASE_URL");
  });

  it("矩阵 4a：旧 /kernel/* 租约路由已删除（404），唯一入口 /sessions", () => {
    const legacyExecute = sandboxHttp("POST", "/kernel/execute", { kernelId: "py-1", code: "1 + 1" });
    expect(legacyExecute.status).toBe(404);
    const legacyAcquire = sandboxHttp("POST", "/kernel/acquire", { lang: "python" });
    expect(legacyAcquire.status).toBe(404);
  });

  it("矩阵 4b：/sessions 创建——malformed/错密钥/过期 grant 全部拒绝", () => {
    const malformed = sandboxHttp("POST", "/sessions", {}, grantHeader({ grantId: "x" }));
    expect(malformed.status).toBe(401);
    expect(malformed.body).toContain("grant");

    const wrongKey = createSandboxGrantIssuer({ secret: "wrong-grant-secret-0123456789" }).issue({
      lease: { taskId: "matrix-task", leaseId: randomUUID(), generation: 1 },
      scope: { tenantId: "matrix-tenant", principalId: "worker:matrix", roles: ["developer"], traceId: "matrix-trace" },
      workspace: { tenantId: "matrix-tenant", workspaceId: "matrix-ws", taskId: "matrix-task" },
      language: "python",
      capabilities: ["memory.read"],
      ttlMs: 60_000,
    });
    const wrong = sandboxHttp("POST", "/sessions", {}, grantHeader(wrongKey));
    expect(wrong.status).toBe(401);
    expect(wrong.body).toContain("signature invalid");

    const expiredIssuer = createSandboxGrantIssuer({
      secret: MATRIX_GRANT_SECRET,
      clock: () => new Date(Date.now() - 10_000),
    });
    const expired = expiredIssuer.issue({
      lease: { taskId: "matrix-task", leaseId: randomUUID(), generation: 1 },
      scope: { tenantId: "matrix-tenant", principalId: "worker:matrix", roles: ["developer"], traceId: "matrix-trace" },
      workspace: { tenantId: "matrix-tenant", workspaceId: "matrix-ws", taskId: "matrix-task" },
      language: "python",
      capabilities: ["memory.read"],
      ttlMs: 1_000,
    });
    const expiredRes = sandboxHttp("POST", "/sessions", {}, grantHeader(expired));
    expect(expiredRes.status).toBe(401);
    expect(expiredRes.body).toContain("expired");
  });

  it("矩阵 4d：合法签名 grant → 不可预测 UUID 会话；release 后 execute 被拒（SESSION_EXPIRED）", () => {
    const a = sandboxHttp("POST", "/sessions", {}, grantHeader(makeGrant()));
    const b = sandboxHttp("POST", "/sessions", {}, grantHeader(makeGrant()));
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const sessionA = JSON.parse(a.body) as { sessionId: string };
    const sessionB = JSON.parse(b.body) as { sessionId: string };
    expect(sessionA.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(sessionB.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(sessionA.sessionId).not.toBe(sessionB.sessionId);

    const rel = sandboxHttp("POST", `/sessions/${sessionA.sessionId}/release`, {});
    expect(rel.status).toBe(200);
    const stale = sandboxHttp("POST", `/sessions/${sessionA.sessionId}/execute`, { cmd: "1 + 1" });
    expect(stale.status).toBe(400);
    expect(stale.body).toContain("SESSION_EXPIRED");
  });

  it("矩阵 4c：记忆桥 token 缺失 → fail-closed 503（body 自报 space 无效）", () => {
    const res = sandboxHttp("POST", "/kernel/memory-bridge", { op: "get", id: "x", space: "dev" });
    expect(res.status).toBe(503);
    expect(res.body).toContain("PTH_MEMORY_BRIDGE_TOKEN not set");
  });

  // ── S2-5 后续矩阵：需要更长生命周期/多容器编排的列，收账轮补 ─────────
  it.skip("矩阵 5：cancel/abort/timeout 后活跃 REPL 不被重发", () => {});
  it.skip("矩阵 6：递归后代收割 + 输出 flood 截断 + 资源回落", () => {});
  it.skip("矩阵 7：租户 A 对租户 B workspace/memory/transcript 零读取", () => {});
});
