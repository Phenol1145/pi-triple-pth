/**
 * execution/adapters/u8-runtime-adapter.ts —— U8-1（u8proj 本地执行器 wiring）。
 *
 * `createU8RuntimeAdapter()` 把 `U8JobSpec` 的白名单操作（compile / run / compile-run）
 * 映射为固定命令序列（u8 compile → u8 run --reg/--io），绝不接受任意 command/argv：
 *  - spec 结构校验复用 contracts 的 isU8JobSpecStructurallyValid（禁 command 等键）；
 *  - 源码/二进制只经 artifactPort 读取（artifact:// 租户命名空间），大小上限可配；
 *  - 初始寄存器/I/O 注入只在白名单键与 0–255 字节值内展开为 argv（不拼 shell 文本）；
 *  - compile 成功要求退出码 0 且 stdout 出现 "Compile successfully."；
 *    run 成功要求退出码 0 且 stdout 不含 u8 VM 的已知错误标记（u8 CLI 错误路径也返回 0）；
 *  - probe 校验 `u8 version` 输出与 committed lock 完全一致；
 *  - 产出 source/programme/run-log 三类 artifact（经 artifactPort 落租户树）。
 *
 * 命令执行通道统一经 execution/v1.1 执行面（executionBackend，生产 = local-u8：
 * profile=host，pathMapping /data/workspaces）；无 backend/prefix → probe unavailable
 * （P1 硬切，不隐式直跑）。U8-2 的 interactive/debug 语义随 P4 persistent 实现。
 */

import { pthConfig } from "@away_from/pth-config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { ExecutionBackend } from "@away_from/shared/execution";
import { execViaBackend, resolveExecutionBackend, unavailableAdapterExec, type AdapterExecFn } from "../exec-via-backend.js";
import {
  isU8JobSpecStructurallyValid,
  U8_OPERATIONS,
  U8_REG_KEYS,
  type ArtifactRef,
  type ProfessionalDiagnostic,
  type ProfessionalJobRequest,
  type ProfessionalJobResult,
  type U8JobSpec,
  type U8Operation,
  type U8RegKey,
} from "@away_from/pth-contracts";
import type { ProfessionalRuntimeAdapter } from "../professional-runtime.js";
import { createJobRunContext } from "./job-runner.js";
import type { ProfessionalArtifactPort } from "@away_from/pth-contracts";

// ─── 执行通道 ──────────────────────────────────────────────────────────────

export interface U8ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
  error?: string;
}

export type U8ExecFn = (
  cmd: string,
  args: readonly string[],
  opts: { cwd?: string; timeoutMs?: number; maxOutputBytes?: number },
) => Promise<U8ExecResult>;

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_MAX_SOURCE_BYTES = 256 * 1024;
const DEFAULT_MAX_PROGRAMME_BYTES = 1024 * 1024;
const DEFAULT_COMPILE_TIMEOUT_MS = 30_000;
const DEFAULT_RUN_TIMEOUT_MS = 10_000;

const U8_VERSION_RE = /U8 version:([0-9]+\.[0-9]+\.[0-9]+)/;
const COMPILE_SUCCESS_MARKER = "Compile successfully.";
const RUN_ERROR_MARKER_RE =
  /Cannot open programme file!|This file is not U8 programme file!|Error occurred when (?:creating U8 VM|writing I\/O port|loading code|running the machine)!/;

const REG_ARG_ORDER: readonly U8RegKey[] = U8_REG_KEYS;

const sha256hex = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
const safeComponent = (value: string): string => value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128) || "_";

function ioPortToDecimal(key: string): number {
  const upper = key.toUpperCase();
  if (/^[0-9]$/.test(upper) || /^1[0-5]$/.test(upper)) return Number.parseInt(upper, 10);
  return upper.charCodeAt(0) - "A".charCodeAt(0) + 10;
}

function buildInitialArgs(spec: U8JobSpec): string[] {
  const args: string[] = [];
  for (const key of REG_ARG_ORDER) {
    const value = spec.regs?.[key];
    if (value === undefined) continue;
    args.push("--reg", `${key}=${value}`);
  }
  const ioEntries = Object.entries(spec.io ?? {}).sort(([a], [b]) => ioPortToDecimal(a) - ioPortToDecimal(b));
  for (const [key, value] of ioEntries) {
    args.push("--io", `${ioPortToDecimal(key)}=${value}`);
  }
  return args;
}

