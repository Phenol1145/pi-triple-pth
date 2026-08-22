/**
 * execution/adapters/assembly-runtime-adapter.ts — v1.3 Task 5 汇编工程师垂直切片。
 *
 * `createAssemblyRuntimeAdapter()` 把 `AssemblyJobSpec` 的白名单操作映射到 asm-kernel
 * 扩展的固定调用序列（assemble → link → run → disasm），绝不接受任意 command/argv：
 *  - spec 结构校验复用 contracts 的 isAssemblyJobSpecStructurallyValid（禁 command/shell 等键）；
 *  - target 只接受契约三值（x86-64/aarch64/riscv64），映射到 asm-kernel 目标矩阵；
 *  - 源码只经 artifactPort 读取（artifact:// 租户命名空间），大小上限可配；
 *  - 构建/运行超时与输出字节上限在构造时校验并钳制到内核允许区间；
 *  - probe 校验三套交叉 as/ld/objdump（+ 跨架构目标的 qemu-user）齐备且 binutils
 *    版本等于 committed lock；版本留痕进每个成功结果的 toolchain 字段；
 *  - 产出 source/object/binary/disassembly/run-log 五类 artifact（经 artifactPort 落租户树）。
 *
 * 命令执行通道可注入（exec / execPrefix）：生产在 pi 容器内直接 spawn；测试在
 * macOS 宿主（无 Linux 工具链）注入 `docker exec <toolchain-container>` 前缀——
 * 仓库以同路径挂载进容器，路径透明。环境变量 PTH_ASM_TOOLCHAIN_EXEC（空格分隔）
 * 是 execPrefix 的缺省来源。
 */
import { pthConfig } from "../../config/index.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import type { ExecutionBackend } from "@away_from/shared/execution";
import { execViaBackend, resolveExecutionBackend, unavailableAdapterExec, type AdapterExecFn } from "../exec-via-backend.js";
import {
  isAssemblyJobSpecStructurallyValid,
  type ArtifactRef,
  type AssemblyJobSpec,
  type AssemblyTarget,
  type ProfessionalDiagnostic,
  type ProfessionalJobRequest,
  type ProfessionalJobResult,
} from "../../contracts/index.js";
import type { ProfessionalRuntimeAdapter } from "../professional-runtime.js";
import { createJobRunContext } from "./job-runner.js";
import type { ProfessionalArtifactPort } from "../../contracts/index.js";

// ─── 执行通道与结果类型 ────────────────────────────────────────────────────

export interface AsmExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
  code?: number | string;
}

export type AsmExecFn = (
  cmd: string,
  args: readonly string[],
  opts: { cwd?: string; timeoutMs?: number; maxOutputBytes?: number },
) => Promise<AsmExecResult>;

export interface AssemblyToolchainVersions {
  readonly assembler: string;
  readonly linker: string;
  readonly objdump: string;
  /** 目标 == 工具链宿主架构时为 null（直跑不经 qemu）。 */
  readonly qemu: string | null;
}

export interface AssemblyJobValue {
  readonly target: AssemblyTarget;
  readonly operation: AssemblyJobSpec["operation"];
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly disassembly: string | null;
  readonly toolchain: AssemblyToolchainVersions;
}

export interface CreateAssemblyRuntimeAdapterDeps {
  readonly artifactPort: ProfessionalArtifactPort;
  /** committed lock 中 assembly 条目的版本（binutils 主版本，如 "2.40"）。 */
  readonly lockVersion: string;
  /** asm-kernel 构建产物路径；缺省 <repo>/toolstore/extensions/asm-kernel/index.js。 */
  readonly asmKernelIndexPath?: string;
  /** asm-kernel 工作目录（装载期间覆盖 PTH_WORKSPACES_PATH）；必须对执行通道可见。 */
  readonly workDir?: string;
  /** 命令前缀（如 ["docker","exec","v13-asm-toolchain"]）；缺省读 PTH_ASM_TOOLCHAIN_EXEC。 */
  readonly execPrefix?: readonly string[];
  /** execution/v1 执行面（优先于 execPrefix 的兼容解析） */
  readonly executionBackend?: ExecutionBackend;
  /** 完全自定义 runner（优先于 execPrefix）。 */
  readonly exec?: AsmExecFn;
  readonly runTimeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly maxSourceBytes?: number;
  readonly clock?: () => Date;
}

// ─── 常量与目标映射 ────────────────────────────────────────────────────────

