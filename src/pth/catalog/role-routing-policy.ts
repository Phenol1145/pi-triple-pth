/**
 * catalog/role-routing-policy.ts — catalog 注入的角色路由策略（模块化 v2 P3-2）。
 *
 * 只读 RuntimeCatalogSnapshot；不再依赖 worker-cluster 全局 getter。
 */

import type { CatalogRole, RuntimeCatalogSnapshot } from "./runtime-catalog.js";
import type { RoleRoutingPolicy } from "@away_from/pth-contracts";
import { setKernelRoleRoutingPolicy } from "@away_from/pth-kernel-execution";

export type { RoleRoutingPolicy };

export function createRoleRoutingPolicy(snapshot: RuntimeCatalogSnapshot): RoleRoutingPolicy {
  const roles = snapshot.roles();
  const tagToRoles = new Map<string, Set<string>>();
  for (const role of roles) {
    for (const tag of role.tags) {
      const set = tagToRoles.get(tag.toLowerCase()) ?? new Set<string>();
      set.add(role.id);
      tagToRoles.set(tag.toLowerCase(), set);
    }
  }
  return {
    validate(tags) {
      const unknown = tags.filter((t) => !tagToRoles.has(t.toLowerCase()));
      return unknown.length > 0 ? { ok: false, unknown } : { ok: true };
    },
    routeRole(tags) {
      const hits = new Set<string>();
      for (const t of tags) {
        for (const role of tagToRoles.get(t.toLowerCase()) ?? []) hits.add(role);
      }
      if (hits.size > 1) return { ok: false, conflict: [...hits] };
      return { ok: true, role: hits.size === 1 ? [...hits][0]! : null };
    },
    flowRole(payload) {
      const flow = (payload as { flow?: { stages?: Array<{ task?: { role?: string } }> } } | undefined)?.flow;
      const role = flow?.stages?.[0]?.task?.role;
      return typeof role === "string" && role.length > 0 ? role : null;
    },
    knownRoleIds() {
      return roles.map((r: CatalogRole) => r.id);
    },
  };
}

// ── 运行时注入（P3-2）：assembly/batch-process 各自构建同一 manifest 后注入；
// 新生产代码经 getRoleRoutingPolicy() 读取；旧全局 getter 仅作 deprecated 兼容。
let runtimeCatalog: RuntimeCatalogSnapshot | null = null;

export function setRuntimeCatalog(snapshot: RuntimeCatalogSnapshot): void {
  runtimeCatalog = snapshot;
  // 模块化优化 P0：catalog 快照注入同时驱动 kernel 路由策略（方向 catalog→kernel，
  // 替代 kernel role-router 直接 import catalog 的旧反向边）。
  setKernelRoleRoutingPolicy(createRoleRoutingPolicy(snapshot));
}

export function getRuntimeCatalog(): RuntimeCatalogSnapshot | null {
  return runtimeCatalog;
}

export function getRoleRoutingPolicy(): RoleRoutingPolicy | null {
  return runtimeCatalog ? createRoleRoutingPolicy(runtimeCatalog) : null;
}
