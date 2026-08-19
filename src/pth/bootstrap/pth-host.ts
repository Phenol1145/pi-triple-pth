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

export interface BuiltPthHost {
  manifest: PthModuleManifest;
  catalog: RuntimeCatalogSnapshot;
}

export async function buildPthHost(manifestInput: PthModuleManifest): Promise<BuiltPthHost> {
  const check = validateModuleManifest(manifestInput);
  if (!check.ok) throw new Error(`bootstrap fail-closed: ${check.error}`);
  const manifest = check.manifest;

  // P3-2/P3-4：同一 manifest 构建 catalog（assembly/batch-process 等价）
  // Task 3：专业角色进入已知 lineage/显式权重解析（不进 allWorkerRoles 缺省单副本循环）
  setProfessionalRoles(PROFESSIONAL_ROLES);
  const catalog = buildBuiltinCatalog();
  setRuntimeCatalog(catalog);

  return { manifest, catalog };
}
