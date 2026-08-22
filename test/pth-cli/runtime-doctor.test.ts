import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseDoctorArgs,
  runDoctor,
  type DoctorRunResult,
  type DoctorRunner,
} from "../../src/cli/runtime/runtime-doctor.js";

const SECRETS = [
  "SANDBOX_SHARED_SECRET=sandbox-secret-000000000000000000000000",
  "PTH_EXECUTION_GRANT_SECRET=grant-secret-000000000000000000000000",
  "PTH_MEMORY_BRIDGE_TOKEN=memory-bridge-token-000000000000000000",
  "POSTGRES_PASSWORD=pg-password-0000000000000000000000000000",
  "REDIS_PASSWORD=redis-password-00000000000000000000000000",
  "LOCAL_EXEC_SHARED_SECRET=local-exec-secret-00000000000000000000",
  "JUPYTER_SERVICE_TOKEN=jupyter-service-token-000000000000000000",
].join("\n");

async function makeRepo(): Promise<{ repoRoot: string; cleanup: () => Promise<void> }> {
  const repoRoot = await mkdtemp(join(tmpdir(), "pth-doctor-"));
  await mkdir(join(repoRoot, "deploy", "tool-containers"), { recursive: true });
  await mkdir(join(repoRoot, "deploy", "local-exec", "u8"), { recursive: true });
  await writeFile(join(repoRoot, "deploy", ".env.pth.secrets"), SECRETS);
  await writeFile(join(repoRoot, "deploy", "tool-containers", "tool-manifest.json"), JSON.stringify({ version: 1, domains: { compiled: {} } }));
  return { repoRoot, cleanup: async () => { /* tmpdir 由系统清理；测试进程内不删除，避免 Windows 句柄问题 */ } };
}

interface FakeCase { cmd: string; argv: string[]; run: () => DoctorRunResult }

function fakeRunner(cases: FakeCase[], fallback: () => DoctorRunResult = () => ({ code: 0, stdout: "", stderr: "" })): DoctorRunner {
  return async (cmd, argv) => {
    for (const c of cases) {
      if (c.cmd === cmd && JSON.stringify(c.argv) === JSON.stringify(argv)) return c.run();
    }
    return fallback();
  };
}

const upRunner = () => fakeRunner([
  { cmd: "docker", argv: ["version"], run: () => ({ code: 0, stdout: "Docker", stderr: "" }) },
  { cmd: "docker", argv: ["compose", "version"], run: () => ({ code: 0, stdout: "v2", stderr: "" }) },
  { cmd: "docker", argv: ["image", "inspect", "pi-triple-pth:latest"], run: () => ({ code: 0, stdout: "[]", stderr: "" }) },
], () => ({ code: 0, stdout: "", stderr: "" }));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseDoctorArgs", () => {
  it("缺省 profile=core", () => {
    expect(parseDoctorArgs([])).toEqual({ profile: "core", json: false });
  });
  it("解析 --profile 与 --json", () => {
    expect(parseDoctorArgs(["--profile", "full", "--json"])).toEqual({ profile: "full", json: true });
  });
  it("拒绝未知 profile", () => {
    expect(() => parseDoctorArgs(["--profile", "nope"])).toThrow(/unknown profile/);
  });
});

