/**
 * execution/adapters/jupyter-runtime-adapter.ts — v1.3 Task 9 Jupyter 教程执行适配器。
 *
 * `createJupyterRuntimeAdapter()` 实现 clean-kernel execute-all（等价 "Restart Kernel
 * and Run All"）：
 *  - spec 结构校验复用 contracts 的 isJupyterJobSpecStructurallyValid（无任意 command）；
 *  - 草稿 notebook 只经 artifactPort 读取（artifact:// 租户命名空间）；
 *  - 执行前清空全部 outputs/execution_count——历史输出不能替代本轮执行记录；
 *  - 草稿复制进 fresh workspace（每 job 独立目录），driver.py（jupyter-guide 扩展）
 *    随 workspace 落盘后用执行通道运行 nbclient——每次 execute() 都是全新 kernel；
 *  - 超时护栏（per-cell + 子进程双重）；执行后三扫（secrets/宿主绝对路径/超限输出）；
 *  - expected checks（spec.parameters.expectedChecksJson，[{name, expected}]）逐条
 *    比对本轮真实输出文本，缺一即 failed；
 *  - 产出 executed-notebook 与 execution-report 两类 artifact；probe 校验
 *    jupyter-notebook 版本 == committed lock（不一致 = unavailable，绝不伪造）。
 *
 * 执行通道可注入（execPrefix / exec / pathForExec）：生产在 jupyter 服务容器内直跑；
 * 测试在 macOS 宿主注入 `docker exec pi-platform-jupyter-1` 前缀与宿主→容器路径翻译。
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ExecutionBackend } from "@away_from/shared/execution";
import { execViaBackend, resolveExecutionBackend, unavailableAdapterExec, type AdapterExecFn } from "../exec-via-backend.js";
import {
  isJupyterJobSpecStructurallyValid,
  type ArtifactRef,
  type JupyterJobSpec,
  type ProfessionalArtifactPort,
  type ProfessionalDiagnostic,
  type ProfessionalJobRequest,
  type ProfessionalJobResult,
} from "../../contracts/index.js";
import { pthConfig } from "../../config/index.js";
import type { ProfessionalRuntimeAdapter } from "../professional-runtime.js";
import { scanNotebook, type NotebookCell, type NotebookDocument, type NotebookOutput } from "../notebook-guide.js";

// ─── 执行通道 ──────────────────────────────────────────────────────────────

export interface JupyterExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
  error?: string;
}

export type JupyterExecFn = (
  cmd: string,
  args: readonly string[],
  opts: { cwd?: string; timeoutMs?: number },
) => Promise<JupyterExecResult>;

const DEFAULT_DRIVER_PATH = fileURLToPath(
  new URL("../../../../toolstore/extensions/jupyter-guide/execute.py", import.meta.url),
);
const DEFAULT_EXEC_TIMEOUT_MS = 600_000;
const DEFAULT_CELL_TIMEOUT_S = 300;
const NOTEBOOK_VERSION_RE = /([0-9]+\.[0-9]+\.[0-9]+)/;

export interface JupyterExpectedCheck {
  readonly name: string;
  readonly expected: string;
}

export interface JupyterCheckOutcome {
  readonly name: string;
  readonly expected: string;
  readonly matched: boolean;
}

export interface JupyterJobValue {
  readonly operation: JupyterJobSpec["operation"];
  readonly kernelId: string;
  readonly cleanKernel: true;
  readonly cellsExecuted: number;
  readonly codeCells: number;
  readonly checks: readonly JupyterCheckOutcome[];
  readonly scan: { readonly secrets: number; readonly absolutePaths: number; readonly oversizedOutputs: number };
  readonly executedNotebookHash: string;
  readonly timedOut: boolean;
}

export interface CreateJupyterRuntimeAdapterDeps {
  readonly artifactPort: ProfessionalArtifactPort;
  /** committed lock 中 jupyter 条目的版本（如 "7.2.2"）。 */
  readonly lockVersion: string;
  /** job workspace 根（宿主侧路径；执行通道侧经 pathForExec 翻译）。 */
  readonly workDir?: string;
  /** clean-kernel 驱动脚本（缺省为 toolstore/extensions/jupyter-guide/execute.py）。 */
  readonly driverPath?: string;
  /** 命令前缀（如 ["docker","exec","-i","pi-platform-jupyter-1"]）。 */
  readonly execPrefix?: readonly string[];
  /** execution/v1 执行面（优先于 execPrefix 的兼容解析） */
  readonly executionBackend?: ExecutionBackend;
  /** 完全自定义 runner（优先于 execPrefix）。 */
  readonly exec?: JupyterExecFn;
  /** 宿主路径 → 执行通道路径翻译（容器挂载前缀不同步时注入；缺省恒等）。 */
  readonly pathForExec?: (hostPath: string) => string;
  readonly execTimeoutMs?: number;
  readonly cellTimeoutS?: number;
  readonly maxOutputBytes?: number;
  readonly clock?: () => Date;
}

