/**
 * execution/tool-face-budget-check.ts —— N14 P3 工具面预算守卫执行位。
 *
 * 原实现位于 kernel/execution/tool-registry.ts，但该函数依赖 worker-cluster/agent-tools
 * （execution 侧），而 manage 扩展位于 kernel-interpreter。为保持 interpreter → execution
 * 单向依赖，这里把执行位放在 execution 包，并由装配层注入 ExtContext.toolFaceBudgetCheck。
 */

import {
  loadToolRegSnapshot,
  visibleRegistryTools,
  type ToolFaceBudgetCheck,
  type ToolRegStoreLike,
} from "@away_from/pth-kernel-interpreter";
import type { ToolRegSpec } from "@away_from/pth-memory";
import { knownRoleById } from "./worker-cluster.js";
import { toolsToSchema } from "./agent-tools.js";

export const toolFaceBudgetCheck: ToolFaceBudgetCheck = async (store, candidate, budget, opts) => {
  const snap = await loadToolRegSnapshot(store, opts);
  const over: Array<{ role: string; face: number; projected: number }> = [];
  const candidateSchemaName = candidate.name.replace(/\./g, "_");
  for (const roleId of candidate.visibility.roles) {
    const role = knownRoleById(roleId);
    const staticTools = toolsToSchema(role?.actionTools, { asp: false });
    const staticNames = new Set(staticTools.map((t) => t.name));
    const registered = visibleRegistryTools(snap, roleId)
      .filter((s) => !staticNames.has(s.name.replace(/\./g, "_")));
    const alreadyIn = staticNames.has(candidateSchemaName) || registered.some((s) => s.name === candidate.name);
    const face = staticNames.size + registered.length;
    const projected = face + (alreadyIn ? 0 : 1);
    if (projected > budget) over.push({ role: roleId, face, projected });
  }
  return { ok: over.length === 0, over };
};