describe("runDoctor", () => {
  it("core 全通过（docker/secrets/workspaces/镜像/端口）", async () => {
    const { repoRoot } = await makeRepo();
    const env = { PTH_WORKSPACES_HOST: repoRoot };
    const report = await runDoctor([], { repoRoot, env, runner: upRunner() });
    expect(report.ok).toBe(true);
    expect(report.items.filter((i) => i.status === "fail")).toHaveLength(0);
    expect(report.items.some((i) => i.check === "secrets" && i.status === "pass")).toBe(true);
  });

  it("docker 不可用 → 阻断并给修复命令", async () => {
    const { repoRoot } = await makeRepo();
    const env = { PTH_WORKSPACES_HOST: repoRoot };
    const report = await runDoctor([], {
      repoRoot,
      env,
      runner: fakeRunner([
        { cmd: "docker", argv: ["version"], run: () => ({ code: 1, stdout: "", stderr: "no docker" }) },
      ]),
    });
    expect(report.ok).toBe(false);
    expect(report.items.find((i) => i.check === "docker")?.fix).toContain("Docker");
  });

  it("核心密钥缺失 → 阻断并提示 pth init", async () => {
    const { repoRoot } = await makeRepo();
    await writeFile(join(repoRoot, "deploy", ".env.pth.secrets"), "SANDBOX_SHARED_SECRET=x\nPTH_MEMORY_BRIDGE_TOKEN=y\nPOSTGRES_PASSWORD=z\nREDIS_PASSWORD=w\n");
    const env = { PTH_WORKSPACES_HOST: repoRoot };
    const report = await runDoctor([], { repoRoot, env, runner: upRunner() });
    expect(report.ok).toBe(false);
    const secrets = report.items.find((i) => i.check === "secrets");
    expect(secrets?.message).toContain("PTH_EXECUTION_GRANT_SECRET");
    expect(secrets?.fix).toContain("pth init");
  });

  it("PTH_WORKSPACES_HOST 缺失 → 阻断并提示 export", async () => {
    const { repoRoot } = await makeRepo();
    const report = await runDoctor([], { repoRoot, env: {}, runner: upRunner() });
    expect(report.ok).toBe(false);
    expect(report.items.find((i) => i.check === "workspaces")?.fix).toContain("export PTH_WORKSPACES_HOST");
  });

  it("lean4 profile 触发 lean 检查（缺失=警告不阻断）", async () => {
    const { repoRoot } = await makeRepo();
    const env = { PTH_WORKSPACES_HOST: repoRoot };
    const report = await runDoctor(["--profile", "lean4"], {
      repoRoot,
      env,
      runner: fakeRunner([
        { cmd: "docker", argv: ["version"], run: () => ({ code: 0, stdout: "", stderr: "" }) },
        { cmd: "docker", argv: ["compose", "version"], run: () => ({ code: 0, stdout: "", stderr: "" }) },
        { cmd: "lean", argv: ["--version"], run: () => ({ code: 1, stdout: "", stderr: "not found" }) },
      ]),
    });
    const lean = report.items.find((i) => i.check === "lean4-toolchain");
    expect(lean?.status).toBe("warn");
    expect(lean?.fix).toContain("elan");
    expect(report.ok).toBe(true);
  });

  it("u8 profile：二进制已构建 → pass", async () => {
    const { repoRoot } = await makeRepo();
    const u8 = join(repoRoot, "deploy", "local-exec", "u8", "u8");
    await writeFile(u8, "#!/bin/sh\necho u8\n");
    await chmod(u8, 0o755);
    const env = { PTH_WORKSPACES_HOST: repoRoot };
    const report = await runDoctor(["--profile", "u8"], { repoRoot, env, runner: upRunner() });
    expect(report.items.find((i) => i.check === "u8-toolchain")?.status).toBe("pass");
  });

  it("jupyter profile 检查 8888 与 jupyter 镜像（缺失=警告）", async () => {
    const { repoRoot } = await makeRepo();
    const env = { PTH_WORKSPACES_HOST: repoRoot };
    const report = await runDoctor(["--profile", "jupyter"], {
      repoRoot,
      env,
      runner: fakeRunner([
        { cmd: "docker", argv: ["version"], run: () => ({ code: 0, stdout: "", stderr: "" }) },
        { cmd: "docker", argv: ["compose", "version"], run: () => ({ code: 0, stdout: "", stderr: "" }) },
        { cmd: "docker", argv: ["image", "inspect", "pi-triple-pth:latest"], run: () => ({ code: 0, stdout: "[]", stderr: "" }) },
        { cmd: "docker", argv: ["image", "inspect", "pi-triple-jupyter:dev"], run: () => ({ code: 1, stdout: "", stderr: "missing" }) },
      ]),
    });
    expect(report.items.some((i) => i.check === "port-8888")).toBe(true);
    expect(report.items.find((i) => i.check === "image-jupyter")?.status).toBe("warn");
  });

  it("tools profile 校验 tool-manifest（可解析=pass）", async () => {
    const { repoRoot } = await makeRepo();
    const env = { PTH_WORKSPACES_HOST: repoRoot };
    const report = await runDoctor(["--profile", "tools"], { repoRoot, env, runner: upRunner() });
    expect(report.items.find((i) => i.check === "tools-manifest")?.status).toBe("pass");
  });

  it("数据层未运行 → 警告；运行中的 redis 探活 → pass", async () => {
    const { repoRoot } = await makeRepo();
    const env = { PTH_WORKSPACES_HOST: repoRoot };
    const idle = await runDoctor([], { repoRoot, env, runner: upRunner() });
    expect(idle.items.find((i) => i.check === "data-layer")?.status).toBe("warn");

    const running = await runDoctor([], {
      repoRoot,
      env,
      runner: fakeRunner([
        { cmd: "docker", argv: ["version"], run: () => ({ code: 0, stdout: "", stderr: "" }) },
        { cmd: "docker", argv: ["compose", "version"], run: () => ({ code: 0, stdout: "", stderr: "" }) },
        { cmd: "docker", argv: ["image", "inspect", "pi-triple-pth:latest"], run: () => ({ code: 0, stdout: "[]", stderr: "" }) },
        {
          cmd: "docker",
          argv: ["compose", "--env-file", join(repoRoot, "deploy", ".env.pth.secrets"), "-f", join(repoRoot, "deploy", "docker-compose.yaml"), "ps", "--format", "json"],
          run: () => ({ code: 0, stdout: JSON.stringify({ Service: "redis", State: "running" }), stderr: "" }),
        },
        {
          cmd: "docker",
          argv: ["compose", "--env-file", join(repoRoot, "deploy", ".env.pth.secrets"), "-f", join(repoRoot, "deploy", "docker-compose.yaml"), "exec", "-T", "redis", "sh", "-c", "redis-cli -a \"$REDIS_PASSWORD\" ping"],
          run: () => ({ code: 0, stdout: "PONG", stderr: "" }),
        },
      ]),
    });
    expect(running.items.find((i) => i.check === "data-redis")?.status).toBe("pass");
    expect(running.items.find((i) => i.check === "data-layer")?.status).toBe("pass");
  });

  it("--json 输出报告结构", async () => {
    const { repoRoot } = await makeRepo();
    const env = { PTH_WORKSPACES_HOST: repoRoot };
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const report = await runDoctor(["--json"], { repoRoot, env, runner: upRunner() });
    expect(report.ok).toBe(true);
    expect(log).toHaveBeenCalled();
    const text = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(JSON.parse(text)).toEqual(report);
  });
});
