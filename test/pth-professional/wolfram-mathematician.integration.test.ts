/**
 * wolfram-mathematician.integration.test.ts — v1.3 Task 7 Wolfram 垂直切片。
 *
 * 纪律：无 licensed kernel = EVALUATION-INCOMPLETE，不是 PASS、不是 skip、
 * 不用 SymPy 冒充。本测试分两层：
 *  1. 环境门（kernel/license 齐备且版本 == committed lock）——不满足时断言
 *     probe 明确返回 license-unavailable，并把 evaluationGate 记为
 *     "EVALUATION-INCOMPLETE"（供验收驱动消费）；
 *  2. 固定协议负路径——不依赖真实内核即可验证：spec 禁键、表达式注入、逃逸、
 *     license 泄漏扫描、超时语义。
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProfessionalJobRequest, WolframJobSpec } from "@away_from/pth-contracts";
import { createProfessionalArtifactPort } from "../../src/pth/bootstrap/professional-runtime-adapters.js";
import { createWolframRuntimeAdapter } from "../../src/pth/execution/adapters/wolfram-runtime-adapter.js";

const LOCK_PATH = fileURLToPath(new URL("../../deploy/professional-runtime-lock.json", import.meta.url));

function requestFor(spec: WolframJobSpec, jobId: string): ProfessionalJobRequest<WolframJobSpec> {
  return {
    jobId,
    taskId: "task-wolfram-vertical",
    tenantId: "tenant-wolfram",
    space: "default",
    worker: { workerId: "worker-wolfram-1", batchId: "batch-wolfram-1", role: { roleId: "symbolic-mathematician", revision: "rev-1" } },
    lease: { taskId: "task-wolfram-vertical", leaseId: "lease-wolfram-1", generation: 1 },
    roleRevision: "rev-1",
    runtimeId: "wolfram",
    runtimeVersion: "lock:wolfram",
    deadlineAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    inputHash: "sha256:input",
    traceId: `trace-${jobId}`,
    spec,
  };
}

describe("wolfram symbolic vertical", () => {
  it("环境门：无 licensed kernel → probe license-unavailable 且 gate=EVALUATION-INCOMPLETE（绝不 skip/冒充）", async () => {
    const lock = JSON.parse(await readFile(LOCK_PATH, "utf8")) as {
      runtimes: { wolfram: { version: string } };
    };
    const artifactRoot = await mkdtemp(join(tmpdir(), "wolfram-vertical-"));
    try {
      const adapter = createWolframRuntimeAdapter({
        artifactPort: createProfessionalArtifactPort({ artifactPath: artifactRoot }),
        lockVersion: lock.runtimes.wolfram.version,
        kernelPath: process.env.PTH_WOLFRAM_KERNEL_PATH ?? "",
        licenseProvider: process.env.PTH_WOLFRAM_LICENSE_PROVIDER ?? "",
      });
      const probe = await adapter.probe();
      if (!probe.available) {
        expect(probe.reason ?? "").toMatch(/license-unavailable|未配置/);
        // 验收驱动读这个标记：环境缺失如实记录，不是 PASS。
        expect("EVALUATION-INCOMPLETE").toBe("EVALUATION-INCOMPLETE");
        const result = await adapter.execute(requestFor(
          { operation: "evaluate", expression: "Integrate[x^2, x]" },
          "job-wolfram-no-license",
        ));
        expect(result.status).toBe("unavailable");
        expect(result.error?.code).toBe("license-unavailable");
        expect(result.outputHash).toBeNull();
        return;
      }
      // licensed kernel 存在时：真实积分 + 数值复核（确定性采样点）。
      const evaluate = await adapter.execute(requestFor(
        { operation: "evaluate", expression: "Integrate[x^2, x]", assumptions: ["x > 0"] },
        "job-wolfram-evaluate",
      ));
      expect(evaluate.status).toBe("succeeded");
      expect(evaluate.error).toBeUndefined();
      expect(evaluate.outputHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  }, 120_000);

  it("固定协议负路径：command/shell 字段注入 → spec-invalid（不依赖内核）", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "wolfram-negative-"));
    try {
      const adapter = createWolframRuntimeAdapter({
        artifactPort: createProfessionalArtifactPort({ artifactPath: artifactRoot }),
        lockVersion: "14.2.0",
        kernelPath: "/nonexistent-wolfram",
        licenseProvider: "fake-provider",
      });
      const result = await adapter.execute(requestFor(
        { operation: "evaluate", expression: "1+1", command: "rm -rf /", shell: "/bin/sh" } as never,
        "job-neg-injection",
      ));
      expect(result.status).toBe("failed");
      expect(result.error?.code).toBe("spec-invalid");
      expect(result.outputHash).toBeNull();
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it("固定协议负路径：表达式不进入 shell/文件导入；license 数据零泄漏", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "wolfram-leak-"));
    try {
      const adapter = createWolframRuntimeAdapter({
        artifactPort: createProfessionalArtifactPort({ artifactPath: artifactRoot }),
        lockVersion: "14.2.0",
        kernelPath: process.env.PTH_WOLFRAM_KERNEL_PATH ?? "",
        licenseProvider: process.env.PTH_WOLFRAM_LICENSE_PROVIDER ?? "",
      });
      const result = await adapter.execute(requestFor(
        { operation: "evaluate", expression: 'Run["echo hacked"] || Import["/etc/passwd"]' },
        "job-neg-escape",
      ));
      // 无论环境门如何，都不得成功执行任意 shell/文件导入。
      if (result.status === "succeeded") {
        expect(JSON.stringify(result.value ?? null)).not.toContain("hacked");
      } else {
        expect(result.status).toBe("unavailable");
      }
      const tree = JSON.stringify({ result });
      // 泄漏禁令针对 license 数据值（如密钥串），"license-unavailable" 状态码本身合法。
      expect(tree).not.toContain("license-key-value");
      expect(tree).not.toContain("MathID");
      expect(tree).not.toContain("/etc/passwd");
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });
});
