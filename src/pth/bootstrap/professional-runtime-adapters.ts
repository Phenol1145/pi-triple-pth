/**
 * bootstrap/professional-runtime-adapters.ts — v1.3 Task 4 唯一生产组装点。
 *
 * `assembleProfessionalRuntimeRegistry()` 只消费 committed lock + adapter factories：
 *  - 不 import 任何 fixture 数据（专业角色/责任/预算 fixture 不属于本文件）；
 *  - factory 抛错、probe 失败、非 stable、版本与 lock 不一致的 adapter 一律不注册；
 *  - 注册表创建后由调用方（batch-process）注入每个 specialist Worker Replica。
 *
 * 本文件同时提供生产 artifact 端口（文件系统实现）：
 *  - `artifact://<tenant>/<path>` 被解析为 `<artifactPath>/<tenant>/<path>`；
 *  - 防穿越：path 必须是相对路径且归一化后仍在 tenant 目录内。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import type { ExecutionBackend } from "@away_from/shared/execution";
import type { ArtifactRef, ProfessionalJobSpec, ProfessionalRuntimeId, ProfessionalRuntimeLock } from "../contracts/index.js";
import type { ExecutionBackendRegistry } from "../execution/index.js";
import {
  createAssemblyRuntimeAdapter,
  createLean4RuntimeAdapter,
  createWolframRuntimeAdapter,
  createPsi4RuntimeAdapter,
  createQuantumEspressoRuntimeAdapter,
  createCp2kRuntimeAdapter,
  createJupyterRuntimeAdapter,
  createU8RuntimeAdapter,
} from "../execution/index.js";
import {
  createProfessionalRuntimeRegistry,
  type ProfessionalRuntimeAdapter,
  type ProfessionalRuntimeRegistry,
} from "../execution/index.js";
import type { ProfessionalArtifactPort } from "../runner/index.js";

export type ProfessionalRuntimeAdapterFactory<
  S extends ProfessionalJobSpec = ProfessionalJobSpec,
  R = unknown,
> = () => ProfessionalRuntimeAdapter<S, R> | Promise<ProfessionalRuntimeAdapter<S, R>>;

export interface AssembleProfessionalRuntimeRegistryInput {
  readonly lock: ProfessionalRuntimeLock;
  readonly factories?: Readonly<Partial<Record<ProfessionalRuntimeId, ProfessionalRuntimeAdapterFactory<any, any>>>>;
  readonly clock?: () => Date;
  /**
   * v1.3 Task 5 接线：提供 artifactPath 且 factories 未覆盖 assembly 时，
   * 自动按 committed lock 装配真实 asm-kernel adapter（生产唯一组装路径）。
   */
  readonly artifactPath?: string;
  /** 透传给 assembly adapter（测试/容器注入；生产缺省即可）。 */
  readonly asmKernelIndexPath?: string;
  readonly asmExecPrefix?: readonly string[];
  /**
   * v1.3 Task 6 接线：提供 artifactPath 且 factories 未覆盖 lean4 时，
   * 自动按 committed lock 装配真实 lean4-runtime adapter。
   */
  readonly lean4WorkDir?: string;
  readonly lean4SharedPackagesDir?: string;
  readonly lean4ExecPrefix?: readonly string[];
  /**
   * v1.3 Task 7 接线：wolfram adapter 只读服务端 kernel/license 配置；
   * 未提供 kernelPath 时工厂照常存在（probe 返回 license-unavailable）。
   */
  readonly wolframKernelPath?: string;
  readonly wolframLicenseProvider?: string;
  readonly wolframExecPrefix?: readonly string[];
  /** v1.3 Task 8：计算化学引擎（生产在 pi 容器内直跑；测试注入 execPrefix）。 */
  readonly chemWorkDir?: string;
  readonly chemExecPrefix?: readonly string[];
  readonly psi4Command?: string;
  /** v1.3 Task 9：jupyter clean-kernel 执行（生产在 jupyter 服务容器内直跑）。 */
  readonly jupyterWorkDir?: string;
  readonly jupyterExecPrefix?: readonly string[];
  readonly jupyterPathForExec?: (hostPath: string) => string;
  /** U8-1：u8 VM 工具链执行（生产路由 local-u8；缺省 PTH_WORKSPACES_PATH 做 job 根）。 */
  readonly u8WorkDir?: string;
  readonly u8ExecPrefix?: readonly string[];
  /**
   * P1 硬切：执行后端注册表（优先 backendRoutes → 约定 id；无命中且无 legacy 前缀
   * → 不创建该 runtime 的执行面，probe 返回 unavailable）。
   */
  readonly executionBackends?: ExecutionBackendRegistry;
  readonly backendRoutes?: Readonly<Partial<Record<ProfessionalRuntimeId, string>>>;
  /** false（默认）= 不允许 adapter 回退 env legacy 前缀；显式传入的 execPrefix 仍受支持 */
  readonly allowLegacyExecutionFallback?: boolean;
}

