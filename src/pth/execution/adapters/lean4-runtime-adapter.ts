/**
 * execution/adapters/lean4-runtime-adapter.ts — v1.3 Task 6 Lean 4 证明者垂直切片。
 *
 * `createLean4RuntimeAdapter()` 把 `Lean4JobSpec` 的白名单操作（lake-build /
 * check-imports / prove）映射到固定命令序列（lake build / lake env lean），
 * 绝不接受任意 command/argv/shell：
 *  - spec 结构校验复用 contracts 的 isLean4JobSpecStructurallyValid；
 *  - 工程文件只经 artifactPort 读取（artifact:// 租户命名空间）；bundle 为
 *    {schemaVersion:1, files:[{path,content}]} JSON，逐路径拒绝绝对路径与 `..` 逃逸；
 *  - 占位源码（sorry/admit）在构建前被拒；lakefile 的 mathlib require rev 必须与
 *    committed lock 一致；客户端夹带 lake-manifest.json 被拒（清单由服务端从模板生成）；
 *  - 诊断解析为 line/column/severity/message；产出 source/build-log/lake-manifest/
 *    tool-versions 四类 artifact；probe 校验 lean 版本 == committed lock。
 *
 * 命令执行通道可注入（execPrefix）：生产在 pi 容器内直接 spawn；测试在 macOS 宿主
 * 注入 `docker exec <toolchain-container>` 前缀——仓库以同路径挂载，路径透明；
 * Mathlib cache 经 sharedPackagesDir（容器内共享 .lake/packages 目录）复用，
 * 首次运行从 templateDir 拷贝。
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, normalize, resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  isLean4JobSpecStructurallyValid,
  type ArtifactRef,
  type Lean4JobSpec,
  type ProfessionalDiagnostic,
  type ProfessionalJobRequest,
  type ProfessionalJobResult,
} from "../../contracts/index.js";
import type { ProfessionalRuntimeAdapter } from "../professional-runtime.js";
import type { ProfessionalArtifactPort } from "../../contracts/index.js";

// ─── 执行通道 ──────────────────────────────────────────────────────────────

export interface Lean4ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
  error?: string;
}

export type Lean4ExecFn = (
  cmd: string,
  args: readonly string[],
  opts: { cwd?: string; timeoutMs?: number; maxOutputBytes?: number },
) => Promise<Lean4ExecResult>;

const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_BUILD_TIMEOUT_MS = 1_800_000;
const DEFAULT_TEMPLATE_DIR = "/home/node/lean-template";
const DEFAULT_SHARED_PACKAGES_DIR = "/home/node/lean-packages";

const LEAN_VERSION_RE = /Lean \(version ([0-9]+\.[0-9]+\.[0-9]+)/;
const LAKE_VERSION_RE = /Lake version ([^\s]+)/;
const PLACEHOLDER_RE = /\b(sorry|admit)\b/;
const REQUIRE_REV_RE = /require\s+mathlib\s+from\s+git\s+"[^"]+"\s*@\s*"([0-9a-f]+)"/;
const DIAG_RE = /^(.*?):(\d+):(\d+):\s+(error|warning):\s*(.*)$/;
const DIAG_LEAN_RE = /^(error|warning):\s+([^:]+):(\d+):(\d+):\s*(.*)$/;
const SHA_RE = /^[0-9a-f]{40}$/;

export interface Lean4JobValue {
  readonly operation: Lean4JobSpec["operation"];
  readonly noPlaceholders: boolean;
  readonly unclosedGoals: number;
  readonly toolchain: { readonly lean: string; readonly lake: string; readonly mathlib: string };
  readonly declaration?: string;
  readonly axioms?: readonly string[];
}

export interface CreateLean4RuntimeAdapterDeps {
  readonly artifactPort: ProfessionalArtifactPort;
  /** committed lock 中 lean4 条目的版本（如 "4.33.0"）。 */
  readonly lockVersion: string;
  /** committed lock 中 mathlib 的 rev（40 位 sha）。 */
  readonly mathlibRev: string;
  /** lean4-runtime 扩展路径（扩展自身在 adapter 内不动态装载；保留参数供探针扩展）。 */
  readonly lean4IndexPath?: string;
  /** job workspace 根（执行通道可见；生产为任务工作区，测试为仓库内临时目录）。 */
  readonly workDir?: string;
  /** Mathlib cache 共享目录（容器内路径；首次运行从 templateDir 拷贝）。 */
  readonly sharedPackagesDir?: string;
  /** 已构建模板工程（含 lake-manifest.json 与 .lake/packages）。 */
  readonly templateDir?: string;
  /** 命令前缀（如 ["docker","exec",...,"v13-asm-toolchain"]）。 */
  readonly execPrefix?: readonly string[];
  /** 完全自定义 runner（优先于 execPrefix）。 */
  readonly exec?: Lean4ExecFn;
  readonly buildTimeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly clock?: () => Date;
}

