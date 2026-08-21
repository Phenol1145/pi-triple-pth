/**
 * launcher.test.ts —— pth init/up/down/status/logs（compose 启动器）。
 *
 * 全部通过注入 runner/fetch 测试，不要求本机 Docker；但命令形状与
 * deploy/docker-compose.yaml 的真实调用一致。
 */

import { mkdtemp, mkdir, readFile, stat, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPthLauncher,
  parseComposePs,
  parseEnvFile,
  type ComposeRunResult,
} from "../src/launcher.js";

const SECRET_TEXT = [
  "SANDBOX_SHARED_SECRET=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "PTH_EXECUTION_GRANT_SECRET=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "PTH_MEMORY_BRIDGE_TOKEN=cccccccccccccccccccccccc",
  "POSTGRES_PASSWORD=dddddddddddddddddddddd",
  "REDIS_PASSWORD=eeeeeeeeeeeeeeeeeeeeeeee",
  "# comment",
].join("\n");

const EXAMPLE_TEXT = [
  "SANDBOX_SHARED_SECRET=replace-me-aaaaaaaaaaaaaaaaaaaaaaaaaa",
  "PTH_EXECUTION_GRANT_SECRET=replace-me-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "PTH_MEMORY_BRIDGE_TOKEN=replace-me-cccccccccccccccccccccccccc",
  "POSTGRES_PASSWORD=replace-me",
  "REDIS_PASSWORD=replace-me",
].join("\n");

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeRepo(withSecrets: boolean): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pth-launcher-"));
  dirs.push(dir);
  await mkdir(join(dir, "deploy"), { recursive: true });
  await writeFile(join(dir, "deploy", "docker-compose.yaml"), "name: pi-platform\nservices:\n", "utf8");
  await writeFile(join(dir, "deploy", ".env.pth.secrets.example"), EXAMPLE_TEXT, "utf8");
  if (withSecrets) await writeFile(join(dir, "deploy", ".env.pth.secrets"), SECRET_TEXT, "utf8");
  return dir;
}

interface FakeCall {
  args: string[];
  opts?: { input?: string };
}

function healthyPs(): string {
  return [
    JSON.stringify({ Service: "postgres", State: "running", Health: "healthy" }),
    JSON.stringify({ Service: "redis", State: "running", Health: "healthy" }),
    JSON.stringify({ Service: "pi-platform", State: "running", Health: "healthy" }),
    JSON.stringify({ Service: "sandbox", State: "running", Health: "healthy" }),
  ].join("\n");
}

function fakeFetch(overrides: { version?: boolean } = {}): typeof fetch {
  const calls: string[] = [];
  const fn = (async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push(url);
    const ok = overrides.version === false && url.endsWith("/api/v1/self/version") ? false : true;
    return {
      ok,
      status: ok ? 200 : 401,
      text: async () => url.includes("/health") ? "{\"status\":\"ok\"}" : "{\"version\":\"1.4.0\"}",
      headers: init?.headers,
    };
  }) as unknown as typeof fetch & { calls: string[] };
  fn.calls = calls;
  return fn;
}

