import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assembleProfessionalRuntimeRegistry,
} from "../../src/pth/bootstrap/professional-runtime-adapters.js";
import { buildExecutionBackendRegistry } from "../../src/pth/execution/backend-registry.js";
import type { ExecutionCapabilities, ExecutionResult } from "@away_from/shared/execution";
import type { ProfessionalRuntimeLock } from "@away_from/pth-contracts";

/**
 * P5：jupyter 默认路由 → backend id `jupyter`（单容器双面南口）。
 * production vertical 见 deploy/services/jupyter/（容器内执行，不在此单测）。
 */

const HOST_CAPS: ExecutionCapabilities = {
  version: "execution/v1.1",
  streaming: false,
  cancel: false,
  cwdWhitelist: false,
  uidIsolation: false,
  egressLocked: false,
  pathMapping: false,
  modes: { sync: true, stream: false, interactive: false, persistent: false },
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

function registryFetchLike(): typeof fetch {
  return (async (url, init) => {
    const u = String(url);
    if (u.endsWith("/capabilities")) return response(HOST_CAPS);
    const body = JSON.parse(String(init?.body ?? "{}")) as { cmd?: string | string[] };
    const cmd = Array.isArray(body.cmd) ? body.cmd : (body.cmd ?? "").split(/\s+/);
    if (u.includes("jupyter") && cmd[0] === "jupyter-notebook") return response(execResult("7.6.1\n"));
    if (u.includes("jupyter") && cmd[0] === "python3") return response(execResult("libs-ok\n"));
    return response(execResult("", 127));
  }) as unknown as typeof fetch;
}

function makeLock(): ProfessionalRuntimeLock {
  return {
    schemaVersion: 1,
    generatedAt: "2026-08-22T00:00:00.000Z",
    runtimes: {
      jupyter: {
        version: "7.6.1",
        releaseChannel: "stable",
        probe: { tool: "jupyter-notebook", args: ["--version"], extract: "([0-9]+\\.[0-9]+\\.[0-9]+)" },
      },
    },
  } as unknown as ProfessionalRuntimeLock;
}

describe("P5：jupyter runtime 默认路由 → backend jupyter", () => {
  it("artifactPath 激活 jupyter factory + 约定路由，probe satisfiesLock", async () => {
    const artifactPath = await mkdtemp(join(tmpdir(), "pth-jupyter-route-"));
    try {
      const { registry } = buildExecutionBackendRegistry({
        descriptorsJson: JSON.stringify([
          { id: "jupyter", url: "http://jupyter:8889", profile: "host", tokenEnv: "JUPYTER_SERVICE_TOKEN" },
        ]),
        env: { PTH_EXEC_SANDBOX_ALIAS: "off", JUPYTER_SERVICE_TOKEN: "test-token" },
        strict: false,
        fetchLike: registryFetchLike(),
        capabilitiesTtlMs: 0,
      });
      const professional = await assembleProfessionalRuntimeRegistry({
        lock: makeLock(),
        artifactPath,
        executionBackends: registry,
      });
      await expect(professional.probe("jupyter")).resolves.toMatchObject({ available: true, satisfiesLock: true, version: "7.6.1" });
    } finally {
      await rm(artifactPath, { recursive: true, force: true });
    }
  });

  it("无 jupyter backend → jupyter unregistered（P1 硬切，不再 docker exec 直跑）", async () => {
    const artifactPath = await mkdtemp(join(tmpdir(), "pth-jupyter-noroute-"));
    try {
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
      });
      const probe = await professional.probe("jupyter");
      expect(probe.available).toBe(false);
      expect(probe.satisfiesLock).toBe(false);
    } finally {
      await rm(artifactPath, { recursive: true, force: true });
    }
  });
});