// ─── 构造器 ────────────────────────────────────────────────────────────────

export interface CreateU8RuntimeAdapterDeps {
  readonly artifactPort: ProfessionalArtifactPort;
  /** committed lock 中 u8 条目的版本（如 "0.0.2"）。 */
  readonly lockVersion: string;
  /** job workspace 根（执行通道可见；缺省 PTH_WORKSPACES_PATH → tmpdir）。 */
  readonly workDir?: string;
  /** execution/v1.1 执行面（生产 = local-u8；缺省且无 prefix → unavailable）。 */
  readonly executionBackend?: ExecutionBackend;
  /** docker exec 前缀兼容（测试/容器注入）；P1 硬切下生产不使用。 */
  readonly execPrefix?: readonly string[];
  /** 完全自定义 runner（优先于 backend/prefix）。 */
  readonly exec?: U8ExecFn;
  readonly compileTimeoutMs?: number;
  readonly runTimeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly maxSourceBytes?: number;
  readonly maxProgrammeBytes?: number;
  readonly clock?: () => Date;
}

export interface U8JobValue {
  readonly operation: U8Operation;
  readonly compileStdout: string;
  readonly runStdout: string;
  readonly runExitCode: number;
  readonly toolchain: { readonly u8: string };
}

export function createU8RuntimeAdapter(
  deps: CreateU8RuntimeAdapterDeps,
): ProfessionalRuntimeAdapter<U8JobSpec, U8JobValue> {
  if (typeof deps.artifactPort !== "object" || deps.artifactPort === null) {
    throw new Error("u8 adapter: artifactPort is required");
  }
  if (typeof deps.lockVersion !== "string" || deps.lockVersion.trim() === "") {
    throw new Error("u8 adapter: lockVersion is required");
  }
  const clock = deps.clock ?? (() => new Date());
  const workDir = resolve(deps.workDir ?? pthConfig().str("PTH_WORKSPACES_PATH") ?? join(tmpdir(), "pth-u8-jobs"));
  const compileTimeoutMs = Math.min(Math.max(deps.compileTimeoutMs ?? DEFAULT_COMPILE_TIMEOUT_MS, 100), 600_000);
  const runTimeoutMs = Math.min(Math.max(deps.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS, 100), 300_000);
  const maxOutputBytes = Math.min(Math.max(deps.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES, 1), MAX_OUTPUT_BYTES);
  const maxSourceBytes = Math.min(Math.max(deps.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES, 1), MAX_OUTPUT_BYTES);
  const maxProgrammeBytes = Math.min(Math.max(deps.maxProgrammeBytes ?? DEFAULT_MAX_PROGRAMME_BYTES, 1), MAX_OUTPUT_BYTES);
  const running = new Map<string, { cancelled: boolean }>();

  function makeExec(): U8ExecFn {
    if (deps.exec) return deps.exec;
    const prefix = deps.execPrefix ?? (() => {
      const env = pthConfig().str("PTH_U8_TOOLCHAIN_EXEC");
      return env && env.trim() !== "" ? env.split(" ").filter(Boolean) : undefined;
    })();
    const backend = resolveExecutionBackend({ executionBackend: deps.executionBackend, execPrefix: prefix });
    const viaBackend: AdapterExecFn = backend
      ? execViaBackend(backend)
      : unavailableAdapterExec("u8: no execution backend configured");
    return async (cmd, args, opts = {}) => {
      const timeoutMs = opts.timeoutMs ?? runTimeoutMs;
      const r = await viaBackend(cmd, args, {
        cwd: opts.cwd,
        timeoutMs,
        maxOutputBytes: opts.maxOutputBytes ?? maxOutputBytes,
      });
      if (r.ok) return { ok: true, stdout: r.stdout, stderr: r.stderr, code: 0, timedOut: false };
      if (r.timedOut) {
        return {
          ok: false,
          stdout: r.stdout,
          stderr: r.stderr,
          code: r.code,
          timedOut: true,
          error: `timed out after ${timeoutMs}ms: ${r.stderr.slice(0, 400)}`,
        };
      }
      return {
        ok: false,
        stdout: r.stdout,
        stderr: r.stderr,
        code: r.code,
        timedOut: false,
        error: (r.error ?? r.stderr).slice(0, 800),
      };
    };
  }

  const exec = makeExec();

  async function probe(): Promise<{ available: boolean; version: string; releaseChannel: "stable"; reason?: string }> {
    const r = await exec("u8", ["version"], { timeoutMs: 10_000, maxOutputBytes: 4_096 });
    if (!r.ok) {
      return {
        available: false,
        version: "",
        releaseChannel: "stable",
        reason: `u8 不可执行: ${r.error ?? r.stderr ?? `exit ${r.code}`}`,
      };
    }
    const m = U8_VERSION_RE.exec(`${r.stdout}\n${r.stderr}`);
    if (!m) {
      return {
        available: false,
        version: "",
        releaseChannel: "stable",
        reason: `u8 版本不可解析: ${r.stdout.slice(0, 200)}`,
      };
    }
    const version = m[1]!;
    if (version !== deps.lockVersion) {
      return {
        available: false,
        version,
        releaseChannel: "stable",
        reason: `u8 版本 ${version} 与 committed lock ${deps.lockVersion} 不一致`,
      };
    }
    return { available: true, version, releaseChannel: "stable" };
  }

  async function execute(request: ProfessionalJobRequest<U8JobSpec>): Promise<ProfessionalJobResult<U8JobValue>> {
    const ctx = createJobRunContext<U8JobValue>({
      runtime: "u8",
      runtimeVersion: deps.lockVersion,
      request,
      artifactPort: deps.artifactPort,
      running,
      clock,
    });

    try {
      // ── 门禁 1：spec 结构（禁 command/argv/shell；reg/io 白名单与字节范围）──
      if (!isU8JobSpecStructurallyValid(request.spec)) {
        return ctx.fail("spec-invalid", "spec 不是合法的 U8JobSpec（含禁键、字段越界或 operation 与 artifact 引用不匹配）");
      }
      const spec = request.spec;

      // ── 门禁 2：工具链 probe（版本与 committed lock 一致）──
      const probeResult = await probe();
      if (!probeResult.available) {
        return ctx.fail("toolchain-unavailable", probeResult.reason ?? "u8 工具链不可用");
      }
      const u8Version = probeResult.version;

      // ── 门禁 3：工作目录（engine 侧创建；local-u8 pathMapping 把 cwd 翻译到宿主）──
      const jobDir = join(workDir, safeComponent(request.tenantId), safeComponent(request.jobId));
      try {
        await mkdir(jobDir, { recursive: true });
      } catch (error) {
        return ctx.fail("workspace-error", `job 目录创建失败: ${error instanceof Error ? error.message : String(error)}`);
      }

      const wantsCompile = spec.operation === "compile" || spec.operation === "compile-run";
      const wantsRun = spec.operation === "run" || spec.operation === "compile-run";

      let sourceBytes: Uint8Array | null = null;
      let programmeBytes: Uint8Array | null = null;
      let compileStdout = "";
      let runStdout = "";
      let runStderr = "";
      let runExitCode = 0;

      if (wantsCompile) {
        // ── 源码只经 artifact 端口读取 ──
        try {
          sourceBytes = await deps.artifactPort.getInput(request.tenantId, spec.sourceRef!);
        } catch (error) {
          return ctx.fail("source-unreadable", `sourceRef 读取失败: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (sourceBytes.byteLength === 0) return ctx.fail("source-empty", "sourceRef 指向空源码");
        if (sourceBytes.byteLength > maxSourceBytes) {
          return ctx.fail("source-too-large", `源码 ${sourceBytes.byteLength}B 超过上限 ${maxSourceBytes}B`);
        }
        await writeFile(join(jobDir, "source.u8asm"), sourceBytes);
        await ctx.put("source", sourceBytes, "text/x-u8asm");

        const c = await exec("u8", ["compile", "source.u8asm", "programme.u8programme"], {
          cwd: jobDir,
          timeoutMs: compileTimeoutMs,
          maxOutputBytes,
        });
        compileStdout = `${c.stdout}${c.stderr}`;
        if (!c.ok || !c.stdout.includes(COMPILE_SUCCESS_MARKER)) {
          return ctx.fail(
            "compile-failed",
            `u8 compile 失败（exit ${c.code ?? "null"}${c.timedOut ? ", timed out" : ""}）: ${(c.error ?? `${c.stdout}\n${c.stderr}`).slice(0, 2_000)}`,
          );
        }
        if (ctx.isCancelled()) return ctx.finish("cancelled", { code: "job-cancelled", message: "job cancelled after compile" });

        try {
          programmeBytes = new Uint8Array(await readFile(join(jobDir, "programme.u8programme")));
        } catch (error) {
          return ctx.fail("binary-missing", `编译产物缺失: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (programmeBytes.byteLength === 0) return ctx.fail("binary-empty", "编译产物为空");
        if (programmeBytes.byteLength > maxProgrammeBytes) {
          return ctx.fail("binary-too-large", `编译产物 ${programmeBytes.byteLength}B 超过上限 ${maxProgrammeBytes}B`);
        }
        await ctx.put("programme", programmeBytes, "application/x-u8programme");
      }

      if (wantsRun) {
        if (spec.operation === "run") {
          // ── 预编译二进制只经 artifact 端口读取 ──
          try {
            programmeBytes = await deps.artifactPort.getInput(request.tenantId, spec.programmeRef!);
          } catch (error) {
            return ctx.fail("programme-unreadable", `programmeRef 读取失败: ${error instanceof Error ? error.message : String(error)}`);
          }
          if (programmeBytes.byteLength === 0) return ctx.fail("programme-empty", "programmeRef 指向空二进制");
          if (programmeBytes.byteLength > maxProgrammeBytes) {
            return ctx.fail("programme-too-large", `二进制 ${programmeBytes.byteLength}B 超过上限 ${maxProgrammeBytes}B`);
          }
          await writeFile(join(jobDir, "programme.u8programme"), programmeBytes);
          await ctx.put("programme", programmeBytes, "application/x-u8programme");
        }

        const runArgs = ["run", "programme.u8programme", ...buildInitialArgs(spec)];
        const r = await exec("u8", runArgs, { cwd: jobDir, timeoutMs: runTimeoutMs, maxOutputBytes });
        runStdout = r.stdout;
        runStderr = r.stderr;
        runExitCode = r.code ?? 0;
        if (!r.ok) {
          return ctx.fail(
            "run-failed",
            `u8 run 失败（exit ${r.code ?? "null"}${r.timedOut ? ", timed out" : ""}）: ${(r.error ?? `${r.stdout}\n${r.stderr}`).slice(0, 2_000)}`,
          );
        }
        if (RUN_ERROR_MARKER_RE.test(runStdout)) {
          return ctx.fail("run-vm-error", `u8 VM 运行错误: ${runStdout.slice(0, 2_000)}`);
        }
        if (ctx.isCancelled()) return ctx.finish("cancelled", { code: "job-cancelled", message: "job cancelled after run" });

        const runLog = JSON.stringify({
          schemaVersion: 1,
          operation: spec.operation,
          regs: spec.regs ?? {},
          io: spec.io ?? {},
          stdout: runStdout,
          stderr: runStderr,
          exitCode: runExitCode,
          toolchain: { u8: u8Version },
        }, null, 2);
        await ctx.put("run-log", new TextEncoder().encode(runLog), "application/json");
      }

      const value: U8JobValue = {
        operation: spec.operation,
        compileStdout,
        runStdout,
        runExitCode,
        toolchain: { u8: u8Version },
      };
      const outputHashSource = `${compileStdout}\n${runStdout}\n${runExitCode}\n${programmeBytes ? sha256hex(programmeBytes) : ""}`;
      return ctx.finish("succeeded", undefined, value, outputHashSource);
    } catch (error) {
      return ctx.fail("adapter-error", error instanceof Error ? error.message : String(error));
    } finally {
      ctx.cleanup();
    }
  }

  return {
    id: "u8",
    probe,
    execute,
    async cancel(jobId: string): Promise<boolean> {
      const state = running.get(jobId);
      if (!state) return false;
      state.cancelled = true;
      return true;
    },
  };
}

/** 供断言/调试复用：合法操作白名单。 */
export { U8_OPERATIONS, U8_REG_KEYS };