const DEFAULT_INDEX = fileURLToPath(
  new URL("../../../../toolstore/extensions/asm-kernel/index.js", import.meta.url),
);
const MAX_RUN_TIMEOUT_MS = 30_000; // asm-kernel run 内部上限
const MIN_RUN_TIMEOUT_MS = 100;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_SOURCE_BYTES = 256 * 1024;
const BINUTILS_VERSION_RE = /([0-9]+\.[0-9]+(?:\.[0-9]+)?)/;
const QEMU_VERSION_RE = /version ([0-9]+\.[0-9]+(?:\.[0-9]+)?)/;

/** 工具链环境宿主架构（命令真实执行侧的架构——生产即本进程；docker 前缀时与容器一致）。 */
const TOOLCHAIN_HOST_ARCH = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : "unknown";

interface TargetTools {
  readonly kernelTarget: "x86_64" | "aarch64" | "riscv64";
  readonly as: string;
  readonly ld: string;
  readonly objdump: string;
  readonly qemu: string;
}

const TARGET_MAP: Readonly<Record<AssemblyTarget, TargetTools>> = Object.freeze({
  "x86-64": Object.freeze({
    kernelTarget: "x86_64",
    as: "x86_64-linux-gnu-as",
    ld: "x86_64-linux-gnu-ld",
    objdump: "x86_64-linux-gnu-objdump",
    qemu: "qemu-x86_64",
  }),
  aarch64: Object.freeze({
    kernelTarget: "aarch64",
    as: "aarch64-linux-gnu-as",
    ld: "aarch64-linux-gnu-ld",
    objdump: "aarch64-linux-gnu-objdump",
    qemu: "qemu-aarch64",
  }),
  riscv64: Object.freeze({
    kernelTarget: "riscv64",
    as: "riscv64-linux-gnu-as",
    ld: "riscv64-linux-gnu-ld",
    objdump: "riscv64-linux-gnu-objdump",
    qemu: "qemu-riscv64",
  }),
});

const isNativeTarget = (t: TargetTools): boolean => t.kernelTarget === TOOLCHAIN_HOST_ARCH;

// ─── asm-kernel 装载 ────────────────────────────────────────────────────────
// index.js 是 CJS factory（module.exports = async (ctx) => ...），仓库根为
// type:module，且 vitest 的 VM 环境拒绝 new Function 内的动态 import——
// 因此把构建产物按内容哈希落成 .cjs shim 后 createRequire 装载（等价 eval 通道，
// 生产 node 与 vitest worker 行为一致）。

interface AsmKernelToolResult {
  ok: boolean;
  error?: string;
  result?: any;
}

interface AsmKernelTools {
  assemble(args: { source: string; target: string }): Promise<AsmKernelToolResult>;
  link(args: { objRef: string; target: string }): Promise<AsmKernelToolResult>;
  run(args: { binaryRef: string; target: string; timeoutMs?: number }): Promise<AsmKernelToolResult>;
  disasm(args: { binaryRef: string; target: string }): Promise<AsmKernelToolResult>;
}

async function loadAsmKernelTools(indexPath: string, exec: AsmExecFn, workDir?: string): Promise<AsmKernelTools> {
  const code = await readFile(indexPath, "utf8");
  const shimDir = workDir ?? tmpdir();
  await mkdir(shimDir, { recursive: true });
  const shimPath = join(shimDir, `.asm-kernel-shim-${createHash("sha256").update(code).digest("hex").slice(0, 16)}.cjs`);
  const existing = await readFile(shimPath, "utf8").catch(() => null);
  if (existing !== code) await writeFile(shimPath, code, "utf8");
  const require = createRequire(import.meta.url);
  const factory = require(shimPath) as (ctx: unknown) => Promise<{ tools: AsmKernelTools }>;
  // pth-config: controlled env write for asm-kernel shim（loader 读 process.env 而非 pthConfig）
  // asm-kernel 在 factory 调用时捕获 PTH_WORKSPACES_PATH；装载期间覆盖后还原。
  const prev = pthConfig().str("PTH_WORKSPACES_PATH");
  if (workDir !== undefined) process.env.PTH_WORKSPACES_PATH = workDir;
  try {
    const mod = await factory({ log: () => {}, exec });
    for (const name of ["assemble", "link", "run", "disasm"] as const) {
      if (typeof mod?.tools?.[name] !== "function") {
        throw new Error(`asm-kernel index.js 契约不符：tools.${name} 缺失`);
      }
    }
    return mod.tools;
  } finally {
    if (workDir !== undefined) {
      if (prev === "") delete process.env.PTH_WORKSPACES_PATH;
      else process.env.PTH_WORKSPACES_PATH = prev;
    }
  }
}

