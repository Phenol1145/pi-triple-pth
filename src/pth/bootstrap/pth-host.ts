/**
 * bootstrap/pth-host.ts — 单 Host 统一装配入口（模块化 v2 P3-4）。
 *
 * main（API Host）与 batch-process（runner Host）共用同一 manifest 构建 catalog；
 * 依赖缺失/未知 module/非法 manifest 在监听端口或 fork worker 前 fail-closed。
 */

import { validateModuleManifest, type PthModuleManifest } from "./module-manifest.js";
import { buildBuiltinCatalog } from "../catalog/adapters/builtin-catalog-contributions.js";
import { setRuntimeCatalog } from "../catalog/role-routing-policy.js";
import type { RuntimeCatalogSnapshot } from "../catalog/runtime-catalog.js";

export interface BuiltPthHost {
  manifest: PthModuleManifest;
  catalog: RuntimeCatalogSnapshot;
}

export async function buildPthHost(manifestInput: PthModuleManifest): Promise<BuiltPthHost> {
  const check = validateModuleManifest(manifestInput);
  if (!check.ok) throw new Error(`bootstrap fail-closed: ${check.error}`);
  const manifest = check.manifest;

  // P3-2/P3-4：同一 manifest 构建 catalog（assembly/batch-process 等价）
  const catalog = buildBuiltinCatalog();
  setRuntimeCatalog(catalog);

  return { manifest, catalog };
}
