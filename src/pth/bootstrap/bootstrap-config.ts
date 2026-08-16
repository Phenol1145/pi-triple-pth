/**
 * bootstrap/bootstrap-config.ts — 环境到 manifest 的解析（模块化 v2 P3-4）。
 */

import { DEFAULT_MODULE_MANIFEST, type PthModuleManifest } from "./module-manifest.js";

export interface BootstrapConfig {
  manifest: PthModuleManifest;
  /** execution grant 签名密钥（P2-2/P2-5；未配置 → 相关路径 fail-closed） */
  executionGrantSecret?: string;
}

export function loadBootstrapConfig(env: NodeJS.ProcessEnv = process.env): BootstrapConfig {
  return {
    manifest: DEFAULT_MODULE_MANIFEST,
    executionGrantSecret: env.PTH_EXECUTION_GRANT_SECRET,
  };
}