function createExecFn(deps: CreateAssemblyRuntimeAdapterDeps): AsmExecFn {
  if (deps.exec) return deps.exec;
  const envPrefix = pthConfig().str("PTH_ASM_TOOLCHAIN_EXEC")?.split(" ").filter(Boolean);
  const prefix = deps.execPrefix ?? (envPrefix && envPrefix.length > 0 ? envPrefix : undefined);
  const backend = resolveExecutionBackend({ executionBackend: deps.executionBackend, execPrefix: prefix });
  const viaBackend: AdapterExecFn = backend
    ? execViaBackend(backend)
    : unavailableAdapterExec("assembly: no execution backend configured");
  return async (cmd, args, opts = {}) => {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const r = await viaBackend(cmd, args, {
      cwd: opts.cwd,
      timeoutMs,
      maxOutputBytes: opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    });
    if (r.ok) return { ok: true, stdout: r.stdout, stderr: r.stderr, code: 0 };
    if (r.timedOut) {
      return {
        ok: false,
        stdout: r.stdout,
        stderr: r.stderr,
        error: `timed out after ${timeoutMs}ms (SIGTERM): ${r.stderr.slice(0, 400)}`,
      };
    }
    return {
      ok: false,
      stdout: r.stdout,
      stderr: r.stderr,
      error: (r.error ?? r.stderr).slice(0, 800),
      ...(r.code !== null ? { code: r.code } : {}),
    };
  };
}

// ─── 版本探测 ──────────────────────────────────────────────────────────────

async function which(exec: AsmExecFn, bin: string): Promise<boolean> {
  const r = await exec("which", [bin], { timeoutMs: 5_000, maxOutputBytes: 4_096 });
  return r.ok;
}

async function toolVersion(exec: AsmExecFn, bin: string, re: RegExp): Promise<string | null> {
  const r = await exec(bin, ["--version"], { timeoutMs: 5_000, maxOutputBytes: 64 * 1024 });
  if (!r.ok) return null;
  const firstLine = r.stdout.split("\n")[0] ?? "";
  const m = firstLine.match(re) ?? r.stdout.match(re);
  return m ? (m[1] ?? m[0]).trim() : null;
}

async function toolchainVersions(exec: AsmExecFn, t: TargetTools): Promise<AssemblyToolchainVersions | null> {
  const [assembler, linker, objdump] = await Promise.all([
    toolVersion(exec, t.as, BINUTILS_VERSION_RE),
    toolVersion(exec, t.ld, BINUTILS_VERSION_RE),
    toolVersion(exec, isNativeTarget(t) ? "objdump" : t.objdump, BINUTILS_VERSION_RE),
  ]);
  if (!assembler || !linker || !objdump) return null;
  const qemu = isNativeTarget(t) ? null : await toolVersion(exec, t.qemu, QEMU_VERSION_RE);
  if (!isNativeTarget(t) && !qemu) return null;
  return { assembler, linker, objdump, qemu };
}

// ─── Adapter ───────────────────────────────────────────────────────────────

const sha256hex = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

