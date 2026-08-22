import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  assembleProfessionalRuntimeRegistry,
  createProfessionalArtifactPort,
} from "../../src/pth/bootstrap/professional-runtime-adapters.js";
import { createU8RuntimeAdapter } from "../../src/pth/execution/adapters/u8-runtime-adapter.js";
import { buildExecutionBackendRegistry } from "../../src/pth/execution/backend-registry.js";
import { isU8JobSpecStructurallyValid } from "@away_from/pth-contracts";
import type {
  ProfessionalJobRequest,
  ProfessionalRuntimeLock,
  U8JobSpec,
} from "@away_from/pth-contracts";
import type { ExecutionBackend, ExecutionCapabilities, ExecutionResult } from "@away_from/shared/execution";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.allSettled(cleanup.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pth-u8-"));
  cleanup.push(dir);
  return dir;
}

const HOST_CAPS: ExecutionCapabilities = {
  version: "execution/v1",
  streaming: false,
  cancel: false,
  cwdWhitelist: false,
  uidIsolation: false,
  egressLocked: false,
  pathMapping: true,
};

function response(body: unknown, status = 200): Response {
  return {
    ok: status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

function execResult(stdout: string, exitCode = 0): ExecutionResult {
  return { stdout, stderr: "", exitCode, timedOut: false };
}

const U8_VERSION_STDOUT = "U8 version:0.0.2\n";

function u8Spec(overrides: Partial<U8JobSpec> = {}): U8JobSpec {
  return {
    operation: "compile-run",
    sourceRef: { kind: "source", uri: "artifact://tenant-a/source", mediaType: "text/x-u8asm" },
    regs: { A: 3, B: 4 },
    io: { "0": 42, a: 7 },
    ...overrides,
  };
}

function makeRequest(spec: U8JobSpec): ProfessionalJobRequest<U8JobSpec> {
  return {
    jobId: randomUUID(),
    taskId: "task-u8",
    tenantId: "tenant-a",
    space: "dev",
    worker: {
      workerId: "10000000-0000-4000-8000-0000000000u8",
      batchId: "batch-professional",
      role: { roleId: "assembly-engineer", revision: "rev-v1" },
    },
    lease: { taskId: "task-u8", leaseId: randomUUID(), generation: 1 },
    roleRevision: "rev-v1",
    runtimeId: "u8",
    runtimeVersion: "lock:u8",
    deadlineAt: "2030-01-01T00:01:00.000Z",
    inputHash: "sha256:" + "b".repeat(64),
    spec,
  };
}

/** 模拟 local-u8 执行面的假 backend：compile 会真实写出 programme 文件供 adapter 回收。 */
function fakeU8Backend(version = "0.0.2"): ExecutionBackend {
  return {
    id: "fake-u8",
    getCapabilities: async () => HOST_CAPS,
    execute: async (req) => {
      const cmd = Array.isArray(req.cmd) ? req.cmd : req.cmd.split(/\s+/);
      const tool = cmd[0];
      if (tool === "u8" && cmd[1] === "version") return execResult(`U8 version:${version}\n`);
      if (tool === "u8" && cmd[1] === "compile") {
        const out = cmd[3];
        if (!out || !req.cwd) return execResult("Compile error!", 0);
        await writeFile(join(req.cwd, out), new Uint8Array([0x75, 0x38, 0x75, 0x38, 0xf0]));
        return execResult("Compile successfully.\n");
      }
      if (tool === "u8" && cmd[1] === "run") {
        return execResult("Press any key to continue...\n");
      }
      return execResult("", 127);
    },
  };
}

/** 按 URL/cmd 路由的假 HTTP 执行面（仅 local-u8）。 */
function registryFetchLike(version = "0.0.2"): typeof fetch {
  return (async (url, init) => {
    const u = String(url);
    if (u.endsWith("/capabilities")) return response(HOST_CAPS);
    const body = JSON.parse(String(init?.body ?? "{}")) as { cmd?: string | string[] };
    const cmd = Array.isArray(body.cmd) ? body.cmd : (body.cmd ?? "").split(/\s+/);
    if (u.includes("local-u8") && cmd[0] === "u8") {
      return response(execResult(`U8 version:${version}\n`));
    }
    return response(execResult("", 127));
  }) as unknown as typeof fetch;
}

function makeLock(version = "0.0.2"): ProfessionalRuntimeLock {
  return {
    schemaVersion: 1,
    generatedAt: "2026-08-22T00:00:00.000Z",
    runtimes: {
      u8: {
        version,
        releaseChannel: "stable",
        probe: { tool: "u8", args: ["version"], extract: "U8 version:([0-9]+\\.[0-9]+\\.[0-9]+)" },
      },
    },
  } as unknown as ProfessionalRuntimeLock;
}

describe("U8-1：u8-runtime-adapter 契约与执行面", () => {
  it("spec 白名单：compile/compile-run 要 sourceRef，run 要 programmeRef，reg/io 只收 0–255", () => {
    expect(isU8JobSpecStructurallyValid(u8Spec())).toBe(true);
    expect(isU8JobSpecStructurallyValid(u8Spec({ operation: "compile" }))).toBe(true);
    expect(isU8JobSpecStructurallyValid({
      operation: "run",
      programmeRef: { kind: "programme", uri: "artifact://tenant-a/prog" },
      io: { f: 255 },
    })).toBe(true);
    expect(isU8JobSpecStructurallyValid(u8Spec({ programmeRef: { kind: "programme", uri: "artifact://tenant-a/prog" } }))).toBe(false);
    expect(isU8JobSpecStructurallyValid({ operation: "run", sourceRef: { kind: "source", uri: "artifact://tenant-a/s" } })).toBe(false);
    expect(isU8JobSpecStructurallyValid(u8Spec({ regs: { A: 256 } }))).toBe(false);
    expect(isU8JobSpecStructurallyValid(u8Spec({ regs: { PC: -1 } }))).toBe(false);
    expect(isU8JobSpecStructurallyValid(u8Spec({ io: { "16": 1 } }))).toBe(false);
    expect(isU8JobSpecStructurallyValid(u8Spec({ io: { "0": 1.5 } }))).toBe(false);
    expect(isU8JobSpecStructurallyValid({ ...u8Spec(), command: "u8" })).toBe(false);
  });

  it("P1 硬切：无 executionBackend/prefix → probe unavailable（不隐式直跑）", async () => {
    const artifactPath = await tempDir();
    const adapter = createU8RuntimeAdapter({
      artifactPort: createProfessionalArtifactPort({ artifactPath }),
      lockVersion: "0.0.2",
      workDir: artifactPath,
      execPrefix: [],
    });
    const probe = await adapter.probe();
    expect(probe.available).toBe(false);
    expect(probe.reason).toContain("no execution backend configured");
  });

  it("probe 钉版本：u8 version 必须与 committed lock 一致", async () => {
    const artifactPath = await tempDir();
    const ok = createU8RuntimeAdapter({
      artifactPort: createProfessionalArtifactPort({ artifactPath }),
      lockVersion: "0.0.2",
      workDir: artifactPath,
      executionBackend: fakeU8Backend("0.0.2"),
    });
    await expect(ok.probe()).resolves.toMatchObject({ available: true, version: "0.0.2" });

    const mismatch = createU8RuntimeAdapter({
      artifactPort: createProfessionalArtifactPort({ artifactPath }),
      lockVersion: "0.0.2",
      workDir: artifactPath,
      executionBackend: fakeU8Backend("0.0.1"),
    });
    const probe = await mismatch.probe();
    expect(probe.available).toBe(false);
    expect(probe.reason).toContain("committed lock");
  });

  it("compile-run vertical：source 经 artifact port 进入，programme 与 run-log 落租户树", async () => {
    const artifactPath = await tempDir();
    const artifactPort = createProfessionalArtifactPort({ artifactPath });
    const adapter = createU8RuntimeAdapter({
      artifactPort,
      lockVersion: "0.0.2",
      workDir: artifactPath,
      executionBackend: fakeU8Backend(),
    });

    const source = await artifactPort.putOutput({
      tenantId: "tenant-a",
      jobId: "u8-source",
      kind: "source",
      mediaType: "text/x-u8asm",
      bytes: new TextEncoder().encode("HLT\n"),
    });
    const request = makeRequest(u8Spec({ sourceRef: source, regs: { A: 1 }, io: { a: 2 } }));
    const result = await adapter.execute(request);

    expect(result.status).toBe("succeeded");
    expect(result.runtime).toBe("u8");
    expect(result.artifacts.map((a) => a.kind).sort()).toEqual(["programme", "run-log", "source"]);
    expect(result.value).toMatchObject({
      operation: "compile-run",
      compileStdout: "Compile successfully.\n",
      toolchain: { u8: "0.0.2" },
    });
    const binary = result.artifacts.find((a) => a.kind === "programme")!;
    const bytes = await artifactPort.getInput("tenant-a", binary);
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x75, 0x38, 0x75, 0x38]);
    const runLog = JSON.parse(new TextDecoder().decode(await artifactPort.getInput("tenant-a", result.artifacts.find((a) => a.kind === "run-log")!))) as { io?: Record<string, number> };
    expect(runLog.io).toEqual({ a: 2 });
  });

  it("compile 失败（缺成功标记）→ failed + 不落 programme artifact", async () => {
    const artifactPath = await tempDir();
    const artifactPort = createProfessionalArtifactPort({ artifactPath });
    const adapter = createU8RuntimeAdapter({
      artifactPort,
      lockVersion: "0.0.2",
      workDir: artifactPath,
      executionBackend: fakeU8Backend(),
      exec: async (cmd, args) => {
        if (args[0] === "version") return { ok: true, stdout: U8_VERSION_STDOUT, stderr: "", code: 0, timedOut: false };
        if (args[0] === "compile") return { ok: true, stdout: "Compile error!\n", stderr: "", code: 0, timedOut: false };
        return { ok: false, stdout: "", stderr: "unexpected", code: 127, timedOut: false };
      },
    });
    const source = await artifactPort.putOutput({
      tenantId: "tenant-a",
      jobId: "u8-source",
      kind: "source",
      mediaType: "text/x-u8asm",
      bytes: new TextEncoder().encode("HLT\n"),
    });
    const result = await adapter.execute(makeRequest(u8Spec({ sourceRef: source })));
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("compile-failed");
    expect(result.artifacts.map((a) => a.kind)).toEqual(["source"]);
  });

  it("run 遇 u8 VM 错误标记 → failed（u8 CLI 错误路径也返回退出码 0）", async () => {
    const artifactPath = await tempDir();
    const artifactPort = createProfessionalArtifactPort({ artifactPath });
    const adapter = createU8RuntimeAdapter({
      artifactPort,
      lockVersion: "0.0.2",
      workDir: artifactPath,
      exec: async (cmd, args, opts = {}) => {
        if (args[0] === "version") return { ok: true, stdout: U8_VERSION_STDOUT, stderr: "", code: 0, timedOut: false };
        if (args[0] === "run") return { ok: true, stdout: "Error occurred when loading code!\n", stderr: "", code: 0, timedOut: false };
        throw new Error(`unexpected exec: ${cmd} ${args.join(" ")}`);
      },
    });
    const programme = await artifactPort.putOutput({
      tenantId: "tenant-a",
      jobId: "u8-programme",
      kind: "programme",
      mediaType: "application/x-u8programme",
      bytes: new Uint8Array([0x75, 0x38, 0x75, 0x38, 0xf0]),
    });
    const result = await adapter.execute(makeRequest({ operation: "run", programmeRef: programme, io: { "0": 1 } }));
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("run-vm-error");
  });
});