/** P1.4 约定路由：显式 backendRoutes 优先；registry 中不存在即跳过（不隐式直跑） */
const DEFAULT_BACKEND_ROUTES: Readonly<Partial<Record<ProfessionalRuntimeId, string>>> = {
  lean4: "local-lean",
  // T4：assembly 切到 compiled tool container（v13-asm-toolchain 白名单已迁入）
  assembly: "tools-compiled",
  wolfram: "local-wolfram",
  psi4: "local-chem",
  cp2k: "local-chem",
  "quantum-espresso": "local-chem",
  // P5：单容器双面——engine 经 registry backend `jupyter` 调南面 execution/v1.1
  jupyter: "jupyter",
  // U8-1：u8proj 本地执行器（host，batch compile/run；U8-2 interactive 随 P4）
  u8: "local-u8",
};

function runtimeExecutionBackend(
  input: AssembleProfessionalRuntimeRegistryInput,
  runtimeId: ProfessionalRuntimeId,
): ExecutionBackend | undefined {
  const route = input.backendRoutes?.[runtimeId] ?? DEFAULT_BACKEND_ROUTES[runtimeId];
  if (!route) return undefined;
  return input.executionBackends?.get(route);
}

/**
 * legacy execPrefix 语义（P1.5 硬切）：
 *  - 显式传入的 prefix 始终受支持（测试/容器注入）；
 *  - 未显式传入且 allowLegacyExecutionFallback !== true → 传 []，禁止 adapter 回退 env。
 */
function legacyExecPrefix(
  input: AssembleProfessionalRuntimeRegistryInput,
  explicit: readonly string[] | undefined,
): readonly string[] | undefined {
  if (explicit !== undefined) return explicit;
  return input.allowLegacyExecutionFallback === true ? undefined : [];
}

