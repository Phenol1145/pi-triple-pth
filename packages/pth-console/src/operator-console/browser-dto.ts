/**
 * operator-console/browser-dto.ts —— 唯一 browser-facing DTO adapter（N33 复验收 P0-3）。
 *
 * PTH 生产 inspection DTO（system-inspection facade/route 形状）在此归一化为五页
 * ViewModel 消费的浏览器 DTO。页面模块与测试都不得自造第二套形状：
 *  - Debug worker：role object / currentTaskId / regionIds / workingSet object → 平铺投影；
 *  - Memory page：nextCursor / memoryType → cursor / type；
 *  - Memory revisions：{entryId, revisions} → 行数组（action/revision/time/type）；
 *  - Config/Roles：直接数组 → {items}，roles 用 roleId → id；
 *  - 正文/凭据字段绝不进入浏览器 DTO。
 */

export function toBrowserDebugWorkers(raw: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((worker) => {
    const w = (worker ?? {}) as Record<string, unknown>;
    const role = (w.role ?? {}) as Record<string, unknown>;
    const workingSet = (w.workingSet ?? {}) as Record<string, unknown>;
    const regionIds = Array.isArray(w.regionIds) ? w.regionIds.map(String) : [];
    const regionWeights = (w.regionWeights ?? {}) as Record<string, unknown>;
    const regions = regionIds.map((regionId) => ({
      regionId,
      weights: typeof regionWeights[regionId] === "number" ? (regionWeights[regionId] as number) : null,
    }));
    return {
      workerId: typeof w.workerId === "string" ? w.workerId : "unknown",
      batchId: typeof w.batchId === "string" ? w.batchId : "",
      roleId: typeof role.roleId === "string" ? role.roleId : "unknown",
      roleRevision: typeof role.revision === "string" ? role.revision : "unknown",
      lifecycle: typeof w.lifecycle === "string" ? w.lifecycle : "unknown",
      workMode: typeof w.workMode === "string" ? w.workMode : null,
      taskId: typeof w.currentTaskId === "string" ? w.currentTaskId : null,
      leaseId: typeof w.leaseId === "string" ? w.leaseId : null,
      heartbeatAt: typeof w.heartbeatLagMs === "number" ? String(w.heartbeatLagMs) : null,
      regions,
      workingSet: [
        ...(Array.isArray(workingSet.entryIds) ? workingSet.entryIds.map(String) : []),
        ...(Array.isArray(workingSet.skillIndexIds) ? workingSet.skillIndexIds.map(String) : []),
        ...(Array.isArray(workingSet.activeSkillIds) ? workingSet.activeSkillIds.map(String) : []),
      ],
      toolNames: Array.isArray(w.toolNames) ? w.toolNames.map(String) : [],
      skillIds: Array.isArray(w.skillIds) ? w.skillIds.map(String) : [],
    };
  });
}

function toBrowserMemoryRow(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  return {
    id: typeof row.id === "string" ? row.id : "unknown",
    type: typeof row.memoryType === "string" ? row.memoryType : null,
    kind: typeof row.kind === "string" ? row.kind : "",
    status: typeof row.status === "string" ? row.status : "",
    anchors: Array.isArray(row.anchors) ? row.anchors.map(String) : [],
    version: Number.isFinite(row.version) ? row.version : null,
    createdAt: typeof row.createdAt === "string" ? row.createdAt : null,
    updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : null,
    contentBytes: Number.isFinite(row.contentBytes) ? row.contentBytes : null,
  };
}

export function toBrowserMemoryPage(raw: unknown): {
  items: Record<string, unknown>[];
  cursor: string | null;
  total: number;
} {
  const page = (raw ?? {}) as Record<string, unknown>;
  const items = Array.isArray(page.items) ? page.items.map(toBrowserMemoryRow).filter((x): x is Record<string, unknown> => x !== null) : [];
  return {
    items,
    cursor: typeof page.nextCursor === "string" ? page.nextCursor : null,
    total: items.length,
  };
}

export function toBrowserMemoryDetail(raw: unknown): Record<string, unknown> {
  const row = toBrowserMemoryRow(raw);
  return row ?? { id: "unknown", tombstone: true };
}

export function toBrowserMemoryRevisions(raw: unknown): readonly Record<string, unknown>[] {
  const payload = (raw ?? {}) as Record<string, unknown>;
  const revisions = Array.isArray(payload.revisions) ? payload.revisions : [];
  return revisions.map((revision) => {
    const r = (revision ?? {}) as Record<string, unknown>;
    return {
      action: typeof r.reason === "string" ? r.reason : typeof r.status === "string" ? r.status : "",
      revision: Number.isFinite(r.revision) ? r.revision : null,
      time: typeof r.createdAt === "string" ? r.createdAt : "",
      type: typeof r.status === "string" ? r.status : "",
    };
  });
}

export function toBrowserPthConfig(raw: unknown): { items: Record<string, unknown>[] } {
  const entries = Array.isArray(raw) ? raw : [];
  return {
    items: entries.map((entry) => {
      const e = (entry ?? {}) as Record<string, unknown>;
      return {
        key: typeof e.key === "string" ? e.key : "unknown",
        group: typeof e.group === "string" ? e.group : "",
        type: typeof e.type === "string" ? e.type : "",
        scope: typeof e.scope === "string" ? e.scope : "",
        source: typeof e.source === "string" ? e.source : "unknown",
        runtimeMutable: e.runtime === true,
        restartRequired: false,
        description: typeof e.description === "string" ? e.description : "",
        secret: e.secret === true,
        defaultValue: e.secret === true ? "***" : typeof e.defaultValue === "string" ? e.defaultValue : null,
        effectiveValue: e.secret === true ? "***" : typeof e.effectiveValue === "string" ? e.effectiveValue : null,
        sourceDetail: null,
      };
    }),
  };
}

export function toBrowserRoles(raw: unknown): { items: Record<string, unknown>[] } {
  const roles = Array.isArray(raw) ? raw : [];
  return {
    items: roles.map((role) => {
      const r = (role ?? {}) as Record<string, unknown>;
      return {
        id: typeof r.roleId === "string" ? r.roleId : typeof r.id === "string" ? r.id : "unknown",
        parent: typeof r.parent === "string" ? r.parent : null,
        revision: typeof r.revision === "string" ? r.revision : "unknown",
        family: Number.isFinite(r.generation) ? String(r.generation) : "",
        tags: Array.isArray(r.tags) ? r.tags.map(String) : [],
        capabilities: Array.isArray(r.capabilities) ? r.capabilities.map(String) : [],
        actionTools: [],
        thinking: typeof r.thinking === "string" ? r.thinking : "",
        acceptanceRole: typeof r.acceptanceRole === "string" ? r.acceptanceRole : null,
        defaultReplicas: null,
        loadPolicyRef: typeof r.loadPolicyRef === "string" ? r.loadPolicyRef : "",
        budgetPolicyRef: typeof r.budgetPolicyRef === "string" ? r.budgetPolicyRef : "",
      };
    }),
  };
}