describe("U8-1：默认路由 u8 → local-u8", () => {
  it("artifactPath 激活 u8 factory + 约定路由，probe satisfiesLock", async () => {
    const artifactPath = await tempDir();
    await mkdir(artifactPath, { recursive: true });
    const { registry } = buildExecutionBackendRegistry({
      descriptorsJson: JSON.stringify([
        { id: "local-u8", url: "http://local-u8:8788", profile: "host", tokenEnv: "LOCAL_EXEC_SHARED_SECRET" },
      ]),
      env: { PTH_EXEC_SANDBOX_ALIAS: "off" },
      strict: false,
      fetchLike: registryFetchLike(),
      capabilitiesTtlMs: 0,
    });
    const professional = await assembleProfessionalRuntimeRegistry({
      lock: makeLock(),
      artifactPath,
      executionBackends: registry,
      u8WorkDir: artifactPath,
    });
    await expect(professional.probe("u8")).resolves.toMatchObject({ available: true, satisfiesLock: true, version: "0.0.2" });
  });

  it("无 local-u8 路由 → u8 unregistered（P1 硬切）", async () => {
    const artifactPath = await tempDir();
    const { registry } = buildExecutionBackendRegistry({
      descriptorsJson: JSON.stringify([]),
      env: { PTH_EXEC_SANDBOX_ALIAS: "off" },
      strict: false,
      fetchLike: registryFetchLike(),
      capabilitiesTtlMs: 0,
    });
    const professional = await assembleProfessionalRuntimeRegistry({
      lock: makeLock(),
      artifactPath,
      executionBackends: registry,
      u8WorkDir: artifactPath,
    });
    const probe = await professional.probe("u8");
    expect(probe.available).toBe(false);
    expect(probe.satisfiesLock).toBe(false);
  });
});
