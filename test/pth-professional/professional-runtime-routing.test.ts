import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assembleProfessionalRuntimeRegistry,
  createProfessionalArtifactPort,
} from "../../src/pth/bootstrap/professional-runtime-adapters.js";
import { createLean4RuntimeAdapter } from "../../src/pth/execution/adapters/lean4-runtime-adapter.js";
import { buildExecutionBackendRegistry } from "../../src/pth/execution/backend-registry.js";
import type { ExecutionBackend, ExecutionCapabilities, ExecutionResult } from "@away_from/shared/execution";
import type { ProfessionalRuntimeLock } from "../../src/pth/contracts/index.js";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.allSettled(cleanup.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pth-routing-"));
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

/** 按 URL 与 cmd[0] 路由的假 HTTP 执行面（local-lean / local-chem 两个后端）。 */
function registryFetchLike(versions: { lean?: string; lake?: string; psi4?: string }): typeof fetch {
  return (async (url, init) => {
    const u = String(url);
    if (u.endsWith("/capabilities")) return response(HOST_CAPS);
    const body = JSON.parse(String(init?.body ?? "{}")) as { cmd?: string | string[] };
    const cmd = Array.isArray(body.cmd) ? body.cmd : (body.cmd ?? "").split(/\s+/);
    const tool = cmd[0];
    let stdout = "";
    if (u.includes("local-lean")) {
      if (tool === "lean") stdout = versions.lean ?? "";
      if (tool === "lake") stdout = versions.lake ?? "";
    }
    if (u.includes("local-chem") && tool === "psi4") stdout = versions.psi4 ?? "";
    return stdout ? response(execResult(stdout)) : response(execResult("", 127));
  }) as unknown as typeof fetch;
}

function makeLock(): ProfessionalRuntimeLock {
  return {
    schemaVersion: 1,
    generatedAt: "2026-08-22T00:00:00.000Z",
    runtimes: {
      lean4: {
        version: "4.8.0",
        releaseChannel: "stable",
        probe: { tool: "lean", args: ["--version"], extract: "[0-9]+\\.[0-9]+\\.[0-9]+" },
        dependencies: { mathlib: { rev: "a".repeat(40) } },
      } as never,
      psi4: {
        version: "1.9.1",
        releaseChannel: "stable",
        probe: { tool: "psi4", args: ["--version"], extract: "[0-9]+\\.[0-9]+\\.[0-9]+" },
      } as never,
    },
  } as ProfessionalRuntimeLock;
}

describe("P1.4/P1.5：professional runtime 路由与硬切", () => {
  it("adapter 硬切：无 executionBackend/prefix → probe unavailable（不再隐式 LocalBackend）", async () => {
    const artifactPath = await tempDir();
    const artifactPort = createProfessionalArtifactPort({ artifactPath });
    const noBackend = createLean4RuntimeAdapter({
      artifactPort,
      lockVersion: "4.8.0",
      mathlibRev: "a".repeat(40),
      execPrefix: [],
    });
    const probe = await noBackend.probe();
    expect(probe.available).toBe(false);
    expect(probe.reason).toContain("no execution backend configured");

    const fakeBackend: ExecutionBackend = {
      id: "fake-lean",
      getCapabilities: async () => HOST_CAPS,
      execute: async (req) => {
        const tool = Array.isArray(req.cmd) ? req.cmd[0] : req.cmd.split(/\s+/)[0];
        if (tool === "lean") return execResult("Lean (version 4.8.0, Release)\n");
        if (tool === "lake") return execResult("Lake version 4.8.0\n");
        return execResult("", 127);
      },
    };
    const withBackend = createLean4RuntimeAdapter({
      artifactPort,
      lockVersion: "4.8.0",
      mathlibRev: "a".repeat(40),
      executionBackend: fakeBackend,
      execPrefix: [],
    });
    expect(await withBackend.probe()).toMatchObject({ available: true, version: "4.8.0" });
  });

  it("artifactPath 激活默认 factory + 约定路由（lean4→local-lean, psi4→local-chem）", async () => {
    const artifactPath = await tempDir();
    const { registry } = buildExecutionBackendRegistry({
      descriptorsJson: JSON.stringify([
        { id: "local-lean", url: "http://local-lean:8787", profile: "host" },
        { id: "local-chem", url: "http://local-chem:8787", profile: "host" },
      ]),
      env: { PTH_EXEC_SANDBOX_ALIAS: "off" },
      strict: false,
      fetchLike: registryFetchLike({
        lean: "Lean (version 4.8.0, Release)\n",
        lake: "Lake version 4.8.0\n",
        psi4: "Psi4 1.9.1",
      }),
      capabilitiesTtlMs: 0,
    });
    const professional = await assembleProfessionalRuntimeRegistry({
      lock: makeLock(),
      artifactPath,
      executionBackends: registry,
    });
    await expect(professional.probe("lean4")).resolves.toMatchObject({ available: true, satisfiesLock: true });
    await expect(professional.probe("psi4")).resolves.toMatchObject({ available: true, satisfiesLock: true });
  });

  it("显式 backendRoutes 覆盖约定路由（lean4 被路由到 chem 后端 → 版本失配不注册）", async () => {
    const artifactPath = await tempDir();
    const { registry } = buildExecutionBackendRegistry({
      descriptorsJson: JSON.stringify([
        { id: "local-lean", url: "http://local-lean:8787", profile: "host" },
        { id: "local-chem", url: "http://local-chem:8787", profile: "host" },
      ]),
      env: { PTH_EXEC_SANDBOX_ALIAS: "off" },
      strict: false,
      fetchLike: registryFetchLike({ lean: "Lean (version 4.8.0, Release)\n", lake: "Lake version 4.8.0\n", psi4: "Psi4 1.9.1" }),
      capabilitiesTtlMs: 0,
    });
    const professional = await assembleProfessionalRuntimeRegistry({
      lock: makeLock(),
      artifactPath,
      executionBackends: registry,
      backendRoutes: { lean4: "local-chem" },
    });
    await expect(professional.probe("lean4")).resolves.toMatchObject({ available: false, reason: "unregistered-runtime" });
  });

  it("硬切：无注册表时默认 factory 不注册（unregistered-runtime），legacy env 前缀默认不回退", async () => {
    const artifactPath = await tempDir();
    const professional = await assembleProfessionalRuntimeRegistry({
      lock: makeLock(),
      artifactPath,
      // 不传 executionBackends —— 生产未路由 runtime 一律 unregistered
    });
    await expect(professional.probe("lean4")).resolves.toMatchObject({ available: false, reason: "unregistered-runtime" });
    await expect(professional.probe("psi4")).resolves.toMatchObject({ available: false, reason: "unregistered-runtime" });
  });
});
