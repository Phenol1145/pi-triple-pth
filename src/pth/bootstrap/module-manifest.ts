/**
 * bootstrap/module-manifest.ts — 单 Host 模块 manifest（模块化 v2 P3-4）。
 *
 * 同一 manifest 同时约束 main（API Host）与 batch-process（runner Host）的装配：
 * 未知 module / 非法 catalog / 非法 policy 必须在监听端口或 fork worker 前 fail-closed。
 * 不引入 PTH_PROFILE=control|standard|full 产品选择。
 */

export type PthModuleName = "kernel" | "execution" | "catalog" | "extensions";

export interface PthModuleManifest {
  readonly modules: readonly PthModuleName[];
  /** catalog 数据源（当前唯一支持 builtin manifest） */
  readonly catalog: "builtin";
  /** 扩展贡献严格模式（P3-3：legacy tools/events 声明不可进 catalog） */
  readonly strictExtensionContributions: boolean;
}

export const DEFAULT_MODULE_MANIFEST: PthModuleManifest = {
  modules: ["kernel", "execution", "catalog", "extensions"],
  catalog: "builtin",
  strictExtensionContributions: true,
};

const KNOWN_MODULES = new Set<PthModuleName>(DEFAULT_MODULE_MANIFEST.modules);

export function validateModuleManifest(manifest: unknown): { ok: true; manifest: PthModuleManifest } | { ok: false; error: string } {
  if (typeof manifest !== "object" || manifest === null) return { ok: false, error: "module manifest required" };
  const m = manifest as Record<string, unknown>;
  if (!Array.isArray(m.modules) || m.modules.length === 0) return { ok: false, error: "manifest.modules must be non-empty" };
  const unknown = m.modules.filter((mod) => !KNOWN_MODULES.has(mod as PthModuleName));
  if (unknown.length > 0) return { ok: false, error: `unknown module(s): ${unknown.join(", ")}（known: ${[...KNOWN_MODULES].join("/")}）` };
  if (m.catalog !== "builtin") return { ok: false, error: "manifest.catalog 仅支持 builtin" };
  if (typeof m.strictExtensionContributions !== "boolean") return { ok: false, error: "manifest.strictExtensionContributions must be boolean" };
  return { ok: true, manifest: m as unknown as PthModuleManifest };
}
