/**
 * execution/backend-registry.ts —— engine 执行后端注册表（P1 硬切，2026-08-22）。
 *
 * 唯一装配入口：`PTH_EXEC_BACKENDS`（descriptor JSON）+ `PTH_EXEC_BACKEND_ROUTES`
 * （ProfessionalRuntimeId → backend id）。所有规则 fail-closed：
 *  - 非法 descriptor / 重复 id / route typo / strict+required 缺 token → 装配期抛错；
 *  - 装配不探网络；启动探测由 `probeExecutionBackends` 执行（单后端超时、strict 语义）。
 *  - 不再存在任何隐式 LocalBackend；未路由 runtime 一律 unregistered。
 */

import {
  HttpExecutionBackend,
  validateExecutionBackendDescriptor,
  type ExecutionBackendDescriptor,
} from "@away_from/shared/execution";
import { isProfessionalRuntimeId, type ProfessionalRuntimeId } from "@away_from/pth-contracts";
import type { ToolRegistryFile } from "../tools/index.js";
import type { ServiceRegistryFile } from "../services/index.js";

export interface ExecutionBackendRegistry {
  get(id: string): HttpExecutionBackend | undefined;
  list(): ReadonlyMap<string, HttpExecutionBackend>;
  routes: Readonly<Partial<Record<ProfessionalRuntimeId, string>>>;
}

export interface BuildExecutionBackendRegistryInput {
  /** 缺省取 env.PTH_EXEC_BACKENDS */
  descriptorsJson?: string;
  /** 缺省取 env.PTH_EXEC_BACKEND_ROUTES */
  routesJson?: string;
  env: NodeJS.ProcessEnv;
  strict: boolean;
  fetchLike?: typeof fetch;
  capabilitiesTtlMs?: number;
  /** 缺省取 env.PTH_EXEC_SANDBOX_ALIAS（"off"/"0"/"false" 关闭） */
  sandboxAlias?: string;
  /**
   * T4：宿主 pth tools 回环注册表（engineVisible 域合并为 backend）。
   * 127.0.0.1 回环改写为 host.docker.internal（engine 容器视角）。
   */
  toolRegistry?: ToolRegistryFile;
  /**
   * T2b：宿主服务注册表（pth services 管理的本地执行器）。
   * 合并语义同 toolRegistry；显式 PTH_EXEC_BACKENDS 优先。
   */
  serviceRegistry?: ServiceRegistryFile;
}

export interface BuildExecutionBackendRegistryResult {
  registry: ExecutionBackendRegistry;
  warnings: string[];
}

export interface ProbeExecutionBackendsOptions {
  strict: boolean;
  timeoutMs: number;
  logger: { warn(message: string): void; error(message: string): void };
}

/** 合成 sandbox descriptor（现网兼容：不显式配置也保留 sandbox 后端） */
export function sandboxDescriptor(input: {
  env: NodeJS.ProcessEnv;
  strict: boolean;
}): ExecutionBackendDescriptor {
  return {
    id: "sandbox",
    url: input.env.SANDBOX_URL ?? "http://localhost:8080",
    profile: "sandbox-untrusted",
    tokenEnv: "SANDBOX_SHARED_SECRET",
    required: input.strict,
  };
}

