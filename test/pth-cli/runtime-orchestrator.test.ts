import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  orchestrateDown,
  orchestrateStatusAll,
  orchestrateUp,
  parseComposePsJson,
  parseOrchestratedArgs,
  hasOrchestrationFlags,
  type CommandRunner,
  type OrchestratorDeps,
} from "../../src/cli/runtime/runtime-orchestrator.js";
import { DEFAULT_RUNTIME_PROFILES } from "../../src/cli/runtime/runtime-profiles.js";

const SECRETS = [
  "SANDBOX_SHARED_SECRET=sandbox-secret-000000000000000000000000",
  "PTH_EXECUTION_GRANT_SECRET=grant-secret-000000000000000000000000",
  "PTH_MEMORY_BRIDGE_TOKEN=memory-bridge-token-000000000000000000",
  "POSTGRES_PASSWORD=pg-password-0000000000000000000000000000",
  "REDIS_PASSWORD=redis-password-00000000000000000000000000",
  "LOCAL_EXEC_SHARED_SECRET=local-exec-secret-00000000000000000000",
  "JUPYTER_SERVICE_TOKEN=jupyter-service-token-000000000000000000",
].join("\n");

async function makeRepo(): Promise<string> {
  const repoRoot = await mkdtemp(join(tmpdir(), "pth-orch-"));
  await mkdir(join(repoRoot, "deploy"), { recursive: true });
  await writeFile(join(repoRoot, "deploy", ".env.pth.secrets"), SECRETS);
  return repoRoot;
}

interface Calls {
  order: string[];
  services: (args: string[]) => Promise<void>;
  tools: (args: string[]) => Promise<void>;
  pthUp: (args: string[]) => Promise<void>;
  pthDown: (args: string[]) => Promise<void>;
  pthStatus: (args: string[]) => Promise<void>;
}

function makeFakes(calls: Calls): OrchestratorDeps {
  return {
    servicesCommand: calls.services,
    toolsCommand: calls.tools,
    pthUp: (args) => calls.pthUp(args),
    pthDown: (args) => calls.pthDown(args),
    pthStatus: (args) => calls.pthStatus(args),
  };
}

