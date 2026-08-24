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

  it("PTH_WORKSPACES_HOST 缺失 → 阻断并提示 pth init --workspaces", async () => {
    const { repoRoot } = await makeRepo();
    const report = await runDoctor([], { repoRoot, env: {}, runner: upRunner() });
    expect(report.ok).toBe(false);
    expect(report.items.find((i) => i.check === "workspaces")?.fix).toContain("pth init --workspaces");
  });

  it("env 缺失但 secrets 文件含 PTH_WORKSPACES_HOST → pass", async () => {
    const { repoRoot } = await makeRepo();
    await writeFile(join(repoRoot, "deploy", ".env.pth.secrets"), `${SECRETS}\nPTH_WORKSPACES_HOST=${repoRoot}\n`);
    const report = await runDoctor([], { repoRoot, env: {}, runner: upRunner() });
    const workspaces = report.items.find((i) => i.check === "workspaces");
    expect(workspaces?.status).toBe("pass");
    expect(workspaces?.message).toContain(repoRoot);
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

  it("container-runtime：docker 可用（generic）→ pass", async () => {
    const { repoRoot } = await makeRepo();
    const env = { PTH_WORKSPACES_HOST: repoRoot };
    const report = await runDoctor([], { repoRoot, env, runner: upRunner() });
    const item = report.items.find((i) => i.check === "container-runtime");
    expect(item?.status).toBe("pass");
    expect(item?.message).toContain("docker-generic");
  });

  it("container-runtime：仅 apple container → fail 且修复提示", async () => {
    const { repoRoot } = await makeRepo();
    const env = { PTH_WORKSPACES_HOST: repoRoot };
    const report = await runDoctor([], {
      repoRoot,
      env,
      runner: fakeRunner([
        { cmd: "docker", argv: ["version"], run: () => ({ code: 1, stdout: "", stderr: "no docker" }) },
        { cmd: "container", argv: ["--version"], run: () => ({ code: 0, stdout: "container 1.0", stderr: "" }) },
      ]),
    });
    const item = report.items.find((i) => i.check === "container-runtime");
    expect(item?.status).toBe("fail");
    expect(item?.fix).toContain("Docker Desktop / OrbStack / Colima");
  });

  it("--runtime 覆盖检测结果；非法值 fail-fast", async () => {
    const { repoRoot } = await makeRepo();
    const env = { PTH_WORKSPACES_HOST: repoRoot };
    const report = await runDoctor(["--runtime", "colima"], { repoRoot, env, runner: upRunner() });
    const item = report.items.find((i) => i.check === "container-runtime");
    expect(item?.status).toBe("pass");
    expect(item?.message).toContain("colima");
    await expect(runDoctor(["--runtime", "bogus"], { repoRoot, env, runner: upRunner() })).rejects.toThrow(/unknown runtime/);
  });

  it("colima + lean4：host 寻址开启 → pass", async () => {
    const { repoRoot } = await makeRepo();
    const env = { PTH_WORKSPACES_HOST: repoRoot };
    const report = await runDoctor(["--runtime", "colima", "--profile", "lean4"], {
      repoRoot,
      env,
      runner: fakeRunner([
        { cmd: "colima", argv: ["status"], run: () => ({ code: 0, stdout: "colima is running\nnetworkAddress: 192.168.5.2\n", stderr: "" }) },
      ], () => ({ code: 0, stdout: "", stderr: "" })),
    });
    const item = report.items.find((i) => i.check === "colima-host-addressing");
    expect(item?.status).toBe("pass");
  });

  it("colima + u8：host 寻址显式未开启 → fail + 修复命令", async () => {
    const { repoRoot } = await makeRepo();
    const env = { PTH_WORKSPACES_HOST: repoRoot };
    const report = await runDoctor(["--runtime", "colima", "--profile", "u8"], {
      repoRoot,
      env,
      runner: fakeRunner([
        { cmd: "colima", argv: ["status"], run: () => ({ code: 0, stdout: "colima is running\nnetworkAddress:\n", stderr: "" }) },
      ], () => ({ code: 0, stdout: "", stderr: "" })),
    });
    const item = report.items.find((i) => i.check === "colima-host-addressing");
    expect(item?.status).toBe("fail");
    expect(item?.fix).toContain("colima start --network-address");
  });

  it("colima + lean4：status 不可判定 → warn（不误伤）", async () => {
    const { repoRoot } = await makeRepo();
    const env = { PTH_WORKSPACES_HOST: repoRoot };
    const report = await runDoctor(["--runtime", "colima", "--profile", "lean4"], {
      repoRoot,
      env,
      runner: fakeRunner([
        { cmd: "colima", argv: ["status"], run: () => ({ code: 1, stdout: "", stderr: "not running" }) },
      ], () => ({ code: 0, stdout: "", stderr: "" })),
    });
    const item = report.items.find((i) => i.check === "colima-host-addressing");
    expect(item?.status).toBe("warn");
  });

  it("非 colima 或 profile 不含 lean/u8 不触发 colima-host-addressing", async () => {
    const { repoRoot } = await makeRepo();
    const env = { PTH_WORKSPACES_HOST: repoRoot };
    const nonColima = await runDoctor(["--runtime", "orbstack", "--profile", "lean4"], { repoRoot, env, runner: upRunner() });
    expect(nonColima.items.some((i) => i.check === "colima-host-addressing")).toBe(false);
    const core = await runDoctor(["--runtime", "colima", "--profile", "core"], {
      repoRoot,
      env,
      runner: fakeRunner([], () => ({ code: 0, stdout: "", stderr: "" })),
    });
    expect(core.items.some((i) => i.check === "colima-host-addressing")).toBe(false);
  });

  it("local-process：docker 缺失不阻断，但 dist/URL 缺失会阻断", async () => {
    const { repoRoot } = await makeRepo();
    await mkdir(join(repoRoot, "dist", "pth"), { recursive: true });
    await mkdir(join(repoRoot, "packages", "pth-sandbox", "dist"), { recursive: true });
    await writeFile(join(repoRoot, "dist", "pth", "main.js"), "// engine");
    await writeFile(join(repoRoot, "packages", "pth-sandbox", "dist", "main.js"), "// sandbox");
    const env = { PTH_WORKSPACES_HOST: repoRoot };
    const report = await runDoctor(["--target", "local-process", "--profile", "core", "--sandbox", "none"], {
      repoRoot,
      env,
      runner: fakeRunner([
        { cmd: "docker", argv: ["version"], run: () => ({ code: 1, stdout: "", stderr: "no docker" }) },
      ]),
    });
    expect(report.items.find((i) => i.check === "docker")?.status).toBe("warn");
    expect(report.items.some((i) => i.check === "image-engine")).toBe(false);
    expect(report.items.find((i) => i.check === "engine-dist")?.status).toBe("pass");
    expect(report.items.find((i) => i.check === "data-redis")?.status).toBe("fail");
    expect(report.items.find((i) => i.check === "data-postgres")?.status).toBe("fail");
  });

  it("local-process + tools profile → target-compat fail", async () => {
    const { repoRoot } = await makeRepo();
    const env = { PTH_WORKSPACES_HOST: repoRoot };
    const report = await runDoctor(["--target", "local-process", "--profile", "tools"], {
      repoRoot,
      env,
      runner: fakeRunner([], () => ({ code: 0, stdout: "", stderr: "" })),
    });
    const item = report.items.find((i) => i.check === "target-compat");
    expect(item?.status).toBe("fail");
    expect(item?.fix).toContain("--without tools");
  });

  it("local-process sandbox=process 检查 port-8080；sandbox=none 不检查", async () => {
    const { repoRoot } = await makeRepo();
    const env = { PTH_WORKSPACES_HOST: repoRoot };
    const withSandbox = await runDoctor(["--target", "local-process", "--profile", "core", "--sandbox", "process"], {
      repoRoot,
      env,
      runner: fakeRunner([], () => ({ code: 0, stdout: "", stderr: "" })),
    });
    expect(withSandbox.items.some((i) => i.check === "port-8080")).toBe(true);
    const withoutSandbox = await runDoctor(["--target", "local-process", "--profile", "core", "--sandbox", "none"], {
      repoRoot,
      env,
      runner: fakeRunner([], () => ({ code: 0, stdout: "", stderr: "" })),
    });
    expect(withoutSandbox.items.some((i) => i.check === "port-8080")).toBe(false);
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