export function buildExecutionBackendRegistry(
  input: BuildExecutionBackendRegistryInput,
): BuildExecutionBackendRegistryResult {
  const env = input.env;
  const warnings: string[] = [];

  const descriptorsJson = input.descriptorsJson ?? env.PTH_EXEC_BACKENDS ?? "";
  const routesJson = input.routesJson ?? env.PTH_EXEC_BACKEND_ROUTES ?? "";
  const alias = (input.sandboxAlias ?? env.PTH_EXEC_SANDBOX_ALIAS ?? "on").trim().toLowerCase();
  const aliasEnabled = alias !== "off" && alias !== "0" && alias !== "false";

  const descriptors: ExecutionBackendDescriptor[] = [];
  const seen = new Set<string>();
  if (descriptorsJson.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(descriptorsJson);
    } catch (error) {
      throw new Error(`PTH_EXEC_BACKENDS 不是合法 JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error("PTH_EXEC_BACKENDS must be a JSON array of ExecutionBackendDescriptor");
    }
    for (const item of parsed) {
      const descriptor = validateExecutionBackendDescriptor(item);
      if (seen.has(descriptor.id)) throw new Error(`PTH_EXEC_BACKENDS duplicate backend id: ${descriptor.id}`);
      seen.add(descriptor.id);
      descriptors.push(descriptor);
    }
  }

  if (aliasEnabled && !seen.has("sandbox")) {
    descriptors.push(sandboxDescriptor({ env, strict: input.strict }));
    seen.add("sandbox");
  }

  const toolTokens = new Map<string, string>();
  const mergedToolIds = new Set<string>();
  for (const entry of Object.values(input.toolRegistry?.tools ?? {})) {
    if (entry.domain !== "compiled" && entry.domain !== "network") continue; // secrets 不进 engine
    if (mergedToolIds.has(entry.backendId)) continue; // 同域多工具共享一个 backend
    if (seen.has(entry.backendId)) {
      warnings.push(`tool registry backend ${entry.backendId} 与显式 PTH_EXEC_BACKENDS 冲突——显式配置优先`);
      continue;
    }
    mergedToolIds.add(entry.backendId);
    seen.add(entry.backendId);
    descriptors.push({
      id: entry.backendId,
      url: entry.url.replace(/^http:\/\/127\.0\.0\.1:/, "http://host.docker.internal:"),
      profile: "dev-container",
    });
    toolTokens.set(entry.backendId, entry.token);
  }

  for (const entry of Object.values(input.serviceRegistry?.services ?? {})) {
    if (seen.has(entry.id)) {
      warnings.push(`service registry backend ${entry.id} 与显式 PTH_EXEC_BACKENDS 冲突——显式配置优先`);
      continue;
    }
    seen.add(entry.id);
    descriptors.push({
      id: entry.id,
      url: entry.url.replace(/^http:\/\/127\.0\.0\.1:/, "http://host.docker.internal:"),
      profile: "host",
      ...(entry.pathMapping ? { pathMapping: entry.pathMapping } : {}),
    });
    toolTokens.set(entry.id, entry.token);
  }

  const map = new Map<string, HttpExecutionBackend>();
  for (const descriptor of descriptors) {
    if (descriptor.tokenEnv !== undefined && !env[descriptor.tokenEnv]) {
      if (input.strict && descriptor.required === true) {
        throw new Error(`execution backend ${descriptor.id} requires env ${descriptor.tokenEnv} (required=true, strict=true)`);
      }
      warnings.push(`execution backend ${descriptor.id} token env ${descriptor.tokenEnv} 缺失（运行时将 401）`);
    }
    map.set(descriptor.id, new HttpExecutionBackend({
      descriptor,
      token: descriptor.tokenEnv !== undefined ? env[descriptor.tokenEnv] : toolTokens.get(descriptor.id),
      fetchLike: input.fetchLike,
      capabilitiesTtlMs: input.capabilitiesTtlMs,
    }));
  }

  // 退出门：strict 且零 backend → 启动即失败（日志可解释；dev 允许空 registry）。
  if (input.strict && map.size === 0) {
    throw new Error("no execution backends configured (strict=true): PTH_EXEC_BACKENDS 为空且 PTH_EXEC_SANDBOX_ALIAS=off");
  }

  const routes: Partial<Record<ProfessionalRuntimeId, string>> = {};
  if (routesJson.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(routesJson);
    } catch (error) {
      throw new Error(`PTH_EXEC_BACKEND_ROUTES 不是合法 JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("PTH_EXEC_BACKEND_ROUTES must be a JSON object of { [ProfessionalRuntimeId]: backendId }");
    }
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!isProfessionalRuntimeId(key)) {
        throw new Error(`PTH_EXEC_BACKEND_ROUTES 非法 runtime id: ${key}`);
      }
      if (typeof value !== "string" || value.length === 0) {
        throw new Error(`PTH_EXEC_BACKEND_ROUTES.${key} 必须是 backend id 字符串`);
      }
      if (!map.has(value)) {
        throw new Error(`PTH_EXEC_BACKEND_ROUTES.${key} 指向未注册 backend: ${value}`);
      }
      routes[key as ProfessionalRuntimeId] = value;
    }
  }

  const registry: ExecutionBackendRegistry = {
    get: (id) => map.get(id),
    list: () => map,
    routes,
  };
  return { registry, warnings };
}

/** 启动探测：并行 capabilities 探测 + 单后端超时；strict/required 失败抛错。 */
export async function probeExecutionBackends(
  registry: ExecutionBackendRegistry,
  opts: ProbeExecutionBackendsOptions,
): Promise<void> {
  const entries = [...registry.list().entries()];
  const results = await Promise.all(entries.map(async ([id, backend]) => {
    try {
      await backend.getCapabilities(AbortSignal.timeout(opts.timeoutMs));
      return { id, ok: true as const };
    } catch (error) {
      return {
        id,
        ok: false as const,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }));

  for (const result of results) {
    if (result.ok) continue;
    const backend = registry.get(result.id);
    const required = backend?.descriptor.required === true;
    const message = `execution backend ${result.id} probe failed: ${result.message}`;
    if (opts.strict && required) {
      throw new Error(message);
    }
    if (opts.strict) opts.logger.error(message);
    else opts.logger.warn(message);
  }
}
