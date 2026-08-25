/**
 * execution/adapters/wolfram-runtime-adapter.ts — v1.3 Task 7 Wolfram 符号计算垂直切片。
 *
 * 固定执行协议：
 *  - 表达式经 JSON.stringify 转义后写入生成的工作区 `.wl` 文件，
 *    以 `ToExpression["<json-escaped>", InputForm]` 还原——绝不 shell、绝不文件导入；
 *  - adapter 控制 $Assumptions / TimeConstrained / MemoryConstrained / JSON 序列化；
 *  - 返回 held-expression 结果、assumptions、$Messages 与内核版本；
 *  - license 数据只来自服务端 env（PTH_WOLFRAM_LICENSE_PROVIDER 指向的 provider），
 *    绝不进入任务载荷、产物或日志。
 *
 * 无 licensed kernel：probe.available=false 且 reason=license-unavailable——测试如实
 * 记录 EVALUATION-INCOMPLETE，绝不 skip、绝不用 SymPy 冒充。
 */
import { pthConfig } from "@away_from/pth-config";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ExecutionBackend } from "@away_from/shared/execution";
import { execViaBackend, resolveExecutionBackend, unavailableAdapterExec, type AdapterExecFn, type AdapterExecResult } from "../exec-via-backend.js";
import {
  isWolframJobSpecStructurallyValid,
  type ArtifactRef,
  type ProfessionalDiagnostic,
  type ProfessionalJobRequest,
  type ProfessionalJobResult,
  type WolframJobSpec,
} from "@away_from/pth-contracts";
import type { ProfessionalRuntimeAdapter } from "../professional-runtime.js";
import { cancelJob, createJobRunContext, sha256hex } from "./job-runner.js";
import type { ProfessionalArtifactPort } from "@away_from/pth-contracts";


export type WolframExecResult = AdapterExecResult;
export type WolframExecFn = AdapterExecFn;

export interface WolframJobValue {
  readonly operation: WolframJobSpec["operation"];
  readonly result: string;
  readonly assumptions: readonly string[];
  readonly messages: readonly string[];
  readonly numericVerification: string | null;
  readonly toolchain: { readonly wolfram: string };
}

