/**
 * tasking/delegation-policy.ts —— W8 P1 组织权矩阵（docs/pth/design/w8-task-dispatch-design.md §5）。
 *
 * 授权矩阵由角色定义（WorkerRole.parent 谱系）派生，服务器端强制：
 *  - 内部类型（有子类型）：仅其直接子类型；
 *  - planner / governor：直接子类型 + 跨子树补充权（执行族 = executor 及其全部后代）；
 *  - 叶子类型：无投递权（返回空）；
 *  - sensor / controller 系：治理面维持现状（manage 与 trigger API），不走 delegate。
 *
 * 本文件只做纯推导；roles 参数可注入（测试钉死），缺省 allKnownRoles()。
 */

import { allKnownRoles, type WorkerRole } from "@away_from/pth-kernel-execution";

export const EXECUTION_FAMILY_ROOT = "executor";

/** governance 面根（含其子类型）不参与 delegate */
export function isGovernanceFaceRole(roleId: string): boolean {
  return roleId === "sensor" || roleId === "controller" || roleId.startsWith("sensor:") || roleId.startsWith("controller:");
}

function directChildrenOf(roles: readonly WorkerRole[], parentId: string): string[] {
  return roles.filter((r) => r.parent === parentId).map((r) => r.id);
}

/** parent 链闭包：rootId 自身 + 全部后代（谱系静态树，parent 未知挂不到 root 即不计入） */
export function descendantsOf(roles: readonly WorkerRole[], rootId: string): string[] {
  const byParent = new Map<string, string[]>();
  for (const r of roles) {
    if (!r.parent) continue;
    const list = byParent.get(r.parent) ?? [];
    list.push(r.id);
    byParent.set(r.parent, list);
  }
  const out: string[] = [rootId];
  const queue = [rootId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const child of byParent.get(id) ?? []) {
      if (!out.includes(child)) {
        out.push(child);
        queue.push(child);
      }
    }
  }
  return out;
}

/**
 * 组织权矩阵：caller → 可投递目标（有序、去重）。
 * 未知角色 / 治理面 / 叶子 → 空数组。
 */
export function allowedDelegationTargets(
  callerRoleId: string,
  roles: readonly WorkerRole[] = allKnownRoles(),
): string[] {
  const caller = roles.find((r) => r.id === callerRoleId);
  if (!caller || isGovernanceFaceRole(callerRoleId)) return [];

  const direct = directChildrenOf(roles, callerRoleId);
  const supplement = callerRoleId === "planner" || callerRoleId === "governor"
    ? descendantsOf(roles, EXECUTION_FAMILY_ROOT)
    : [];
  return [...new Set([...direct, ...supplement])].sort();
}

/** 是否有投递权（工具注入开关——leaf 不注入 delegate/await） */
export function hasDelegationAuthority(callerRoleId: string, roles: readonly WorkerRole[] = allKnownRoles()): boolean {
  return allowedDelegationTargets(callerRoleId, roles).length > 0;
}
