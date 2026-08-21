/**
 * bridge/manifest.ts —— 兼容 re-export。
 * Program manifest 协议已上移到 @away_from/shared（PTL 本地 program dev 与 PTH client 共用）。
 */
export {
  COMPONENT_TYPES,
  validateManifest,
  validateComponentManifest,
  type ComponentType,
  type ProgramManifest,
  type ComponentManifest,
  type ManifestResult,
  type ComponentManifestResult,
  type ManifestError,
} from "@away_from/shared";
