/**
 * execution/role-conservation-gate.ts —— W4：角色注册闸守恒校验（供 lineage approve 使用）。
 *
 * 硬校验：
 *  - produces 声明合法（string[] 非空字符串）
 *  - L2：新角色 capabilities ⊆ 父角色 effcap
 *  L1/L3 由静态校验器 `scripts/check-role-conservation.ts` 报告/严格档承载。
 */

import type { WorkerRole } from "@away_from/pth-kernel-execution";

function capSet(role: WorkerRole): Set<string> {
  return new Set(role.capabilities ?? []);
}

function descendants(roles: WorkerRole[], parentId: string): string[] {
  const byParent = new Map<string, string[]>();
  for (const r of roles) {
    if (!r.parent) continue;
    const list = byParent.get(r.parent) ?? [];
    list.push(r.id);
    byParent.set(r.parent, list);
  }
  const out: string[] = [];
  const queue = [parentId];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const c of byParent.get(cur) ?? []) {
      if (!out.includes(c)) {
        out.push(c);
        queue.push(c);
      }
    }
  }
  return out;
}

export function roleEffcap(roles: WorkerRole[], roleId: string): Set<string> {
  const role = roles.find((r) => r.id === roleId);
  if (!role) return new Set();
  const out = capSet(role);
  for (const d of descendants(roles, roleId)) {
    const dr = roles.find((r) => r.id === d);
    if (dr) for (const c of capSet(dr)) out.add(c);
  }
  return out;
}

export function validateRoleRegistration(newRole: WorkerRole, roles: WorkerRole[]): string | null {
  if (newRole.produces !== undefined) {
    if (!Array.isArray(newRole.produces) || newRole.produces.some((k) => typeof k !== "string" || k.trim() === "")) {
      return `produces 非法：${newRole.id} produces 必须是 string[]（非空字符串）`;
    }
  }
  if (newRole.parent) {
    const parentEff = roleEffcap(roles, newRole.parent);
    const missing = [...capSet(newRole)].filter((c) => !parentEff.has(c));
    if (missing.length > 0) {
      return `守恒 L2 拒绝：${newRole.id} 能力 ${missing.join(",")} 不在父 ${newRole.parent} effcap 中`;
    }
  }
  return null;
}
