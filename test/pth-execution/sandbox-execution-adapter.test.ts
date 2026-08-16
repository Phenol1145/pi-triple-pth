import { describe, expect, it, vi } from "vitest";
import { createSandboxExecutionAdapter } from "../../src/pth/execution/adapters/sandbox-execution-adapter.js";
import type {
  ExecutionGrant,
  ExecutionRequest,
  TenantScope,
  WorkspaceRef,
} from "../../src/pth/contracts/index.js";

const scope: TenantScope = { tenantId: "tenant-a", principalId: "worker:developer", roles: ["developer"], traceId: "trace-1" };
const workspace: WorkspaceRef = { tenantId: "tenant-a", workspaceId: "ws-opaque-1", taskId: "task-1" };
const lease = { taskId: "task-1", leaseId: "bb7d7e7e-c3ec-4e58-b34d-2f6a2a70e0a6", generation: 1 };

const request: ExecutionRequest = {
  scope, workspace, language: "python", program: "print(1)", timeoutMs: 30_000, maxStdout: 1024, maxStderr: 1024,
};
const grant: ExecutionGrant = {
  grantId: "0c4a2c7d-800c-4e3e-8a0b-6d3e3474627d",
  nonce: "8efab84f-e946-4b84-a49e-e1d08cc38a50",
  lease,
  scope,
  workspace,
  language: "python",
  capabilities: ["memory.read"],
  issuedAt: "2030-01-01T00:00:00.000Z",
  deadlineAt: "2030-01-01T00:00:10.000Z",
};

describe("sandbox execution adapter（P2-1）", () => {
  it("execute 以 grant+request 调用 /kernel/execute，不使用共享密钥凭据", async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(String(init.headers)).not.toContain("SANDBOX_SHARED_SECRET");
      expect(JSON.stringify(init.body)).not.toContain("sandbox-dev-secret");
      const body = JSON.parse(String(init.body)) as { grant: ExecutionGrant; request: ExecutionRequest };
      expect(body.grant.grantId).toBe(grant.grantId);
      expect(body.request.program).toBe("print(1)");
      return new Response(JSON.stringify({ result: { ok: true, stdout: "1", stderr: "", durationMs: 5, language: "python" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const adapter = createSandboxExecutionAdapter({ baseUrl: "http://sandbox:8080", fetchImpl });
    const result = await adapter.execute(request, grant);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://sandbox:8080/kernel/execute");
    expect(init.method).toBe("POST");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(result).toMatchObject({ ok: true, stdout: "1", durationMs: 5 });
  });

  it("sandbox 非 200 → ok:false + error", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: "stale lease" }), { status: 400, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const adapter = createSandboxExecutionAdapter({ baseUrl: "http://sandbox:8080", fetchImpl });
    const result = await adapter.execute(request, grant);
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("stale lease");
  });

  it("abort signal 透传给 fetch", async () => {
    const fetchImpl = vi.fn(async () => { throw new DOMException("aborted", "AbortError"); }) as unknown as typeof fetch;
    const controller = new AbortController();
    const adapter = createSandboxExecutionAdapter({ baseUrl: "http://sandbox:8080", fetchImpl });
    await adapter.execute(request, grant, controller.signal).catch(() => {});
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ signal: controller.signal });
  });
});
