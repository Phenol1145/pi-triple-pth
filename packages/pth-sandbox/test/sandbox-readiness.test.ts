import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildExecApp, buildKernelHostApp, createSandboxGrantVerifier } from "@away_from/pth-sandbox";

describe("P2-6：liveness/readiness 拆分", () => {
  it("exec-api /health 只做 liveness；/ready 缺共享密钥/工作区根 → 503", async () => {
    const app = buildExecApp({ workspacesRoot: "/nonexistent-pth-workspaces", getSecret: () => undefined });
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);

    const ready = await app.inject({ method: "GET", url: "/ready" });
    expect(ready.statusCode).toBe(503);
    const body = ready.json();
    expect(body.status).toBe("degraded");
    expect(body.checks.some((c: { name: string; ok: boolean }) => c.name === "shared-secret" && !c.ok)).toBe(true);
    await app.close();
  });

  it("exec-api /ready：前置条件齐备 → 200（含额外 readinessChecks）", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ready-exec-"));
    const app = buildExecApp({
      workspacesRoot: ws,
      getSecret: () => "s",
      readinessChecks: [{ name: "grant-verifier", check: () => true }],
    });
    const ready = await app.inject({ method: "GET", url: "/ready" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json().checks.every((c: { ok: boolean }) => c.ok)).toBe(true);
    await app.close();
  });

  it("独立 kernel-host app：无 grant verifier → /ready 503；装配 → 200", async () => {
    const noVerifier = buildKernelHostApp({ getSecret: () => "s" });
    expect((await noVerifier.inject({ method: "GET", url: "/ready" })).statusCode).toBe(503);
    await noVerifier.close();

    const app = buildKernelHostApp({
      getSecret: () => "s",
      grantVerifier: createSandboxGrantVerifier({ secret: "readiness-grant-secret-0123456789" }),
    });
    const ready = await app.inject({ method: "GET", url: "/ready" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({ status: "ready" });
    await app.close();
  });
});
