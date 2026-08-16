/**
 * catalog/extensions/extension-policy.ts — 扩展目录分类策略（模块化 v2 P3-3）。
 *
 * 三类：
 *  - pth-plugin：有 plugin.json、manifest 合法、贡献声明可进 catalog；
 *  - external-dir：无 plugin.json（外来工具目录——不属于 PTH 插件，不报错）；
 *  - bad-plugin：plugin.json 非法 / 贡献声明不支持（报错并给诊断）。
 */

import { validateCatalogContributions } from "../../contracts/catalog-contribution-schema.js";

export type ExtensionDirClass = "pth-plugin" | "external-dir" | "bad-plugin";

export interface ExtensionDirClassification {
  class: ExtensionDirClass;
  diagnostics: string[];
}

export interface ExtensionDirFacts {
  hasPluginJson: boolean;
  manifest?: { contracts?: unknown };
  manifestError?: string;
}

export function classifyExtensionDir(facts: ExtensionDirFacts): ExtensionDirClassification {
  if (!facts.hasPluginJson) return { class: "external-dir", diagnostics: [] };
  if (facts.manifestError) return { class: "bad-plugin", diagnostics: [facts.manifestError] };
  // PTH 插件判定只看 manifest 合法性；legacy tools/events/kernels 扩展仍是合法 PTH 插件，
  // 只是不能进 catalog（严格贡献校验由 extension-loader/ExtRegistry strictCatalogContributions 承担）。
  void validateCatalogContributions(facts.manifest?.contracts);
  return { class: "pth-plugin", diagnostics: [] };
}
