/**
 * catalog/extensions/extension-loader.ts — catalog 贡献装载器（模块化 v2 P3-3）。
 *
 * 只装载 roles/spaces/observers/capabilityPolicies 且有宿主实现的贡献；
 * legacy tools/events/kernels/debugAdapters/onStartup 声明被拒绝。
 */

import { validateCatalogContributions } from "@away_from/pth-contracts";
import type { ExtensionContributionContext } from "./extension-context.js";

export interface CatalogExtensionContributions {
  roles?: unknown[];
  spaces?: unknown[];
  observers?: Record<string, unknown>;
  capabilityPolicies?: Record<string, unknown>;
}

export interface ExtensionLoadResult {
  ok: boolean;
  error?: string;
  diagnostics?: string[];
  contributions?: CatalogExtensionContributions;
}

export function loadCatalogContributions(
  declarations: unknown,
  implementation: CatalogExtensionContributions,
  ctx: ExtensionContributionContext,
): ExtensionLoadResult {
  const validation = validateCatalogContributions(declarations);
  if (!validation.ok) {
    return { ok: false, error: `贡献声明不支持：${validation.unsupported.join(", ") || "(空)"}`, diagnostics: validation.diagnostics };
  }
  const contributions: CatalogExtensionContributions = {};
  if (ctx.hasRoles) contributions.roles = implementation.roles;
  if (ctx.hasSpaces) contributions.spaces = implementation.spaces;
  if (ctx.hasObservers) contributions.observers = implementation.observers;
  if (ctx.hasCapabilityPolicies) contributions.capabilityPolicies = implementation.capabilityPolicies;
  return { ok: true, contributions };
}