export function createAssemblyRuntimeAdapter(
  deps: CreateAssemblyRuntimeAdapterDeps,
): ProfessionalRuntimeAdapter<AssemblyJobSpec, AssemblyJobValue> {
  if (typeof deps.artifactPort !== "object" || deps.artifactPort === null) {
    throw new Error("assembly adapter: artifactPort is required");
  }
  if (typeof deps.lockVersion !== "string" || deps.lockVersion.trim() === "") {
    throw new Error("assembly adapter: lockVersion is required");
  }
  const runTimeoutMs = deps.runTimeoutMs ?? 10_000;
  if (!Number.isFinite(runTimeoutMs) || runTimeoutMs < MIN_RUN_TIMEOUT_MS || runTimeoutMs > MAX_RUN_TIMEOUT_MS) {
    throw new Error(`assembly adapter: runTimeoutMs must be within [${MIN_RUN_TIMEOUT_MS}, ${MAX_RUN_TIMEOUT_MS}]`);
  }
  const maxOutputBytes = deps.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isFinite(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > MAX_OUTPUT_BYTES) {
    throw new Error(`assembly adapter: maxOutputBytes must be within [1, ${MAX_OUTPUT_BYTES}]`);
  }
  const maxSourceBytes = deps.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES;
  if (!Number.isFinite(maxSourceBytes) || maxSourceBytes < 1 || maxSourceBytes > MAX_OUTPUT_BYTES) {
    throw new Error(`assembly adapter: maxSourceBytes must be within [1, ${MAX_OUTPUT_BYTES}]`);
  }
  const clock = deps.clock ?? (() => new Date());
  const exec = createExecFn(deps);
  const indexPath = deps.asmKernelIndexPath ?? DEFAULT_INDEX;

  // 运行中 job 的取消标记（cancel 只翻转标记；execute 在阶段间检查）。
  const running = new Map<string, { cancelled: boolean }>();

  async function probe(): Promise<{ available: boolean; version: string; releaseChannel: "stable"; reason?: string }> {
    const unavailable = (reason: string, version = "") => ({ available: false, version, releaseChannel: "stable" as const, reason });
    let kernelOk = true;
    try {
      await loadAsmKernelTools(indexPath, exec, deps.workDir);
    } catch {
      kernelOk = false;
    }
    if (!kernelOk) return unavailable(`asm-kernel index.js 装载失败（${indexPath}）`);
    const missing: string[] = [];
    for (const target of Object.values(TARGET_MAP)) {
      for (const bin of [target.as, target.ld]) {
        if (!(await which(exec, bin))) missing.push(bin);
      }
      if (isNativeTarget(target)) {
        if (!(await which(exec, "objdump"))) missing.push("objdump");
      } else {
        for (const bin of [target.objdump, target.qemu]) {
          if (!(await which(exec, bin))) missing.push(bin);
        }
      }
    }
    if (missing.length > 0) {
      return unavailable(`toolchain 缺失: ${[...new Set(missing)].join(", ")}（见 deploy/Dockerfile: binutils/qemu-user/交叉 binutils）`);
    }
    // committed lock 钉 binutils 版本：三套 as 必须与 lock 完全一致（ld/objdump 同源）。
    for (const target of Object.values(TARGET_MAP)) {
      const v = await toolVersion(exec, target.as, BINUTILS_VERSION_RE);
      if (v !== deps.lockVersion) {
        return unavailable(`assembler ${target.as} 版本 ${v ?? "unparseable"} 与 committed lock ${deps.lockVersion} 不符`, v ?? "");
      }
    }
    return { available: true, version: deps.lockVersion, releaseChannel: "stable" };
  }

  async function execute(request: ProfessionalJobRequest<AssemblyJobSpec>): Promise<ProfessionalJobResult<AssemblyJobValue>> {
    const ctx = createJobRunContext<AssemblyJobValue>({
      runtime: "assembly",
      runtimeVersion: deps.lockVersion,
      request,
      artifactPort: deps.artifactPort,
      running,
      clock,
    });
    const failTool = (code: string, toolError: string | undefined) =>
      ctx.finish("failed", { code, message: (toolError ?? "unknown tool error").slice(0, 4_000) });

    try {
      // ── 门禁 1：spec 结构（禁 command/argv/shell 等任意执行字段；target 白名单）──
      if (!isAssemblyJobSpecStructurallyValid(request.spec)) {
        return ctx.finish("failed", { code: "spec-invalid", message: "spec 不是合法的 AssemblyJobSpec（含禁键或字段越界）" });
      }
      const spec = request.spec;
      const target = TARGET_MAP[spec.target];

      // ── 门禁 2：源码只经 artifact 端口读取，大小上限 ──
      let sourceBytes: Uint8Array;
      try {
        sourceBytes = await deps.artifactPort.getInput(request.tenantId, spec.sourceRef);
      } catch (error) {
        return ctx.finish("failed", { code: "source-unreadable", message: `sourceRef 读取失败: ${error instanceof Error ? error.message : String(error)}` });
      }
      if (sourceBytes.byteLength === 0) {
        return ctx.finish("failed", { code: "source-empty", message: "sourceRef 指向空源码" });
      }
      if (sourceBytes.byteLength > maxSourceBytes) {
        return ctx.finish("failed", { code: "source-too-large", message: `源码 ${sourceBytes.byteLength}B 超过上限 ${maxSourceBytes}B` });
      }
      const source = new TextDecoder().decode(sourceBytes);

      // ── 工具链版本留痕（probe 之外按目标再核一次，版本缺失即失败）──
      const versions = await toolchainVersions(exec, target);
      if (!versions) {
        return ctx.finish("failed", { code: "toolchain-unavailable", message: `目标 ${spec.target} 工具链版本探测失败` });
      }

      const cancelled = () => ctx.isCancelled();

      await ctx.put("source", sourceBytes, "text/x-asm");
      const tools = await loadAsmKernelTools(indexPath, exec, deps.workDir);

      // ── assemble ──
      const a = await tools.assemble({ source, target: target.kernelTarget });
      if (!a.ok) return failTool("assemble-failed", a.error);
      const objBytes = new Uint8Array(await readFile(a.result.objPath));
      await ctx.put("object", objBytes, "application/x-object");
      if (cancelled()) return ctx.finish("cancelled", { code: "job-cancelled", message: "job cancelled after assemble" });

      // ── link ──
      const l = await tools.link({ objRef: a.result.objRef, target: target.kernelTarget });
      if (!l.ok) return failTool("link-failed", l.error);
      const binBytes = new Uint8Array(await readFile(l.result.binaryPath));
      await ctx.put("binary", binBytes, "application/x-executable");
      if (cancelled()) return ctx.finish("cancelled", { code: "job-cancelled", message: "job cancelled after link" });

      const wantsRun = spec.operation !== "build";
      const wantsDisasm = spec.operation === "disassemble" || spec.operation === "build-run-disassemble" || spec.operation === "verify";

      // ── disasm（build-only 也允许只要 disassemble 操作；build 操作不反汇编）──
      let disassembly: string | null = null;
      if (spec.operation === "disassemble" || wantsDisasm) {
        const d = await tools.disasm({ binaryRef: l.result.binaryRef, target: target.kernelTarget });
        if (!d.ok) return failTool("disassemble-failed", d.error);
        disassembly = String(d.result.text);
        await ctx.put("disassembly", new TextEncoder().encode(disassembly), "text/x-objdump");
        if (cancelled()) return ctx.finish("cancelled", { code: "job-cancelled", message: "job cancelled after disassemble" });
      }

      // ── run ──
      let stdout = "";
      let stderr = "";
      let exitCode = 0;
      let timedOut = false;
      let runLogBytes: Uint8Array | null = null;
      if (wantsRun) {
        const r = await tools.run({ binaryRef: l.result.binaryRef, target: target.kernelTarget, timeoutMs: runTimeoutMs });
        if (!r.ok) return failTool("run-failed", r.error);
        stdout = String(r.result.stdout ?? "");
        stderr = String(r.result.stderr ?? "");
        exitCode = Number(r.result.exitCode ?? 0);
        timedOut = r.result.timedOut === true;
        if (stdout.length > maxOutputBytes || stderr.length > maxOutputBytes) {
          return ctx.finish("failed", { code: "output-limit-exceeded", message: `运行输出超过上限 ${maxOutputBytes}B` });
        }
        runLogBytes = new TextEncoder().encode(JSON.stringify({
          target: spec.target, stdout, stderr, exitCode, timedOut, timeoutMs: runTimeoutMs,
        }));
        await ctx.put("run-log", runLogBytes, "application/json");
        if (timedOut) {
          return ctx.finish("failed", { code: "run-timeout", message: `运行超过 ${runTimeoutMs}ms 被终止` });
        }
        if (exitCode !== 0) {
          return ctx.finish("failed", { code: "run-exit-nonzero", message: `程序退出码 ${exitCode}（stderr: ${stderr.slice(0, 500)}）` });
        }
        if (cancelled()) return ctx.finish("cancelled", { code: "job-cancelled", message: "job cancelled after run" });
      }

      const value: AssemblyJobValue = {
        target: spec.target,
        operation: spec.operation,
        stdout,
        stderr,
        exitCode,
        timedOut,
        disassembly,
        toolchain: versions,
      };

      // ── verify：与 sourceRef 旁路的 .expected artifact 逐字节比对 ──
      if (spec.operation === "verify") {
        const expectedRef: ArtifactRef = { kind: "asm-expected", uri: `${spec.sourceRef.uri}.expected`, mediaType: "text/plain" };
        let expectedBytes: Uint8Array;
        try {
          expectedBytes = await deps.artifactPort.getInput(request.tenantId, expectedRef);
        } catch (error) {
          return ctx.finish("failed", { code: "expected-output-missing", message: `verify 需要 ${expectedRef.uri}: ${error instanceof Error ? error.message : String(error)}` });
        }
        const expected = new TextDecoder().decode(expectedBytes);
        if (expected !== stdout) {
          return ctx.finish("failed", {
            code: "output-mismatch",
            message: `输出与期望不符（expected ${JSON.stringify(expected.slice(0, 200))}, got ${JSON.stringify(stdout.slice(0, 200))}）`,
          });
        }
      }

      const outputHashSource = `${stdout}\n${stderr}\n${exitCode}\n${disassembly ?? ""}`;
      return ctx.finish("succeeded", undefined, value, outputHashSource);
    } catch (error) {
      return ctx.finish("failed", { code: "adapter-error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      ctx.cleanup();
    }
  }

  return {
    id: "assembly",
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