export interface CreateWolframRuntimeAdapterDeps {
  readonly artifactPort: ProfessionalArtifactPort;
  /** committed lock 中 wolfram 条目版本（如 "14.2.0"）。 */
  readonly lockVersion: string;
  /** 服务端 kernel 路径（PTH_WOLFRAM_KERNEL_PATH）；空 = license-unavailable。 */
  readonly kernelPath?: string;
  /** license provider 标识；其密钥由运行时环境注入，adapter 不读取值。 */
  readonly licenseProvider?: string;
  readonly workDir?: string;
  readonly execPrefix?: readonly string[];
  /** execution/v1 执行面（优先于 execPrefix 的兼容解析） */
  readonly executionBackend?: ExecutionBackend;
  readonly exec?: WolframExecFn;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly clock?: () => Date;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const VERSION_RE = /WolframScript\s+([0-9]+\.[0-9]+(?:\.[0-9]+)?)/;

export function createWolframRuntimeAdapter(deps: CreateWolframRuntimeAdapterDeps): ProfessionalRuntimeAdapter<WolframJobSpec, WolframJobValue> {
  const clock = deps.clock ?? (() => new Date());
  const workDir = resolve(deps.workDir ?? pthConfig().str("PTH_WORKSPACES_PATH") ?? join(tmpdir(), "pth-wolfram-jobs"));
  const kernelPath = deps.kernelPath ?? pthConfig().str("PTH_WOLFRAM_KERNEL_PATH") ?? "";
  const licenseProvider = deps.licenseProvider ?? pthConfig().str("PTH_WOLFRAM_LICENSE_PROVIDER") ?? "";
  const timeoutMs = Math.min(Math.max(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS, 100), 600_000);
  const maxOutputBytes = deps.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const running = new Map<string, { cancelled: boolean }>();


  function makeExec(): WolframExecFn {
    if (deps.exec) return deps.exec;
    const backend = resolveExecutionBackend({ executionBackend: deps.executionBackend, execPrefix: deps.execPrefix });
    const viaBackend: AdapterExecFn = backend
      ? execViaBackend(backend)
      : unavailableAdapterExec("wolfram: no execution backend configured");
    return async (cmd, args, opts = {}) =>
      viaBackend(cmd, args, {
        cwd: opts.cwd,
        timeoutMs: opts.timeoutMs ?? timeoutMs,
        maxOutputBytes: opts.maxOutputBytes ?? maxOutputBytes,
      });
  }

  const exec = makeExec();

  async function probe(): Promise<{ available: boolean; version: string; releaseChannel: "stable"; reason?: string }> {
    if (kernelPath.trim() === "") {
      return { available: false, version: "", releaseChannel: "stable", reason: "license-unavailable: PTH_WOLFRAM_KERNEL_PATH 未配置（EVALUATION-INCOMPLETE，需要 licensed kernel）" };
    }
    if (licenseProvider.trim() === "") {
      return { available: false, version: "", releaseChannel: "stable", reason: "license-unavailable: PTH_WOLFRAM_LICENSE_PROVIDER 未配置" };
    }
    const versionRun = await exec(kernelPath, ["-version"], { timeoutMs: 30_000 });
    if (!versionRun.ok) {
      return { available: false, version: "", releaseChannel: "stable", reason: `license-unavailable: kernel 探测失败: ${versionRun.stderr.slice(0, 300)}` };
    }
    const m = VERSION_RE.exec(`${versionRun.stdout}\n${versionRun.stderr}`);
    if (!m) {
      return { available: false, version: "", releaseChannel: "stable", reason: `kernel 版本不可解析: ${versionRun.stdout.slice(0, 200)}` };
    }
    const version = m[1]!;
    if (version !== deps.lockVersion) {
      return { available: false, version, releaseChannel: "stable", reason: `Wolfram 版本 ${version} 与 committed lock ${deps.lockVersion} 不一致` };
    }
    return { available: true, version, releaseChannel: "stable" };
  }

  async function execute(request: ProfessionalJobRequest<WolframJobSpec>): Promise<ProfessionalJobResult<WolframJobValue>> {
    const ctx = createJobRunContext<WolframJobValue>({
      runtime: "wolfram",
      runtimeVersion: deps.lockVersion,
      request,
      artifactPort: deps.artifactPort,
      running,
      clock,
    });

    try {
      if (!isWolframJobSpecStructurallyValid(request.spec)) {
        return ctx.fail("spec-invalid", "spec 不是合法 WolframJobSpec（禁 command/shell/import 键或字段越界）");
      }
      const spec = request.spec;

      const probeResult = await probe();
      if (!probeResult.available) {
        return ctx.finish("unavailable", { code: "license-unavailable", message: probeResult.reason ?? "licensed Wolfram kernel 不可用" });
      }

      const jobDir = join(workDir, `wolfram-${request.jobId.replace(/[^A-Za-z0-9._-]/g, "_")}`);
      await rm(jobDir, { recursive: true, force: true });
      await mkdir(jobDir, { recursive: true });

      const escapedExpression = JSON.stringify(spec.expression);
      const assumptions = (spec.assumptions ?? []).map((a) => JSON.stringify(a)).join(", ");
      const wl = [
        `SetOptions[$FrontEnd, {}];`,
        `$Assumptions = {${assumptions}};`,
        `expr = ToExpression[${escapedExpression}, InputForm];`,
        `res = TimeConstrained[MemoryConstrained[Evaluate[expr], 512*1024*1024], ${Math.floor(timeoutMs / 1000)}];`,
        `msgs = Join @@ (Messages[#] & /@ Unique[]);`,
        `ExportString[{InputForm[res], $VersionNumber, msgs}, "JSON"]`,
      ].join("\n");
      const wlPath = join(jobDir, "job.wl");
      await writeFile(wlPath, wl, "utf8");

      const run = await exec(kernelPath, ["-script", wlPath], { cwd: jobDir, timeoutMs, maxOutputBytes });
      if (run.timedOut) return ctx.fail("evaluate-timeout", `Wolfram 计算超过 ${timeoutMs}ms`);
      if (!run.ok) {
        return ctx.fail("evaluate-failed", `Wolfram 执行失败: ${run.stderr.slice(0, 800)}`);
      }

      let parsed: [string, string, string[]];
      try {
        parsed = JSON.parse(run.stdout.trim()) as [string, string, string[]];
      } catch {
        return ctx.fail("evaluate-failed", `Wolfram 输出不可解析: ${run.stdout.slice(0, 400)}`);
      }
      const [result, version, messages] = parsed;

      await deps.artifactPort.putOutput({
        tenantId: request.tenantId, jobId: request.jobId, kind: "source", mediaType: "application/vnd.wolfram", bytes: new TextEncoder().encode(wl),
      });
      await deps.artifactPort.putOutput({
        tenantId: request.tenantId, jobId: request.jobId, kind: "run-log", mediaType: "application/json",
        bytes: new TextEncoder().encode(JSON.stringify({ result, version, messages, assumptions: spec.assumptions ?? [] }, null, 2)),
      });

      const value: WolframJobValue = {
        operation: spec.operation,
        result,
        assumptions: spec.assumptions ?? [],
        messages,
        numericVerification: spec.operation === "verify" ? result : null,
        toolchain: { wolfram: version },
      };
      return ctx.finish("succeeded", undefined, value, `${result}\n${messages.join("\n")}\n${version}`);
    } catch (error) {
      return ctx.fail("evaluate-failed", `wolfram adapter 意外错误: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      ctx.cleanup();
    }
  }

  async function cancel(jobId: string): Promise<boolean> {
    return cancelJob(running, jobId);
  }

  return { id: "wolfram", probe, execute, cancel };
}
