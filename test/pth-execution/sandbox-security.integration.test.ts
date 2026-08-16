/**
 * sandbox hostile integration matrix（S2-3，当前协议骨架）
 *
 * 门控：PTH_SANDBOX_INTEGRATION=1 + 本机 docker 可用才真正执行；无门控时全部 skip。
 * 设计：独立 compose project name + 临时端口 override（避开生产拓扑的 3000 端口与卷），
 *       只对当前已落地的 P0/lease 协议做断言；grant / cancel-ack-release / 完整跨租户矩阵
 *       在 v2 P2 落地后由 S2-5 收账补全（见文件内 P2_TODO）。
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

const RUN = process.env.PTH_SANDBOX_INTEGRATION === "1";
const MATRIX_SECRET = `matrix-secret-${randomUUID()}`;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const COMPOSE_FILE = path.join(ROOT, "deploy", "docker-compose.yaml");
let PROJECT = "";
let OVERRIDE_FILE = "";
let OVERRIDE_DIR = "";

function composeEnv(): NodeJS.ProcessEnv {
  return { ...process.env, SANDBOX_SHARED_SECRET: MATRIX_SECRET, PTH_MEMORY_BRIDGE_TOKEN: "" };
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
function sandboxHttp(method: "GET" | "POST", urlPath: string, payload?: unknown): { status: number; body: string } {
  const curl = payload === undefined
    ? `curl -s -w '\\n%{http_code}' -X ${method} -H "Authorization: Bearer ${MATRIX_SECRET}" http://localhost:8080${urlPath}`
    : `curl -s -w '\\n%{http_code}' -X ${method} -H "Authorization: Bearer ${MATRIX_SECRET}" -H 'content-type: application/json' --data '${JSON.stringify(payload).replace(/'/g, `'\\''`)}' http://localhost:8080${urlPath}`;
  const out = compose(["exec", "-T", "sandbox", "sh", "-c", curl]).trimEnd();
  const cut = out.lastIndexOf("\n");
  const body = cut >= 0 ? out.slice(0, cut) : "";
  const status = Number(out.slice(cut + 1).trim() || 0);
  return { status, body };
}

describe.skipIf(!RUN)("sandbox hostile integration matrix（当前协议骨架）", () => {
  beforeAll(async () => {
    OVERRIDE_DIR = mkdtempSync(path.join(tmpdir(), "pth-sandbox-matrix-"));
    OVERRIDE_FILE = path.join(OVERRIDE_DIR, "compose.override.yaml");
    PROJECT = `pth-sandbox-matrix-${process.pid}`;
    // 避开生产 3000 端口：pi-platform 只绑 loopback 随机高位端口（矩阵只用 sandbox loopback 与容器网络）
    writeFileSync(
      OVERRIDE_FILE,
      [
        "services:",
        "  pi-platform:",
        "    ports:",
        `      - "127.0.0.1::3000"`,
        "",
      ].join("\n"),
      "utf8",
    );
    compose(["up", "-d", "--wait"]);
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
    expect(out).toBeNull();
  });

  it("矩阵 3：workload env 不含控制器密钥/数据库凭据（allowlist 生效）", () => {
    const res = sandboxHttp("POST", "/exec", { cmd: ["env"] });
    expect(res.status).toBe(200);
    expect(res.body).not.toContain(MATRIX_SECRET);
    expect(res.body).not.toContain("PTH_MEMORY_BRIDGE_TOKEN");
    expect(res.body).not.toContain("DATABASE_URL");
  });

  it("矩阵 4a：可预测 kernelId 协议已退役（必须 lease）", () => {
    const res = sandboxHttp("POST", "/kernel/execute", { kernelId: "py-1", code: "1 + 1" });
    expect(res.status).toBe(400);
    expect(res.body).toContain("kernelId retired");
  });

  it("矩阵 4b：grant verifier 未配置时 /kernel/acquire fail-closed 503（P2-2）", () => {
    // 当前 compose 尚未注入 PTH_EXECUTION_GRANT_SECRET（P2 阶段进行中）——按 P2-2 语义必须 503。
    const res = sandboxHttp("POST", "/kernel/acquire", { lang: "python" });
    expect(res.status).toBe(503);
    expect(res.body).toContain("grant verifier not configured");
  });

  it("矩阵 4c：记忆桥 token 缺失 → fail-closed 503（body 自报 space 无效）", () => {
    const res = sandboxHttp("POST", "/kernel/memory-bridge", { op: "get", id: "x", space: "dev" });
    expect(res.status).toBe(503);
    expect(res.body).toContain("PTH_MEMORY_BRIDGE_TOKEN not set");
  });

  // ── P2_TODO：以下矩阵列待 v2 P2 落地后启用（S2-5 收账时补）────────────
  it.skip("P2_TODO 矩阵 2：malformed/expired/replay grant 全部拒绝", () => {});
  it.skip("P2_TODO 矩阵 4d：签名 grant → 不可预测 UUID lease；release 后 stale lease 被拒", () => {});
  it.skip("P2_TODO 矩阵 5：cancel/abort/timeout 后活跃 REPL 不被重发", () => {});
  it.skip("P2_TODO 矩阵 6：递归后代收割 + 输出 flood 截断 + 资源回落", () => {});
  it.skip("P2_TODO 矩阵 7：租户 A 对租户 B workspace/memory/transcript 零读取", () => {});
});