interface ExecutionReport {
  readonly ok: boolean;
  readonly timedOut: boolean;
  readonly cellsExecuted: number;
  readonly codeCells: number;
  readonly errors: readonly { readonly ename: string; readonly evalue: string }[];
  readonly durationMs: number;
}

// ─── 构造器 ────────────────────────────────────────────────────────────────

export function createJupyterRuntimeAdapter(
  deps: CreateJupyterRuntimeAdapterDeps,
): ProfessionalRuntimeAdapter<JupyterJobSpec, JupyterJobValue> {
  const clock = deps.clock ?? (() => new Date());
  const workDir = resolve(deps.workDir ?? pthConfig().str("PTH_WORKSPACES_PATH") ?? join(tmpdir(), "pth-jupyter-jobs"));
  const pathForExec = deps.pathForExec ?? ((p: string) => p);
  const execTimeoutMs = Math.min(Math.max(deps.execTimeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS, 1_000), 3_600_000);
  const cellTimeoutS = Math.min(Math.max(deps.cellTimeoutS ?? DEFAULT_CELL_TIMEOUT_S, 1), 3_600);
  const running = new Map<string, { cancelled: boolean }>();

  const sha256hex = (s: Uint8Array | string) => createHash("sha256").update(s).digest("hex");

  const execPrefix: readonly string[] | undefined = deps.execPrefix;

  function makeExec(): JupyterExecFn {
    if (deps.exec) return deps.exec;
    const backend = resolveExecutionBackend({ executionBackend: deps.executionBackend, execPrefix });
    const viaBackend: AdapterExecFn = backend
      ? execViaBackend(backend)
      : unavailableAdapterExec("jupyter: no execution backend configured");
    return async (cmd, args, opts = {}) =>
      viaBackend(cmd, args, {
        cwd: opts.cwd,
        timeoutMs: opts.timeoutMs ?? execTimeoutMs,
        maxOutputBytes: deps.maxOutputBytes,
      });
  }

  const exec = makeExec();

  // ─── probe ────────────────────────────────────────────────────────────────

  async function probe(): Promise<{ available: boolean; reason?: string; version: string; releaseChannel: "stable" }> {
    const ver = await exec("jupyter-notebook", ["--version"], { timeoutMs: 30_000 });
    if (!ver.ok) {
      return { available: false, reason: `jupyter-notebook 不可执行: ${ver.error ?? ver.stderr ?? `exit ${ver.code}`}`, version: "", releaseChannel: "stable" };
    }
    const m = NOTEBOOK_VERSION_RE.exec(`${ver.stdout}\n${ver.stderr}`);
    if (!m) {
      return { available: false, reason: `jupyter-notebook 版本不可解析: ${ver.stdout.slice(0, 200)}`, version: "", releaseChannel: "stable" };
    }
    const version = m[1]!;
    if (version !== deps.lockVersion) {
      return {
        available: false,
        reason: `jupyter-notebook 版本 ${version} 与 committed lock ${deps.lockVersion} 不一致`,
        version,
        releaseChannel: "stable",
      };
    }
    const libs = await exec("python3", ["-c", "import jupyter_client, nbformat, nbclient"], { timeoutMs: 30_000 });
    if (!libs.ok) {
      return { available: false, reason: `python 执行栈缺失（jupyter_client/nbformat/nbclient）: ${libs.stderr.slice(0, 200)}`, version, releaseChannel: "stable" };
    }
    return { available: true, version, releaseChannel: "stable" };
  }

  // ─── 内部工具 ─────────────────────────────────────────────────────────────

  function clearOutputs(notebook: NotebookDocument): NotebookDocument {
    return {
      ...notebook,
      cells: notebook.cells.map((cell): NotebookCell => {
        if (cell.cell_type !== "code") return cell;
        return { ...cell, execution_count: null, outputs: [] };
      }),
    };
  }

  function executedOutputText(notebook: NotebookDocument): string {
    const parts: string[] = [];
    for (const cell of notebook.cells) {
      for (const output of cell.outputs ?? []) {
        const o = output as NotebookOutput & { text?: unknown; evalue?: unknown; data?: unknown };
        const text = o.text ?? o.evalue ?? (o.data !== undefined ? JSON.stringify(o.data) : "");
        parts.push(typeof text === "string" ? text : Array.isArray(text) ? text.join("") : JSON.stringify(text));
      }
    }
    return parts.join("\n");
  }

  function parseExpectedChecks(spec: JupyterJobSpec): JupyterExpectedCheck[] | null {
    const raw = spec.parameters?.["expectedChecksJson"];
    if (raw === undefined) return [];
    if (typeof raw !== "string") return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return null;
      const checks: JupyterExpectedCheck[] = [];
      for (const item of parsed) {
        if (typeof item !== "object" || item === null) return null;
        const rec = item as Record<string, unknown>;
        if (typeof rec.name !== "string" || rec.name.trim() === "") return null;
        if (typeof rec.expected !== "string" || rec.expected === "") return null;
        checks.push({ name: rec.name, expected: rec.expected });
      }
      return checks;
    } catch {
      return null;
    }
  }

  // ─── execute ──────────────────────────────────────────────────────────────

  async function execute(request: ProfessionalJobRequest<JupyterJobSpec>): Promise<ProfessionalJobResult<JupyterJobValue>> {
    const startedAt = clock();
    const traceId = request.traceId ?? "unknown";
    const artifacts: ArtifactRef[] = [];
    const diagnostics: ProfessionalDiagnostic[] = [];
    let outputBytes = 0;
    const state = { cancelled: false };
    running.set(request.jobId, state);

    const finish = (
      status: ProfessionalJobResult["status"],
      error: { code: string; message: string } | undefined,
      value?: JupyterJobValue,
      outputHashSource?: Uint8Array | string,
    ): ProfessionalJobResult<JupyterJobValue> => {
      const finishedAt = clock();
      if (error) diagnostics.push({ code: error.code, severity: "error", message: error.message });
      return {
        status,
        runtime: "jupyter",
        runtimeVersion: deps.lockVersion,
        inputHash: request.inputHash,
        outputHash: status === "succeeded" && outputHashSource !== undefined ? `sha256:${sha256hex(outputHashSource)}` : null,
        artifacts,
        diagnostics,
        usage: { durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()), cpuMs: 0, maxRssBytes: 0, outputBytes },
        traceId,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        ...(value !== undefined ? { value } : {}),
        ...(error !== undefined ? { error } : {}),
      };
    };

    const fail = (code: string, message: string): ProfessionalJobResult<JupyterJobValue> =>
      finish("failed", { code, message: message.slice(0, 4_000) });

    const put = async (kind: string, bytes: Uint8Array, mediaType: string): Promise<ArtifactRef> => {
      const ref = await deps.artifactPort.putOutput({ tenantId: request.tenantId, jobId: request.jobId, kind, mediaType, bytes });
      artifacts.push(ref);
      outputBytes += bytes.byteLength;
      return ref;
    };

    try {
      if (!isJupyterJobSpecStructurallyValid(request.spec)) {
        return fail("spec-invalid", "spec does not match the jupyter discriminated job spec");
      }
      const spec = request.spec;
      const checks = parseExpectedChecks(spec);
      if (checks === null) return fail("checks-invalid", "parameters.expectedChecksJson is not a [{name, expected}] JSON array");

      // 1. 读取草稿并清空历史输出（历史输出不能替代本轮执行记录）。
      let draft: NotebookDocument;
      try {
        const bytes = await deps.artifactPort.getInput(request.tenantId, spec.notebookRef);
        draft = JSON.parse(Buffer.from(bytes).toString("utf8")) as NotebookDocument;
      } catch (error) {
        return fail("notebook-unreadable", `cannot read notebook artifact: ${(error as Error).message}`);
      }
      if (draft.nbformat !== 4 || !Array.isArray(draft.cells)) {
        return fail("nbformat-invalid", "draft notebook must be nbformat v4 with a cells array");
      }
      const preScan = scanNotebook(draft, { maxOutputBytes: deps.maxOutputBytes ?? 128 * 1024 });
      if (preScan.secrets.length > 0 || preScan.absolutePaths.length > 0) {
        return fail(
          "notebook-scan-failed",
          `draft contains hidden state: secrets=${preScan.secrets.length} absolutePaths=${preScan.absolutePaths.length}`,
        );
      }
      const cleaned = clearOutputs(draft);

      // 2. fresh workspace：复制草稿 + driver，独立目录。
      const wsHost = join(workDir, request.jobId);
      await rm(wsHost, { recursive: true, force: true });
      await mkdir(wsHost, { recursive: true });
      const cleanedBytes = Buffer.from(JSON.stringify(cleaned, null, 1), "utf8");
      await writeFile(join(wsHost, "draft.ipynb"), cleanedBytes);
      const driverSource = await readFile(deps.driverPath ?? DEFAULT_DRIVER_PATH);
      await writeFile(join(wsHost, "driver.py"), driverSource);

      if (state.cancelled) return finish("cancelled", { code: "cancelled", message: "job cancelled before kernel start" });

      // 3. clean-kernel execute-all（driver 内 nbclient 每次全新 kernel）。
      const run = await exec(
        "python3",
        [
          "driver.py",
          "--input", "draft.ipynb",
          "--output", "executed.ipynb",
          "--report", "report.json",
          "--kernel", spec.kernel,
          "--timeout", String(cellTimeoutS),
        ],
        { cwd: pathForExec(wsHost), timeoutMs: execTimeoutMs },
      );
      if (state.cancelled) return finish("cancelled", { code: "cancelled", message: "job cancelled" });
      if (run.timedOut) {
        return fail("execution-timeout", `clean-kernel execute-all exceeded ${execTimeoutMs}ms`);
      }

      let report: ExecutionReport;
      let executedRaw: Buffer;
      try {
        report = JSON.parse(await readFile(join(wsHost, "report.json"), "utf8")) as ExecutionReport;
        executedRaw = await readFile(join(wsHost, "executed.ipynb"));
      } catch (error) {
        return fail("driver-failed", `driver produced no report/executed notebook: ${(error as Error).message}; stderr=${run.stderr.slice(0, 400)}`);
      }

      // 4. 执行报告门：单元格错误 / 超时 → failed（隐藏状态失败可见）。
      if (!report.ok) {
        const first = report.errors[0];
        const code = report.timedOut ? "cell-timeout" : "cell-error";
        await put("execution-report", Buffer.from(JSON.stringify(report, null, 1), "utf8"), "application/json");
        return fail(code, `${first?.ename ?? "unknown"}: ${(first?.evalue ?? "").slice(0, 800)}`);
      }

      // 5. 三扫本轮执行产物。
      let executed: NotebookDocument;
      try {
        executed = JSON.parse(executedRaw.toString("utf8")) as NotebookDocument;
      } catch {
        return fail("executed-notebook-invalid", "executed notebook is not valid JSON");
      }
      const postScan = scanNotebook(executed, { maxOutputBytes: deps.maxOutputBytes ?? 128 * 1024 });
      if (postScan.secrets.length > 0 || postScan.absolutePaths.length > 0 || postScan.oversizedOutputs.length > 0) {
        return fail(
          "notebook-scan-failed",
          `executed notebook scan: secrets=${postScan.secrets.length} absolutePaths=${postScan.absolutePaths.length} oversizedOutputs=${postScan.oversizedOutputs.length}`,
        );
      }

      // 6. expected checks 比对本轮真实输出。
      const outputText = executedOutputText(executed);
      const outcomes: JupyterCheckOutcome[] = checks.map((check) => ({
        name: check.name,
        expected: check.expected,
        matched: outputText.includes(check.expected),
      }));
      const missed = outcomes.filter((o) => !o.matched);
      if (missed.length > 0) {
        await put("execution-report", Buffer.from(JSON.stringify(report, null, 1), "utf8"), "application/json");
        return fail("checks-failed", `expected checks missing from this run's outputs: ${missed.map((m) => m.name).join(", ")}`);
      }

      // 7. 产出 artifact + 成功信封。
      const reportBytes = Buffer.from(JSON.stringify(report, null, 1), "utf8");
      await put("executed-notebook", new Uint8Array(executedRaw), "application/x-ipynb+json");
      await put("execution-report", new Uint8Array(reportBytes), "application/json");
      const executedNotebookHash = `sha256:${sha256hex(new Uint8Array(executedRaw))}`;
      return finish("succeeded", undefined, {
        operation: spec.operation,
        kernelId: spec.kernel,
        cleanKernel: true,
        cellsExecuted: report.cellsExecuted,
        codeCells: report.codeCells,
        checks: outcomes,
        scan: {
          secrets: postScan.secrets.length,
          absolutePaths: postScan.absolutePaths.length,
          oversizedOutputs: postScan.oversizedOutputs.length,
        },
        executedNotebookHash,
        timedOut: false,
      }, new Uint8Array(executedRaw));
    } catch (error) {
      return fail("adapter-error", (error as Error).message);
    } finally {
      running.delete(request.jobId);
    }
  }

  async function cancel(jobId: string): Promise<boolean> {
    const state = running.get(jobId);
    if (!state) return false;
    state.cancelled = true;
    return true;
  }

  return { id: "jupyter", probe, execute, cancel };
}
