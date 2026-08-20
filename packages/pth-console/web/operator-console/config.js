/**
 * PTL Operator Console — config 页视图模型（纯模块，无 DOM 依赖）。
 *
 * secret 恒定打码：任何 schema secret 条目的 default/effective/source detail
 * 一律 `***`（unset/short/long/malformed 全覆盖）。source `unknown` 显式保留。
 * Role 行只含 roleRevision，绝无 worker lifecycle/heartbeat 字段。
 */
const REDACTED = "***";

export function redactConfigEntry(entry) {
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
  const state = {
    tab: "ptl",
    search: "",
    ptlConfig: [],
    pthConfig: [],
    roles: [],
    roleFilter: "",
    degraded: false,
  };

  function setTab(tab) {
    if (tab !== "ptl" && tab !== "pth" && tab !== "roles") throw new Error(`unknown config tab: ${tab}`);
    state.tab = tab;
    return view();
  }

  function setSearch(value) {
    state.search = String(value ?? "");
    return view();
  }

  function setRoleFilter(value) {
    state.roleFilter = String(value ?? "");
    return view();
  }

  function ingestPtl(entries) {
    state.ptlConfig = Array.isArray(entries) ? entries.map(redactConfigEntry) : [];
    return view();
  }

  function ingestPth(entries) {
    state.pthConfig = Array.isArray(entries) ? entries.map(redactConfigEntry) : [];
    return view();
  }

  function ingestRoles(roles) {
    state.roles = Array.isArray(roles)
      ? roles.map((r) => ({
          id: typeof r?.id === "string" ? r.id : "unknown",
          parent: typeof r?.parent === "string" ? r.parent : null,
          revision: typeof r?.roleRevision === "string" ? r.roleRevision : typeof r?.revision === "string" ? r.revision : "unknown",
          family: typeof r?.family === "string" ? r.family : "",
          tags: Array.isArray(r?.tags) ? r.tags.map(String) : [],
          capabilities: Array.isArray(r?.capabilities) ? r.capabilities.map(String) : [],
          actionTools: Array.isArray(r?.actionTools) ? r.actionTools.map(String) : [],
          thinking: typeof r?.thinking === "string" ? r.thinking : "",
          acceptanceRole: typeof r?.acceptanceRole === "string" ? r.acceptanceRole : null,
          defaultReplicas: Number.isFinite(r?.defaultReplicas) ? r.defaultReplicas : null,
          loadPolicyRef: typeof r?.loadPolicyRef === "string" ? r.loadPolicyRef : "",
          budgetPolicyRef: typeof r?.budgetPolicyRef === "string" ? r.budgetPolicyRef : "",
        }))
      : [];
    return view();
  }

  function markDegraded(value) {
    state.degraded = Boolean(value);
    return view();
  }

  function view() {
    const needle = state.search.toLowerCase();
    const ptlConfig = state.ptlConfig.filter((c) =>
      [c.key, c.group, c.type, c.source].join(" ").toLowerCase().includes(needle),
    );
    const pthConfig = state.pthConfig.filter((c) =>
      [c.key, c.group, c.type, c.source].join(" ").toLowerCase().includes(needle),
    );
    const roles = state.roles.filter((r) =>
      [r.id, r.parent, r.family, ...r.tags].join(" ").toLowerCase().includes(state.roleFilter.toLowerCase()),
    );
    return { ...state, ptlConfig, pthConfig, roles };
  }

  return { setTab, setSearch, setRoleFilter, ingestPtl, ingestPth, ingestRoles, markDegraded, view };
}
