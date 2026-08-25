/**
 * config/index.ts —— PTH 配置模块公共 API（配置集中化，2026-08-16）。
 */
export { PTH_CONFIG_SCHEMA, getConfigDef, secretConfigKeys, runtimeConfigKeys } from "./schema.js";
export type { PthConfigDef, ConfigValueType, ConfigScope, ConfigGroup } from "./schema.js";
export {
  config,
  resetConfig,
  configNumber,
  pthConfig,
  resetPthConfig,
  validatePthConfig,
  exportPtlMigration,
  PthConfig,
} from "./config-center.js";
export type { ConfigCenter, ConfigIssue } from "./config-center.js";
export { parseEnvFile } from "./env-file.js";
