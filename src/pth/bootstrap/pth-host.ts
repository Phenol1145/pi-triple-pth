/**
 * bootstrap/pth-host.ts — 单 Host 统一装配入口（模块化 v2 P3-4）。
 *
 * main（API Host）与 batch-process（runner Host）共用同一 manifest 构建 catalog；
 * 依赖缺失/未知 module/非法 manifest 在监听端口或 fork worker 前 fail-closed。
 */

import { validateModuleManifest, type PthModuleManifest } from "./module-manifest.js";
import { buildBuiltinCatalog } from "../catalog/adapters/index.js";
import { setRuntimeCatalog } from "../catalog/index.js";
import type { RuntimeCatalogSnapshot } from "../catalog/index.js";
import { PROFESSIONAL_ROLES } from "../kernel/execution/professional-roles.js";
import { setProfessionalRoles } from "../kernel/execution/worker-cluster.js";
import {
  buildExecutionBackendRegistry,
  type ExecutionBackendRegistry,
} from "../execution/index.js";
import type { ProfessionalRuntimeId } from "../contracts/index.js";

export interface BuiltPthHost {
  manifest: PthModuleManifest;
  catalog: RuntimeCatalogSnapshot;
  /** P1：execution 后端注册表（descriptor 已校验；未探网络） */
  backends: ExecutionBackendRegistry;
  /** P1：专业 runtime → backend id 路由表 */
  routes: Readonly<Partial<Record<ProfessionalRuntimeId, string>>>;
  /** P1：非致命装配告警（如 token env 缺失） */
  executionWarnings: string[];
}

export interface BuildPthHostOptions {
  /** 测试注入；缺省 process.env */
  env?: NodeJS.ProcessEnv;
  fetchLike?: typeof fetch;
  /** 缺省 = PTH_CONFIG_STRICT=1 或 NODE_ENV=production */
  strict?: boolean;
  capabilitiesTtlMs?: number;
}

export function isStrictExecutionEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PTH_CONFIG_STRICT === "1" || env.NODE_ENV === "production";
}

export async function buildPthHost(
  manifestInput: PthModuleManifest,
  options: BuildPthHostOptions = {},
): Promise<BuiltPthHost> {
  const check = validateModuleManifest(manifestInput);
  if (!check.ok) throw new Error(`bootstrap fail-closed: ${check.error}`);
  const manifest = check.manifest;

  // P3-2/P3-4：同一 manifest 构建 catalog（assembly/batch-process 等价）
  // Task 3：专业角色进入已知 lineage/显式权重解析（不进 allWorkerRoles 缺省单副本循环）
  setProfessionalRoles(PROFESSIONAL_ROLES);
  const catalog = buildBuiltinCatalog();
  setRuntimeCatalog(catalog);

  // P1：执行后端注册（fail-closed：非法 descriptor/route typo 在监听/forks 前抛错；不探网络）
  const env = options.env ?? process.env;
  const { registry, warnings } = buildExecutionBackendRegistry({
    env,
    strict: options.strict ?? isStrictExecutionEnv(env),
    fetchLike: options.fetchLike,
    capabilitiesTtlMs: options.capabilitiesTtlMs,
  });

  return {
    manifest,
    catalog,
    backends: registry,
    routes: registry.routes,
    executionWarnings: warnings,
  };
}
