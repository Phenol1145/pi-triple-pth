import { describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GENERATED_SECRET_KEYS,
  normalizeWorkspacesPath,
  renderSecretsFile,
  runPthInit,
} from "@away_from/pth-console";

const EXAMPLE = `# comment

SANDBOX_SHARED_SECRET=dev-only-change-me-sandbox-secret-0000000000000000
PTH_EXECUTION_GRANT_SECRET=dev-only-change-me-grant-secret-000000000000000000000
PTH_MEMORY_BRIDGE_TOKEN=dev-only-change-me-memory-bridge-token-00000000
POSTGRES_PASSWORD=dev-only-change-me-pg-password-0000000000000000
REDIS_PASSWORD=dev-only-change-me-redis-password-0000000000000000
LOCAL_EXEC_SHARED_SECRET=dev-only-change-me-local-exec-secret-0000000000000000
JUPYTER_SERVICE_TOKEN=dev-only-change-me-jupyter-service-token-000000000000
`;

describe("renderSecretsFile", () => {
  it("generate=true 替换 7 个密钥为 64-hex 且无 dev-only 残留", () => {
    const text = renderSecretsFile(EXAMPLE, {
      generate: true,
      randomHex: (bytes) => "ab".repeat(bytes),
    });
    expect(text).not.toContain("dev-only-change-me");
    for (const key of GENERATED_SECRET_KEYS) {
      const line = text.split("\n").find((l) => l.startsWith(`${key}=`));
      expect(line, key).toBe(`${key}=${"ab".repeat(32)}`);
    }
  });

  it("generate=false 保留原文（旧行为）", () => {
    const text = renderSecretsFile(EXAMPLE, { generate: false });
    expect(text).toBe(EXAMPLE);
    expect(text).toContain("dev-only-change-me");
  });

  it("workspacesHost 提供时追加宿主路径段；省略时不追加", () => {
    const withWs = renderSecretsFile(EXAMPLE, { generate: false, workspacesHost: "/tmp/ws" });
    expect(withWs).toContain("\n# ── 宿主路径（非密钥）──\nPTH_WORKSPACES_HOST=/tmp/ws\n");
    const withoutWs = renderSecretsFile(EXAMPLE, { generate: false });
    expect(withoutWs).not.toContain("PTH_WORKSPACES_HOST=");
  });

  it("注释与空行原样保留", () => {
    const text = renderSecretsFile(EXAMPLE, { generate: true, randomHex: () => "x".repeat(64) });
    const lines = text.split("\n");
    expect(lines[0]).toBe("# comment");
    expect(lines[1]).toBe("");
  });
});

describe("normalizeWorkspacesPath", () => {
  it("展开 ~ 为 home 并接受绝对路径", () => {
    const expanded = normalizeWorkspacesPath("~/ws");
    expect(expanded).toMatch(/^\/.*\/ws$/);
    expect(normalizeWorkspacesPath("/abs/ws")).toBe("/abs/ws");
  });

  it("拒绝相对路径", () => {
    expect(() => normalizeWorkspacesPath("relative/ws")).toThrow(/绝对路径/);
  });
});

describe("runPthInit", () => {
  it("写入自动生成密钥与 PTH_WORKSPACES_HOST，权限 600", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "pth-init-"));
    await mkdir(join(repoRoot, "deploy"), { recursive: true });
    await writeFile(join(repoRoot, "deploy", ".env.pth.secrets.example"), EXAMPLE);
    const ws = join(repoRoot, "workspaces");

    await runPthInit(["--workspaces", ws], { repoRoot });

    const secretsPath = join(repoRoot, "deploy", ".env.pth.secrets");
    const text = await readFile(secretsPath, "utf8");
    expect(text).not.toContain("dev-only-change-me");
    expect(text).toContain(`PTH_WORKSPACES_HOST=${ws}`);
    const mode = (await stat(secretsPath)).mode & 0o777;
    expect(mode).toBe(0o600);
    await chmod(secretsPath, 0o600); // 清理时避免告警
  });
});