/** 生产组装点：只注册 probe 成功且满足 committed lock 的 adapter。 */
export async function assembleProfessionalRuntimeRegistry(
  input: AssembleProfessionalRuntimeRegistryInput,
): Promise<ProfessionalRuntimeRegistry> {
  const registry = createProfessionalRuntimeRegistry({ lock: input.lock, clock: input.clock });
  const factories: Partial<Record<ProfessionalRuntimeId, ProfessionalRuntimeAdapterFactory<any, any>>> = {
    ...input.factories,
  };
  if (!factories.assembly && input.artifactPath !== undefined) {
    const artifactPath = input.artifactPath;
    const entry = input.lock.runtimes.assembly;
    if (entry) {
      factories.assembly = () =>
        createAssemblyRuntimeAdapter({
          artifactPort: createProfessionalArtifactPort({ artifactPath }),
          lockVersion: entry.version,
          ...(input.asmKernelIndexPath !== undefined ? { asmKernelIndexPath: input.asmKernelIndexPath } : {}),
          executionBackend: runtimeExecutionBackend(input, "assembly"),
          execPrefix: legacyExecPrefix(input, input.asmExecPrefix),
        });
    }
  }
  if (!factories.lean4 && input.artifactPath !== undefined) {
    const artifactPath = input.artifactPath;
    const entry = input.lock.runtimes.lean4;
    const mathlibRev = entry ? (entry as { dependencies?: { mathlib?: { rev?: string } } }).dependencies?.mathlib?.rev : undefined;
    if (entry && typeof mathlibRev === "string" && /^[0-9a-f]{40}$/.test(mathlibRev)) {
      factories.lean4 = () =>
        createLean4RuntimeAdapter({
          artifactPort: createProfessionalArtifactPort({ artifactPath }),
          lockVersion: entry.version,
          mathlibRev,
          ...(input.lean4WorkDir !== undefined ? { workDir: input.lean4WorkDir } : {}),
          ...(input.lean4SharedPackagesDir !== undefined ? { sharedPackagesDir: input.lean4SharedPackagesDir } : {}),
          executionBackend: runtimeExecutionBackend(input, "lean4"),
          execPrefix: legacyExecPrefix(input, input.lean4ExecPrefix),
        });
    }
  }
  if (!factories.wolfram && input.artifactPath !== undefined) {
    const artifactPath = input.artifactPath;
    const entry = input.lock.runtimes.wolfram;
    if (entry) {
      factories.wolfram = () =>
        createWolframRuntimeAdapter({
          artifactPort: createProfessionalArtifactPort({ artifactPath }),
          lockVersion: entry.version,
          ...(input.wolframKernelPath !== undefined ? { kernelPath: input.wolframKernelPath } : {}),
          ...(input.wolframLicenseProvider !== undefined ? { licenseProvider: input.wolframLicenseProvider } : {}),
          executionBackend: runtimeExecutionBackend(input, "wolfram"),
          execPrefix: legacyExecPrefix(input, input.wolframExecPrefix),
        });
    }
  }
  if (input.artifactPath !== undefined) {
    const artifactPath = input.artifactPath;
    const chemPort = createProfessionalArtifactPort({ artifactPath });
    const chemCommon = {
      ...(input.chemWorkDir !== undefined ? { workDir: input.chemWorkDir } : {}),
    };
    if (!factories.psi4 && input.lock.runtimes.psi4) {
      const entry = input.lock.runtimes.psi4;
      factories.psi4 = () =>
        createPsi4RuntimeAdapter({
          artifactPort: chemPort,
          lockVersion: entry.version,
          engineCommand: input.psi4Command ?? "psi4",
          executionBackend: runtimeExecutionBackend(input, "psi4"),
          execPrefix: legacyExecPrefix(input, input.chemExecPrefix),
          ...chemCommon,
        });
    }
    if (!factories.cp2k && input.lock.runtimes.cp2k) {
      const entry = input.lock.runtimes.cp2k;
      factories.cp2k = () =>
        createCp2kRuntimeAdapter({
          artifactPort: chemPort,
          lockVersion: entry.version,
          engineCommand: "cp2k",
          executionBackend: runtimeExecutionBackend(input, "cp2k"),
          execPrefix: legacyExecPrefix(input, input.chemExecPrefix),
          ...chemCommon,
        });
    }
    if (!factories["quantum-espresso"] && input.lock.runtimes["quantum-espresso"]) {
      const entry = input.lock.runtimes["quantum-espresso"];
      factories["quantum-espresso"] = () =>
        createQuantumEspressoRuntimeAdapter({
          artifactPort: chemPort,
          lockVersion: entry.version,
          engineCommand: "pw.x",
          executionBackend: runtimeExecutionBackend(input, "quantum-espresso"),
          execPrefix: legacyExecPrefix(input, input.chemExecPrefix),
          ...chemCommon,
        });
    }
  }
  if (!factories.jupyter && input.artifactPath !== undefined) {
    const artifactPath = input.artifactPath;
    const entry = input.lock.runtimes.jupyter;
    if (entry) {
      factories.jupyter = () =>
        createJupyterRuntimeAdapter({
          artifactPort: createProfessionalArtifactPort({ artifactPath }),
          lockVersion: entry.version,
          ...(input.jupyterWorkDir !== undefined ? { workDir: input.jupyterWorkDir } : {}),
          executionBackend: runtimeExecutionBackend(input, "jupyter"),
          execPrefix: legacyExecPrefix(input, input.jupyterExecPrefix),
          ...(input.jupyterPathForExec !== undefined ? { pathForExec: input.jupyterPathForExec } : {}),
        });
    }
  }
  if (!factories.u8 && input.artifactPath !== undefined) {
    const artifactPath = input.artifactPath;
    const entry = input.lock.runtimes.u8;
    if (entry) {
      factories.u8 = () =>
        createU8RuntimeAdapter({
          artifactPort: createProfessionalArtifactPort({ artifactPath }),
          lockVersion: entry.version,
          ...(input.u8WorkDir !== undefined ? { workDir: input.u8WorkDir } : {}),
          executionBackend: runtimeExecutionBackend(input, "u8"),
          execPrefix: legacyExecPrefix(input, input.u8ExecPrefix),
        });
    }
  }
  for (const runtimeId of Object.keys(factories) as ProfessionalRuntimeId[]) {
    const factory = factories[runtimeId];
    if (!factory) continue;
    try {
      const adapter = await factory();
      const probe = await adapter.probe();
      const entry = input.lock.runtimes[runtimeId];
      if (!entry || entry.releaseChannel !== "stable") continue;
      if (!probe.available || probe.releaseChannel !== "stable") continue;
      if (probe.version !== entry.version) continue;
      registry.register(adapter);
    } catch {
      // 依赖缺失/探测失败 = 该 runtime 不可用，不注册；registry.probe 会返回 unregistered-runtime。
    }
  }
  return registry;
}

