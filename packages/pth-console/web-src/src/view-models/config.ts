/**
 * web-src/src/view-models/config.ts — Operator Console config 页视图模型（纯 TS，无 DOM）。
 *
 * 从 legacy web/operator-console/config.js 迁移；secret 恒定打码。
 */

const REDACTED = "***";

export interface ConfigEntry {
  key: string;
  group: string;
  type: string;
  scope: string;
  source: string;
  runtimeMutable: boolean;
  restartRequired: boolean;
  description: string;
  secret: boolean;
  defaultValue: unknown;
  effectiveValue: unknown;
  sourceDetail: unknown;
}

export interface RoleEntry {
  id: string;
  parent: string | null;
  revision: string;
  family: string;
  tags: string[];
  capabilities: string[];
  actionTools: string[];
  thinking: string;
  acceptanceRole: string | null;
  defaultReplicas: number | null;
  loadPolicyRef: string;
  budgetPolicyRef: string;
}

export function redactConfigEntry(entry: Record<string, any> | null | undefined): ConfigEntry {
  const secret = Boolean(entry?.secret);
  return {
    key: typeof entry?.key === "string" ? entry.key : "unknown",
    group: typeof entry?.group === "string" ? entry.group : "",
    type: typeof entry?.type === "string" ? entry.type : "",
    scope: typeof entry?.scope === "string" ? entry.scope : "",
    source: typeof entry?.source === "string" ? entry.source : "unknown",
    runtimeMutable: Boolean(entry?.runtimeMutable),
    restartRequired: Boolean(entry?.restartRequired),
    description: typeof entry?.description === "string" ? entry.description : "",
    secret,
    defaultValue: secret ? REDACTED : entry?.defaultValue === undefined ? null : entry.defaultValue,
    effectiveValue: secret ? REDACTED : entry?.effectiveValue === undefined ? null : entry.effectiveValue,
    sourceDetail: secret ? REDACTED : entry?.sourceDetail === undefined ? null : entry.sourceDetail,
  };
}

export function createConfigViewModel() {
  const state: {
    tab: "ptl" | "pth" | "roles";
    search: string;
    ptlConfig: ConfigEntry[];
    pthConfig: ConfigEntry[];
    roles: RoleEntry[];
    roleFilter: string;
    degraded: boolean;
  } = {
    tab: "ptl",
    search: "",
    ptlConfig: [],
    pthConfig: [],
    roles: [],
    roleFilter: "",
    degraded: false,
  };

  function setTab(tab: string): ConfigView {
    if (tab !== "ptl" && tab !== "pth" && tab !== "roles") throw new Error(`unknown config tab: ${tab}`);
    state.tab = tab;
    return view();
  }

  function setSearch(value: string): ConfigView {
    state.search = String(value ?? "");
    return view();
  }

  function setRoleFilter(value: string): ConfigView {
    state.roleFilter = String(value ?? "");
    return view();
  }

  function ingestPtl(entries: unknown): ConfigView {
    state.ptlConfig = Array.isArray(entries) ? entries.map((entry) => redactConfigEntry(entry as Record<string, any>)) : [];
    return view();
  }

  function ingestPth(entries: unknown): ConfigView {
    state.pthConfig = Array.isArray(entries) ? entries.map((entry) => redactConfigEntry(entry as Record<string, any>)) : [];
    return view();
  }

  function ingestRoles(roles: unknown): ConfigView {
    state.roles = Array.isArray(roles)
      ? (roles as Array<Record<string, any>>).map((role) => ({
          id: typeof role?.id === "string" ? role.id : "unknown",
          parent: typeof role?.parent === "string" ? role.parent : null,
          revision: typeof role?.roleRevision === "string" ? role.roleRevision : typeof role?.revision === "string" ? role.revision : "unknown",
          family: typeof role?.family === "string" ? role.family : "",
          tags: Array.isArray(role?.tags) ? role.tags.map(String) : [],
          capabilities: Array.isArray(role?.capabilities) ? role.capabilities.map(String) : [],
          actionTools: Array.isArray(role?.actionTools) ? role.actionTools.map(String) : [],
          thinking: typeof role?.thinking === "string" ? role.thinking : "",
          acceptanceRole: typeof role?.acceptanceRole === "string" ? role.acceptanceRole : null,
          defaultReplicas: Number.isFinite(role?.defaultReplicas) ? role.defaultReplicas : null,
          loadPolicyRef: typeof role?.loadPolicyRef === "string" ? role.loadPolicyRef : "",
          budgetPolicyRef: typeof role?.budgetPolicyRef === "string" ? role.budgetPolicyRef : "",
        }))
      : [];
    return view();
  }

  function markDegraded(value: boolean): ConfigView {
    state.degraded = Boolean(value);
    return view();
  }

  function view(): ConfigView {
    const needle = state.search.toLowerCase();
    const ptlConfig = state.ptlConfig.filter((entry) =>
      [entry.key, entry.group, entry.type, entry.source].join(" ").toLowerCase().includes(needle),
    );
    const pthConfig = state.pthConfig.filter((entry) =>
      [entry.key, entry.group, entry.type, entry.source].join(" ").toLowerCase().includes(needle),
    );
    const roles = state.roles.filter((role) =>
      [role.id, role.parent, role.family, ...role.tags].join(" ").toLowerCase().includes(state.roleFilter.toLowerCase()),
    );
    return { ...state, ptlConfig, pthConfig, roles };
  }

  return { setTab, setSearch, setRoleFilter, ingestPtl, ingestPth, ingestRoles, markDegraded, view };
}

export interface ConfigView {
  tab: "ptl" | "pth" | "roles";
  search: string;
  ptlConfig: ConfigEntry[];
  pthConfig: ConfigEntry[];
  roles: RoleEntry[];
  roleFilter: string;
  degraded: boolean;
}