function makeLauncher(repoRoot: string, handlers: Record<string, ComposeRunResult>) {
  const calls: FakeCall[] = [];
  const runner = async (args: string[], opts?: { input?: string }): Promise<ComposeRunResult> => {
    calls.push({ args, opts });
    const sub = args.slice(5).join(" ");
    for (const [prefix, result] of Object.entries(handlers)) {
      if (sub.startsWith(prefix)) return result;
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const fetch = fakeFetch();
  const launcher = createPthLauncher({
    repoRoot,
    runner,
    fetch: fetch as never,
    randomToken: () => "a".repeat(64),
  });
  return { launcher, calls, fetch };
}

describe("pth up", () => {
  it("依赖顺序起栈 → 等 healthy → 种 token → health/version 验证", async () => {
    const repoRoot = await makeRepo(true);
    const { launcher, calls, fetch } = makeLauncher(repoRoot, {
      "ps --format json": { code: 0, stdout: healthyPs(), stderr: "" },
    });
    await launcher.up([]);

    const dockerArgs = calls.map((call) => call.args.slice(5).join(" "));
    expect(dockerArgs.indexOf("up -d postgres redis")).toBeLessThan(dockerArgs.indexOf("up -d pi-platform sandbox"));
    expect(dockerArgs).toContain("ps --format json");

    const seed = calls.find((call) => call.args.slice(5).join(" ").startsWith("exec -T redis sh -c"));
    expect(seed).toBeTruthy();
    expect(seed!.args.at(-1)).toContain(`auth:token:${"a".repeat(64)}`);
    expect(seed!.opts?.input).toBe('{"tenantId":"ops","role":"platform-admin"}');
    expect(fetch.calls).toContain("http://127.0.0.1:3000/health");
    expect(fetch.calls).toContain("http://127.0.0.1:3000/api/v1/self/version");
  });

  it("--no-seed-token 跳过种入，且验证只打 /health", async () => {
    const repoRoot = await makeRepo(true);
    const { launcher, calls, fetch } = makeLauncher(repoRoot, {
      "ps --format json": { code: 0, stdout: healthyPs(), stderr: "" },
    });
    await launcher.up(["--no-seed-token"]);
    expect(calls.some((call) => call.args.slice(5).join(" ").startsWith("exec -T redis"))).toBe(false);
    expect(fetch.calls).toContain("http://127.0.0.1:3000/health");
    expect(fetch.calls).not.toContain("http://127.0.0.1:3000/api/v1/self/version");
  });

  it("secrets 缺失 → 拒绝并提示 pth init", async () => {
    const repoRoot = await makeRepo(false);
    const { launcher } = makeLauncher(repoRoot, {});
    await expect(launcher.up([])).rejects.toMatchObject({ code: "SECRETS_MISSING", message: expect.stringContaining("pth -- init") });
  });

  it("secrets 缺必填值 → SECRETS_INCOMPLETE", async () => {
    const repoRoot = await makeRepo(true);
    await writeFile(join(repoRoot, "deploy", ".env.pth.secrets"), "POSTGRES_PASSWORD=\nREDIS_PASSWORD=x\n", "utf8");
    const { launcher } = makeLauncher(repoRoot, {});
    await expect(launcher.up([])).rejects.toMatchObject({ code: "SECRETS_INCOMPLETE" });
  });

  it("服务不 healthy 超时 → HEALTHY_TIMEOUT", async () => {
    const repoRoot = await makeRepo(true);
    const { launcher } = makeLauncher(repoRoot, {
      "ps --format json": {
        code: 0,
        stdout: JSON.stringify({ Service: "postgres", State: "running", Health: "starting" }),
        stderr: "",
      },
    });
    await expect(launcher.up(["--timeout", "1"])).rejects.toMatchObject({ code: "HEALTHY_TIMEOUT" });
  });

  it("非法 tenant/token → fail-closed", async () => {
    const repoRoot = await makeRepo(true);
    const { launcher } = makeLauncher(repoRoot, {
      "ps --format json": { code: 0, stdout: healthyPs(), stderr: "" },
    });
    await expect(launcher.up(["--tenant", "bad tenant"])).rejects.toMatchObject({ code: "TENANT_INVALID" });
    await expect(launcher.up(["--token", "short"])).rejects.toMatchObject({ code: "TOKEN_INVALID" });
  });
});

describe("pth down / status / logs", () => {
  it("down 传 --remove-orphans，--volumes 追加卷清理", async () => {
    const repoRoot = await makeRepo(true);
    const { launcher, calls } = makeLauncher(repoRoot, {});
    await launcher.down(["--volumes"]);
    expect(calls.some((call) => call.args.slice(5).join(" ") === "down --remove-orphans --volumes")).toBe(true);
  });

  it("status 解析 compose ps 并探 /health", async () => {
    const repoRoot = await makeRepo(true);
    const { launcher, fetch } = makeLauncher(repoRoot, {
      "ps --format json": { code: 0, stdout: healthyPs(), stderr: "" },
    });
    await launcher.status([]);
    expect(fetch.calls).toContain("http://127.0.0.1:3000/health");
  });

  it("logs 非 follow 组装 --tail 与服务名", async () => {
    const repoRoot = await makeRepo(true);
    const { launcher, calls } = makeLauncher(repoRoot, {});
    await launcher.logs(["pi-platform", "--tail", "20"]);
    expect(calls.some((call) => call.args.slice(5).join(" ") === "logs --tail 20 pi-platform")).toBe(true);
  });
});

describe("pth init / 解析函数", () => {
  it("init 复制 example + chmod 600；已存在需 --force", async () => {
    const repoRoot = await makeRepo(false);
    const { launcher } = makeLauncher(repoRoot, {});
    await launcher.init([]);
    const secrets = join(repoRoot, "deploy", ".env.pth.secrets");
    expect(await readFile(secrets, "utf8")).toBe(EXAMPLE_TEXT);
    expect((await stat(secrets)).mode & 0o777).toBe(0o600);
    await expect(launcher.init([])).rejects.toMatchObject({ code: "INIT_FAILED" });
    await launcher.init(["--force"]);
  });

  it("parseEnvFile 处理 export/注释/空行", () => {
    expect(parseEnvFile("A=1\nexport B=2\n# C=3\n\nD=4")).toEqual({ A: "1", B: "2", D: "4" });
  });

  it("parseComposePs 兼容 Service/State/Health 字段", () => {
    expect(parseComposePs(healthyPs())).toHaveLength(4);
    expect(parseComposePs(healthyPs())[0]).toMatchObject({ service: "postgres", state: "running", health: "healthy" });
  });
});