function healthyRunner(repoRoot: string): CommandRunner {
  return async (cmd, argv) => {
    const joined = argv.join(" ");
    if (cmd === "docker" && joined.endsWith("ps --format json")) {
      if (joined.includes("-p pi-triple-jupyter")) {
        return { code: 0, stdout: JSON.stringify({ Service: "jupyter", State: "running", Health: "healthy" }), stderr: "" };
      }
      return {
        code: 0,
        stdout: [
          { Service: "redis", State: "running", Health: "healthy" },
          { Service: "postgres", State: "running", Health: "healthy" },
          { Service: "sandbox", State: "running", Health: "healthy" },
        ].map((s) => JSON.stringify(s)).join("\n"),
        stderr: "",
      };
    }
    if (cmd === "docker" && joined.includes("logs")) {
      return { code: 0, stdout: "engine log: professional runtimes registered: assembly, jupyter, u8", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
}

describe("parseOrchestratedArgs / hasOrchestrationFlags", () => {
  it("识别编排 flag 并解析 profile/with/without/forward", () => {
    expect(hasOrchestrationFlags(["--profile", "full"])).toBe(true);
    expect(hasOrchestrationFlags(["--all"])).toBe(true);
    expect(hasOrchestrationFlags(["--rebuild"])).toBe(false);
    const parsed = parseOrchestratedArgs(["--profile", "lean4", "--with", "jupyter,u8", "--without", "tools", "--rebuild", "--timeout", "120"], "up");
    expect(parsed.profile).toBe("lean4");
    expect(parsed.withIds).toEqual(["jupyter", "u8"]);
    expect(parsed.withoutIds).toEqual(["tools"]);
    expect(parsed.forward).toEqual(["--rebuild", "--timeout", "120"]);
  });

  it("--all 等价 full", () => {
    expect(parseOrchestratedArgs(["--all"], "up").profile).toBe("full");
  });

  it("--profile 缺值报错", () => {
    expect(() => parseOrchestratedArgs(["--profile"], "up")).toThrow(/需要取值/);
  });
});

describe("parseComposePsJson", () => {
  it("解析 JSON Lines 并忽略坏行", () => {
    const states = parseComposePsJson(`${JSON.stringify({ Service: "redis", State: "running", Health: "healthy" })}\nnot-json\n`);
    expect(states).toEqual([{ service: "redis", state: "running", health: "healthy" }]);
  });
});

describe("orchestrateUp", () => {
  it("full：数据层分服务 → tools/services → jupyter → engine 最后；token 同源", async () => {
    const repoRoot = await makeRepo();
    const calls: Calls = {
      order: [],
      services: async (args) => { calls.order.push(`services ${args.join(" ")}`); },
      tools: async (args) => { calls.order.push(`tools ${args.join(" ")}`); },
      pthUp: async (args) => { calls.order.push(`pthUp ${args.join(" ")}`); },
      pthDown: async () => {},
      pthStatus: async () => {},
    };
    const deps: OrchestratorDeps = {
      repoRoot,
      env: { PTH_WORKSPACES_HOST: repoRoot },
      runner: healthyRunner(repoRoot),
      profiles: DEFAULT_RUNTIME_PROFILES,
      doctor: async () => ({ ok: true, profile: "full", items: [] }),
      ...makeFakes(calls),
    };
    await orchestrateUp(["--all"], deps);

    const engineIndex = calls.order.findIndex((c) => c.startsWith("pthUp"));
    const optional = calls.order.slice(0, engineIndex);
    expect(optional).toEqual([
      "tools up",
      "services up local-lean",
      "services up local-u8",
      "services up jupyter",
    ]);
    // 数据层顺序由 waitHealthy 隐式保证；这里断言 pthUp 是最后一步
    expect(calls.order[calls.order.length - 1]).toMatch(/^pthUp /);
    const pthArgs = calls.order[engineIndex]!;
    expect(pthArgs).toContain("--token ");
    expect(pthArgs.split("--token ")[1]).toMatch(/^[0-9a-f]{64}$/);
    expect(pthArgs).not.toContain("--profile");
    expect(pthArgs).not.toContain("--all");
  });

  it("--token 复用同一值传给 engine 与 JUPYTER_ENGINE_TOKEN", async () => {
    const repoRoot = await makeRepo();
    let pthArgs = "";
    const calls: Calls = {
      order: [],
      services: async () => {},
      tools: async () => {},
      pthUp: async (args) => { pthArgs = args.join(" "); },
      pthDown: async () => {},
      pthStatus: async () => {},
    };
    await orchestrateUp(["--profile", "jupyter", "--token", "abc123token456"], {
      repoRoot,
      env: { PTH_WORKSPACES_HOST: repoRoot },
      runner: healthyRunner(repoRoot),
      profiles: DEFAULT_RUNTIME_PROFILES,
      doctor: async () => ({ ok: true, profile: "jupyter", items: [] }),
      ...makeFakes(calls),
    });
    expect(pthArgs).toContain("--token abc123token456");
  });

  it("--no-seed-token 与 jupyter 冲突", async () => {
    const repoRoot = await makeRepo();
    const calls: Calls = {
      order: [],
      services: async () => {},
      tools: async () => {},
      pthUp: async () => {},
      pthDown: async () => {},
      pthStatus: async () => {},
    };
    await expect(orchestrateUp(["--profile", "jupyter", "--no-seed-token"], {
      repoRoot,
      env: { PTH_WORKSPACES_HOST: repoRoot },
      runner: healthyRunner(repoRoot),
      profiles: DEFAULT_RUNTIME_PROFILES,
      doctor: async () => ({ ok: true, profile: "jupyter", items: [] }),
      ...makeFakes(calls),
    })).rejects.toThrow(/jupyter 组件冲突/);
  });

  it("jupyter 缺 JUPYTER_SERVICE_TOKEN 报错", async () => {
    const repoRoot = await makeRepo();
    await writeFile(join(repoRoot, "deploy", ".env.pth.secrets"), SECRETS.split("\n").filter((l) => !l.startsWith("JUPYTER_SERVICE_TOKEN")).join("\n"));
    const calls: Calls = {
      order: [],
      services: async () => {},
      tools: async () => {},
      pthUp: async () => {},
      pthDown: async () => {},
      pthStatus: async () => {},
    };
    await expect(orchestrateUp(["--profile", "jupyter"], {
      repoRoot,
      env: { PTH_WORKSPACES_HOST: repoRoot },
      runner: healthyRunner(repoRoot),
      profiles: DEFAULT_RUNTIME_PROFILES,
      doctor: async () => ({ ok: true, profile: "jupyter", items: [] }),
      ...makeFakes(calls),
    })).rejects.toThrow(/JUPYTER_SERVICE_TOKEN/);
  });

  it("--with/--without 决定可选组件；core 不带外围", async () => {
    const repoRoot = await makeRepo();
    const up: string[] = [];
    const calls: Calls = {
      order: [],
      services: async (args) => { up.push(`services ${args.join(" ")}`); },
      tools: async (args) => { up.push(`tools ${args.join(" ")}`); },
      pthUp: async () => {},
      pthDown: async () => {},
      pthStatus: async () => {},
    };
    await orchestrateUp(["--profile", "core", "--with", "u8"], {
      repoRoot,
      env: { PTH_WORKSPACES_HOST: repoRoot },
      runner: healthyRunner(repoRoot),
      profiles: DEFAULT_RUNTIME_PROFILES,
      doctor: async () => ({ ok: true, profile: "core", items: [] }),
      ...makeFakes(calls),
    });
    expect(up).toEqual(["services up local-u8"]);
  });
});

describe("orchestrateDown", () => {
  it("full：外围反向停止，core 最后", async () => {
    const repoRoot = await makeRepo();
    const order: string[] = [];
    const calls: Calls = {
      order,
      services: async (args) => { order.push(`services ${args.join(" ")}`); },
      tools: async (args) => { order.push(`tools ${args.join(" ")}`); },
      pthUp: async () => {},
      pthDown: async () => { order.push("pthDown"); },
      pthStatus: async () => {},
    };
    await orchestrateDown(["--all"], {
      repoRoot,
      env: {},
      runner: healthyRunner(repoRoot),
      profiles: DEFAULT_RUNTIME_PROFILES,
      ...makeFakes(calls),
    });
    expect(order).toEqual(["services down jupyter", "services down local-u8", "services down local-lean", "tools down", "pthDown"]);
  });

  it("down 与 up 同源注入 secrets（jupyter compose :? 插值修复）", async () => {
    const repoRoot = await makeRepo();
    const before: Record<string, string | undefined> = {
      JUPYTER_SERVICE_TOKEN: process.env.JUPYTER_SERVICE_TOKEN,
      REDIS_PASSWORD: process.env.REDIS_PASSWORD,
      POSTGRES_PASSWORD: process.env.POSTGRES_PASSWORD,
    };
    delete process.env.JUPYTER_SERVICE_TOKEN;
    delete process.env.REDIS_PASSWORD;
    delete process.env.POSTGRES_PASSWORD;
    try {
      await orchestrateDown(["--all"], {
        repoRoot,
        runner: healthyRunner(repoRoot),
        profiles: DEFAULT_RUNTIME_PROFILES,
        ...makeFakes({
          order: [],
          services: async () => {},
          tools: async () => {},
          pthUp: async () => {},
          pthDown: async () => {},
          pthStatus: async () => {},
        }),
      });
      expect(process.env.JUPYTER_SERVICE_TOKEN).toBe("jupyter-service-token-000000000000000000");
      expect(process.env.REDIS_PASSWORD).toBe("redis-password-00000000000000000000000000");
      expect(process.env.POSTGRES_PASSWORD).toBe("pg-password-0000000000000000000000000000");
    } finally {
      for (const [key, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe("orchestrateStatusAll", () => {
  it("聚合 core/services/tools/runtime 注册态与 engine status", async () => {
    const repoRoot = await makeRepo();
    const order: string[] = [];
    const calls: Calls = {
      order,
      services: async () => { order.push("services status"); },
      tools: async () => { order.push("tools status"); },
      pthUp: async () => {},
      pthDown: async () => {},
      pthStatus: async () => { order.push("pthStatus"); },
    };
    const lines: string[] = [];
    await orchestrateStatusAll(["--all", "--port", "3000"], {
      repoRoot,
      env: { PTH_TOKEN: "op-token" },
      runner: healthyRunner(repoRoot),
      profiles: DEFAULT_RUNTIME_PROFILES,
      fetchLike: async () => ({ ok: true, status: 200, text: async () => "{}" }) as unknown as Response,
      log: (line) => lines.push(line),
      ...makeFakes(calls),
    });
    expect(order).toEqual(["pthStatus", "services status", "tools status"]);
    expect(lines.join("\n")).toContain("professional runtimes registered");
  });
});