function tenantFromUri(uri: string): string | null {
  const prefix = "artifact://";
  if (!uri.startsWith(prefix)) return null;
  const rest = uri.slice(prefix.length);
  const slash = rest.indexOf("/");
  if (slash < 0) return null;
  return rest.slice(0, slash);
}

function safeArtifactPath(basePath: string, tenantId: string, uri: string): string {
  const prefix = "artifact://";
  if (!uri.startsWith(prefix)) {
    throw new Error(`artifact uri ${uri} is not an artifact:// locator`);
  }
  const rest = uri.slice(prefix.length);
  const slash = rest.indexOf("/");
  const uriTenant = slash < 0 ? rest : rest.slice(0, slash);
  if (uriTenant !== tenantId) {
    throw new Error(`artifact tenant mismatch: ${uriTenant} != ${tenantId}`);
  }
  const relativePath = slash < 0 ? "" : rest.slice(slash + 1);
  if (relativePath === "" || relativePath.includes("\0") || relativePath.includes("..") || relativePath.startsWith("/") || relativePath.includes("\\")) {
    throw new Error(`artifact uri ${uri} escapes the tenant artifact namespace`);
  }
  const base = resolve(basePath, tenantId);
  const abs = resolve(base, relativePath);
  const rel = relative(base, abs);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith(`${sep}`)) {
    throw new Error(`artifact uri ${uri} escapes the tenant artifact namespace`);
  }
  return abs;
}

/** 生产 artifact 端口：`artifact://<tenant>/<path>` → `<artifactPath>/<tenant>/<path>`。 */
export function createProfessionalArtifactPort(input: { artifactPath: string }): ProfessionalArtifactPort {
  const artifactPath = input.artifactPath;
  return {
    async getInput(tenantId, artifact: ArtifactRef) {
      const abs = safeArtifactPath(artifactPath, tenantId, artifact.uri);
      return new Uint8Array(await readFile(abs));
    },
    async putOutput(put) {
      const uri = `artifact://${put.tenantId}/${put.jobId}/${put.kind}`;
      const abs = safeArtifactPath(artifactPath, put.tenantId, uri);
      await mkdir(abs.slice(0, abs.lastIndexOf("/")) || abs, { recursive: true });
      await writeFile(abs, put.bytes);
      return { kind: put.kind, uri, ...(put.mediaType ? { mediaType: put.mediaType } : {}) };
    },
  };
}
