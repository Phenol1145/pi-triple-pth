/**
 * contracts/role-routing-policy.ts —— 角色路由策略端口（模块化优化 P0）。
 *
 * catalog 提供只读快照策略实现；kernel/execution/role-router 只依赖本端口
 * （断开 kernel→catalog 反向边）。注入方 = catalog setRuntimeCatalog（bootstrap 调用）。
 */
export interface RoleRoutingPolicy {
  validate(tags: readonly string[]): { ok: true } | { ok: false; unknown: string[] };
  routeRole(tags: readonly string[]): { ok: true; role: string | null } | { ok: false; conflict: string[] };
  flowRole(payload: unknown): string | null;
  knownRoleIds(): string[];
}