// ─── 构造器 ────────────────────────────────────────────────────────────────

export function createLean4RuntimeAdapter(deps: CreateLean4RuntimeAdapterDeps): ProfessionalRuntimeAdapter<Lean4JobSpec, Lean4JobValue> {
  const clock = deps.clock ?? (() => new Date());
  const workDir = resolve(deps.workDir ?? process.env.PTH_WORKSPACES_PATH ?? join(tmpdir(), "pth-lean4-jobs"));
  const sharedPackagesDir = deps.sharedPackagesDir ?? process.env.PTH_LEAN4_PACKAGES_DIR ?? DEFAULT_SHARED_PACKAGES_DIR;
  const templateDir = deps.templateDir ?? process.env.PTH_LEAN4_TEMPLATE_DIR ?? DEFAULT_TEMPLATE_DIR;
  const buildTimeoutMs = Math.min(Math.max(deps.buildTimeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS, 100), 3_600_000);
  const maxOutputBytes = deps.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const running = new Map<string, { cancelled: boolean }>();

  const sha256hex = (s: Uint8Array | string) => createHash("sha256").update(s).digest("hex");

  const execPrefix: readonly string[] | undefined = deps.execPrefix ?? (() => {
    const env = process.env.PTH_LEAN4_TOOLCHAIN_EXEC;
    return env && env.trim() !== "" ? env.split(" ").filter(Boolean) : undefined;
  })();
  const usesDockerExec = execPrefix?.[0] === "docker" && execPrefix?.[1] === "exec";

  function makeExec(prefix: readonly string[] | undefined): Lean4ExecFn {
    if (deps.exec) return deps.exec;

    return (cmd, args, opts) =>
      new Promise((resolveExec) => {
        const { cwd, timeoutMs = buildTimeoutMs, maxOutputBytes: cap = maxOutputBytes } = opts;
        // docker exec：容器内目录用 -w 指定；宿主侧 cwd 必须留空（容器本地路径在宿主不存在，
        // 否则 spawn ENOENT）。其他前缀用宿主 spawn cwd。
        let file = cmd;
        let finalArgs: string[] = [...args];
        const isDockerExec = prefix?.[0] === "docker" && prefix?.[1] === "exec";
        const spawnOpts: { cwd?: string } = isDockerExec ? {} : { cwd };
        if (prefix && prefix.length > 0) {
          file = prefix[0]!;
          if (isDockerExec) {
            // 容器名是 prefix 的最后一个 token（-e 等 flag 的值不以 "-" 开头，不能用 findIndex 推断）。
            const rest = prefix.slice(2);
            const containerIdx = rest.length - 1;
            const head = rest.slice(0, containerIdx);
            const tail = rest.slice(containerIdx);
            finalArgs = ["exec", ...head, ...(cwd !== undefined ? ["-w", cwd] : []), ...tail, cmd, ...args];
          } else {
            finalArgs = [...prefix.slice(1), cmd, ...args];
          }
        }
        const started = Date.now();
        let stdout = "";
        let stderr = "";
        let settled = false;
        let timedOut = false;
        const child = execFile(file, finalArgs, spawnOpts, (error, _stdout, _stderr) => {
          stdout = _stdout;
          stderr = _stderr;
          if (settled) return;
          settled = true;
          if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
            resolveExec({ ok: false, stdout, stderr, code: null, timedOut: false, error: `executable not found: ${file}` });
            return;
          }
          const rawCode = (error as { code?: number | string } | null)?.code;
          const code = typeof rawCode === "number" ? rawCode : error ? 1 : 0;
          resolveExec({
            ok: !timedOut && code === 0,
            stdout,
            stderr,
            code,
            timedOut,
            error: error ? `${error.message}${rawCode !== undefined ? ` (${String(rawCode)})` : ""}` : undefined,
          });
        });
        if (child.stdout) child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
        if (child.stderr) child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, timeoutMs);
        child.on("close", () => {
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            resolveExec({ ok: !timedOut && child.exitCode === 0, stdout, stderr, code: child.exitCode, timedOut });
          }
        });
        if (Date.now() - started > timeoutMs) {
          timedOut = true;
          child.kill("SIGKILL");
        }
        void cap;
      });
  }

  const exec = makeExec(execPrefix);

  async function run(
    cmd: string,
    args: readonly string[],
    opts: { cwd?: string; timeoutMs?: number; maxOutputBytes?: number } = {},
  ): Promise<Lean4ExecResult> {
    return exec(cmd, args, opts);
  }

  // ─── probe ────────────────────────────────────────────────────────────────

  async function probe(): Promise<{ available: boolean; reason?: string; version: string; releaseChannel: "stable" }> {
    const lean = await run("lean", ["--version"], { timeoutMs: 30_000 });
    if (!lean.ok) {
      return { available: false, reason: `lean 不可执行: ${lean.error ?? lean.stderr ?? `exit ${lean.code}`}`, version: "", releaseChannel: "stable" };
    }
    const m = LEAN_VERSION_RE.exec(`${lean.stdout}\n${lean.stderr}`);
    if (!m) {
      return { available: false, reason: `lean 版本不可解析: ${lean.stdout.slice(0, 200)}`, version: "", releaseChannel: "stable" };
    }
    const version = m[1]!;
    if (version !== deps.lockVersion) {
      return { available: false, reason: `lean 版本 ${version} 与 committed lock ${deps.lockVersion} 不一致`, version, releaseChannel: "stable" };
    }
    const lake = await run("lake", ["--version"], { timeoutMs: 30_000 });
    if (!lake.ok) {
      return { available: false, reason: `lake 不可执行: ${lake.error ?? lake.stderr}`, version, releaseChannel: "stable" };
    }
    return { available: true, version, releaseChannel: "stable" };
  }

  // ─── execute ──────────────────────────────────────────────────────────────

  async function execute(request: ProfessionalJobRequest<Lean4JobSpec>): Promise<ProfessionalJobResult<Lean4JobValue>> {
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
      value?: Lean4JobValue,
      outputHashSource?: Uint8Array | string,
    ): ProfessionalJobResult<Lean4JobValue> => {
      const finishedAt = clock();
      if (error) diagnostics.push({ code: error.code, severity: "error", message: error.message });
      return {
        status,
        runtime: "lean4",
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

    const fail = (code: string, message: string): ProfessionalJobResult<Lean4JobValue> =>
      finish("failed", { code, message: message.slice(0, 4_000) });

    const put = async (kind: string, bytes: Uint8Array, mediaType: string): Promise<ArtifactRef> => {
      const ref = await deps.artifactPort.putOutput({ tenantId: request.tenantId, jobId: request.jobId, kind, mediaType, bytes });
      artifacts.push(ref);
      outputBytes += bytes.byteLength;
      return ref;
    };

    try {
      // 门禁 1：spec 结构（禁 command 等任意执行字段）
      if (!isLean4JobSpecStructurallyValid(request.spec)) {
        return fail("spec-invalid", "spec 不是合法的 Lean4JobSpec（含禁键或字段越界）");
      }
      const spec = request.spec;

      // 门禁 2：工具链 probe
      const probeResult = await probe();
      if (!probeResult.available) {
        return fail("toolchain-unavailable", probeResult.reason ?? "lean4 工具链不可用");
      }
      const leanVersion = probeResult.version!;
      const lakeProbe = await run("lake", ["--version"], { timeoutMs: 30_000 });
      const lakeVersion = LAKE_VERSION_RE.exec(`${lakeProbe.stdout}\n${lakeProbe.stderr}`)?.[1] ?? "unknown";

      // 门禁 3：工程 bundle 只经 artifact 端口读取
      let bundleBytes: Uint8Array;
      try {
        bundleBytes = await deps.artifactPort.getInput(request.tenantId, spec.projectRef);
      } catch (error) {
        return fail("source-unreadable", `projectRef 读取失败: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (bundleBytes.byteLength === 0) return fail("source-empty", "projectRef 指向空工程");
      if (bundleBytes.byteLength > 2 * 1024 * 1024) return fail("source-too-large", `工程 ${bundleBytes.byteLength}B 超过 2MiB 上限`);

      let bundle: { schemaVersion?: unknown; files?: unknown };
      try {
        bundle = JSON.parse(new TextDecoder().decode(bundleBytes)) as typeof bundle;
      } catch {
        return fail("source-unreadable", "工程 bundle 不是合法 JSON");
      }
      if (bundle.schemaVersion !== 1 || !Array.isArray(bundle.files)) {
        return fail("source-unreadable", "工程 bundle 缺 schemaVersion:1 或 files 数组");
      }

      const files: { path: string; content: string }[] = [];
      for (const f of bundle.files as unknown[]) {
        if (typeof f !== "object" || f === null) return fail("source-unreadable", "files 元素必须是对象");
        const { path, content } = f as { path?: unknown; content?: unknown };
        if (typeof path !== "string" || path.length === 0 || path.length > 512) {
          return fail("project-escape", `非法文件路径: ${String(path).slice(0, 120)}`);
        }
        if (typeof content !== "string" || content.length > 256 * 1024) {
          return fail("source-too-large", `文件 ${path} 内容非法或超限`);
        }
        if (path.startsWith("/") || path.includes("\\") || path.split("/").includes("..")) {
          return fail("project-escape", `路径逃逸: ${path}`);
        }
        if (normalize(path) !== path) {
          return fail("project-escape", `路径越界: ${path}`);
        }
        files.push({ path, content });
      }

      // 门禁 4：占位源码 + 依赖锁注入/篡改
      const leanFiles = files.filter((f) => f.path.endsWith(".lean"));
      for (const f of leanFiles) {
        if (PLACEHOLDER_RE.test(f.content)) return fail("placeholder-source", `源码含 sorry/admit 占位: ${f.path}`);
      }
      if (files.some((f) => f.path === "lake-manifest.json")) {
        return fail("dependency-lock-mismatch", "客户端不得夹带 lake-manifest.json");
      }
      const lakefile = files.find((f) => f.path === "lakefile.lean");
      if (!lakefile) return fail("source-unreadable", "工程缺 lakefile.lean");
      const requireRev = REQUIRE_REV_RE.exec(lakefile.content)?.[1];
      if (!requireRev || requireRev !== deps.mathlibRev) {
        return fail("dependency-lock-mismatch", `lakefile mathlib require rev 与 committed lock 不一致`);
      }
      if (!SHA_RE.test(deps.mathlibRev)) return fail("dependency-lock-mismatch", "committed lock mathlib rev 非法");

      // 门禁 5：工作区准备（服务端生成 manifest；共享 Mathlib cache）
      // docker 前缀时构建全程放容器 overlay 文件系统（virtiofs 挂载点上的复杂
      // 多线程 lean 写入会死锁），挂载点只做 staging；无前缀时直接构建在 workDir。
      // 成功构建按 bundle 内容哈希缓存（Mathlib import 首次 elaboration 极慢）。
      const jobKey = request.jobId.replace(/[^A-Za-z0-9._-]/g, "_");
      const bundleHash = sha256hex(bundleBytes);
      const stageDir = join(workDir, jobKey);
      const jobDir = usesDockerExec ? join("/home/node/lean-jobs", jobKey) : stageDir;
      const cacheRoot = usesDockerExec ? "/home/node/lean-jobs-cache" : join(workDir, ".lean-cache");
      const cacheDir = join(cacheRoot, `build-${bundleHash.slice(0, 32)}-${deps.lockVersion}`);
      let buildFromCache = false;
      let buildLog = "";

      const cacheProbe = await run("test", ["-f", join(cacheDir, ".build-complete")], { timeoutMs: 60_000 });
      if (cacheProbe.ok) {
        await rm(stageDir, { recursive: true, force: true });
        const restore = await run("sh", ["-c", `rm -rf '${jobDir}' && cp -r '${cacheDir}' '${jobDir}'`], { timeoutMs: 600_000 });
        if (!restore.ok) {
          return fail("toolchain-unavailable", `构建缓存恢复失败: ${restore.stderr.slice(0, 400)}`);
        }
        buildFromCache = true;
        buildLog = `[cache-hit] ${cacheDir}\n`;
      } else {
        await rm(stageDir, { recursive: true, force: true });
        await mkdir(stageDir, { recursive: true });
        try {
          for (const f of files) {
            const target = join(stageDir, f.path);
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, f.content, "utf8");
          }
          if (usesDockerExec) {
            const mkJob = await run("mkdir", ["-p", join(jobDir, ".lake")], { timeoutMs: 60_000 });
            if (!mkJob.ok) return fail("toolchain-unavailable", `容器 job 目录创建失败: ${mkJob.stderr.slice(0, 300)}`);
            for (const f of files) {
              const cpFile = await run("cp", [join(stageDir, f.path), join(jobDir, f.path)], { timeoutMs: 60_000 });
              if (!cpFile.ok) return fail("toolchain-unavailable", `文件 ${f.path} 拷贝失败: ${cpFile.stderr.slice(0, 300)}`);
            }
          }
          // 共享 packages：首次从模板拷贝（cache oleans 复用）
          const ensureShared = await run("sh", ["-c", `test -d '${sharedPackagesDir}' || (mkdir -p '${dirname(sharedPackagesDir)}' && cp -r '${templateDir}/.lake/packages' '${sharedPackagesDir}')`], { timeoutMs: 600_000 });
          if (!ensureShared.ok) return fail("toolchain-unavailable", `Mathlib cache 初始化失败: ${ensureShared.stderr.slice(0, 500)}`);
          const copyManifest = await run("cp", [`${templateDir}/lake-manifest.json`, `${jobDir}/lake-manifest.json`], { timeoutMs: 60_000 });
          if (!copyManifest.ok) return fail("toolchain-unavailable", `模板 lake-manifest 拷贝失败: ${copyManifest.stderr.slice(0, 300)}`);
          const linkPkgs = await run("ln", ["-sfn", sharedPackagesDir, `${jobDir}/.lake/packages`], { timeoutMs: 60_000 });
          if (!linkPkgs.ok) return fail("toolchain-unavailable", `Mathlib cache 链接失败: ${linkPkgs.stderr.slice(0, 300)}`);
        } catch (error) {
          return fail("source-unreadable", `工程写盘失败: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      if (state.cancelled) return finish("cancelled", { code: "job-cancelled", message: "job cancelled before build" });

      // ── lake build（check-imports 复用同一 elaboration 通道）──
      const parsed0 = parseDiagnostics(buildLog);
      diagnostics.push(...parsed0);
      let unclosedGoals = (buildLog.match(/unsolved goals/gi) ?? []).length;
      if (!buildFromCache) {
        const build = await run("lake", ["build"], { cwd: jobDir, timeoutMs: buildTimeoutMs, maxOutputBytes });
        buildLog = `${build.stdout}\n${build.stderr}`;
        const parsed = parseDiagnostics(buildLog);
        diagnostics.push(...parsed);
        unclosedGoals = (buildLog.match(/unsolved goals/gi) ?? []).length;

        if (build.timedOut) return fail("build-timeout", `lake build 超过 ${buildTimeoutMs}ms`);
        if (!build.ok) {
          return fail("build-failed", `lake build 失败 exit=${build.code}${build.error ? ` err=${build.error}` : ""}（诊断 ${parsed.length} 条）: ${buildLog.slice(0, 800)}`);
        }
        // 成功构建入库（覆盖更新），加速后续同内容工程。
        const saveCache = await run("sh", ["-c", `mkdir -p '${cacheRoot}' && rm -rf '${cacheDir}' && cp -r '${jobDir}' '${cacheDir}' && touch '${cacheDir}/.build-complete'`], { timeoutMs: 600_000 });
        if (!saveCache.ok) {
          // 缓存失败不阻断任务：只影响后续性能。
          diagnostics.push({ code: "lean-cache-save-failed", severity: "warning", message: saveCache.stderr.slice(0, 300) });
        }
      }

      // ── prove：经 lake env lean 执行 #print axioms 双重校验 ──
      let axioms: string[] | undefined;
      if (spec.operation === "prove") {
        if (typeof spec.declaration !== "string" || spec.declaration.length === 0) {
          return fail("spec-invalid", "prove 操作缺 declaration");
        }
        if (typeof spec.module !== "string" || spec.module.length === 0) {
          return fail("spec-invalid", "prove 操作缺 module");
        }
        // Lean 顶层声明不处于模块命名空间下（import 已保证模块上下文）。
        const proveContent = `import ${spec.module}\n#print axioms ${spec.declaration}\n`;
        await mkdir(stageDir, { recursive: true });
        await writeFile(join(stageDir, "__prove_check.lean"), proveContent, "utf8");
        if (usesDockerExec) {
          const cpProve = await run("cp", [join(stageDir, "__prove_check.lean"), join(jobDir, "__prove_check.lean")], { timeoutMs: 60_000 });
          if (!cpProve.ok) return fail("toolchain-unavailable", `prove 检查文件拷贝失败: ${cpProve.stderr.slice(0, 300)}`);
        }
        const prove = await run("lake", ["env", "lean", "__prove_check.lean"], { cwd: jobDir, timeoutMs: buildTimeoutMs, maxOutputBytes });
        if (prove.timedOut) return fail("build-timeout", "prove 检查超时");
        if (!prove.ok) return fail("build-failed", `prove 检查失败: ${`${prove.stdout}\n${prove.stderr}`.slice(0, 800)}`);
        const out = `${prove.stdout}\n${prove.stderr}`;
        axioms = parseAxioms(out);
      }

      // ── 产物 ──
      await put("source", bundleBytes, "application/json");
      await put("build-log", new TextEncoder().encode(buildLog), "text/plain");
      let manifestBytes: Uint8Array;
      if (usesDockerExec) {
        const catManifest = await run("cat", [join(jobDir, "lake-manifest.json")], { timeoutMs: 60_000, maxOutputBytes: 1024 * 1024 });
        if (!catManifest.ok || catManifest.stdout.length === 0) return fail("build-failed", "lake-manifest.json 产物缺失");
        manifestBytes = new TextEncoder().encode(catManifest.stdout);
      } else {
        try {
          manifestBytes = new Uint8Array(await readFile(join(jobDir, "lake-manifest.json")));
        } catch {
          return fail("build-failed", "lake-manifest.json 产物缺失");
        }
      }
      await put("lake-manifest", manifestBytes, "application/json");
      const toolVersions = JSON.stringify(
        { lean: leanVersion, lake: lakeVersion, mathlib: deps.mathlibRev, toolchain: "leanprover/lean4:v" + leanVersion },
        null,
        2,
      );
      await put("tool-versions", new TextEncoder().encode(toolVersions), "application/json");

      const value: Lean4JobValue = {
        operation: spec.operation,
        noPlaceholders: true,
        unclosedGoals,
        toolchain: { lean: leanVersion, lake: lakeVersion, mathlib: deps.mathlibRev },
        ...(spec.operation === "prove" ? { declaration: spec.declaration, axioms: axioms ?? [] } : {}),
      };
      return finish("succeeded", undefined, value, `${JSON.stringify(value)}\n${buildLog}`);
    } catch (error) {
      return fail("build-failed", `lean4 adapter 意外错误: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      running.delete(request.jobId);
    }
  }

  async function cancel(_jobId: string): Promise<boolean> {
    const state = running.get(_jobId);
    if (!state) return false;
    state.cancelled = true;
    return true;
  }

  return { id: "lean4", probe, execute, cancel };
}

// ─── 诊断解析 ───────────────────────────────────────────────────────────────

function parseDiagnostics(log: string): ProfessionalDiagnostic[] {
  const out: ProfessionalDiagnostic[] = [];
  for (const line of log.split("\n")) {
    const m = DIAG_RE.exec(line.trim()) ?? DIAG_LEAN_RE.exec(line.trim());
    if (DIAG_LEAN_RE.exec(line.trim()) && m) {
      const lm = DIAG_LEAN_RE.exec(line.trim())!;
      const severity = lm[1] === "error" ? ("error" as const) : ("warning" as const);
      out.push({
        code: severity === "error" ? "lean-error" : "lean-warning",
        severity,
        message: lm[5]!.slice(0, 2_000),
        line: Number(lm[3]),
        column: Number(lm[4]),
        file: lm[2]!,
      });
      continue;
    }
    if (m) {
      const file = m[1]!;
      const lineNo = Number(m[2]);
      const column = Number(m[3]);
      const severity = m[4] === "error" ? ("error" as const) : ("warning" as const);
      const message = m[5]!;
      out.push({
        code: severity === "error" ? "lean-error" : "lean-warning",
        severity,
        message: message.slice(0, 2_000),
        ...(Number.isFinite(lineNo) ? { line: lineNo } : {}),
        ...(Number.isFinite(column) ? { column } : {}),
        ...(file.length > 0 && file !== "-" ? { file } : {}),
      });
      continue;
    }
    const bare = /^\s*(error|warning):\s*(.*)$/.exec(line.trim());
    if (bare) {
      out.push({
        code: bare[1] === "error" ? "lean-error" : "lean-warning",
        severity: bare[1] === "error" ? "error" : "warning",
        message: bare[2]!.slice(0, 2_000),
      });
    }
  }
  return out.slice(0, 200);
}

function parseAxioms(out: string): string[] {
  const idx = out.indexOf("axioms:");
  if (idx < 0) return [];
  const rest = out.slice(idx + "axioms:".length);
  const lineEnd = rest.indexOf("\n");
  const firstLine = (lineEnd >= 0 ? rest.slice(0, lineEnd) : rest).trim();
  return firstLine
    .split(/[\s,]+/)
    .map((s) => s.replace(/[`']/g, ""))
    .filter((s) => s.length > 0);
}
