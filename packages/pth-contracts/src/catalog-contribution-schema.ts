/**
 * contracts/catalog-contribution-schema.ts — 扩展贡献声明 schema（模块化 v2 P3-3）。
 *
 * catalog 只接受有真实宿主实现的贡献：roles / spaces / observers / capabilityPolicies。
 * tools/events/kernels/debugAdapters/onStartup 属于旧注册式/编排式通道，
 * 声明时必须被拒绝并给出诊断（ExtRegistry 旧装载路径保持 legacy 兼容）。
 */

export const CATALOG_CONTRIBUTION_KINDS = ["roles", "spaces", "observers", "capabilityPolicies"] as const;
export const LEGACY_CONTRIBUTION_KINDS = ["tools", "events", "kernels", "debugAdapters", "onStartup"] as const;

export interface ContributionDeclarations {
  roles?: unknown;
  spaces?: unknown;
  observers?: unknown;
  capabilityPolicies?: unknown;
  tools?: unknown;
  events?: unknown;
  kernels?: unknown;
  debugAdapters?: unknown;
  onStartup?: unknown;
}

export interface ContributionValidation {
  ok: boolean;
  unsupported: string[];
  missing: string[];
  diagnostics: string[];
}

export function validateCatalogContributions(declarations: unknown): ContributionValidation {
  const unsupported: string[] = [];
  const missing: string[] = [];
  const diagnostics: string[] = [];
  if (typeof declarations !== "object" || declarations === null) {
    return { ok: false, unsupported, missing: ["contracts"], diagnostics: ["contribution declarations required"] };
  }
  const d = declarations as ContributionDeclarations;
  for (const kind of LEGACY_CONTRIBUTION_KINDS) {
    const v = (d as Record<string, unknown>)[kind];
    if (v !== undefined && !(Array.isArray(v) && v.length === 0)) {
      unsupported.push(kind);
      diagnostics.push(`${kind} 不是 catalog 贡献（无宿主实现）——请改用 supported: ${CATALOG_CONTRIBUTION_KINDS.join("/")}`);
    }
  }
  for (const kind of CATALOG_CONTRIBUTION_KINDS) {
    const v = (d as Record<string, unknown>)[kind];
    if (v === undefined) continue;
    if (kind === "roles" && (!Array.isArray(v) || v.length === 0)) {
      missing.push(kind);
      diagnostics.push(`${kind} 声明但未提供实现`);
    }
    if (kind === "spaces" && (!Array.isArray(v) || v.length === 0)) {
      missing.push(kind);
      diagnostics.push(`${kind} 声明但未提供实现`);
    }
    if (kind === "observers" && (typeof v !== "object" || v === null)) {
      missing.push(kind);
      diagnostics.push(`${kind} 声明但未提供实现`);
    }
    if (kind === "capabilityPolicies" && (typeof v !== "object" || v === null || Array.isArray(v))) {
      missing.push(kind);
      diagnostics.push(`${kind} 声明但未提供实现`);
    }
  }
  return { ok: unsupported.length === 0 && missing.length === 0, unsupported, missing, diagnostics };
}
