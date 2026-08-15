import { ORIGIN_ROLE, DEFAULT_ROLES, MID_ROLES, GOVERNANCE_ROLES } from "../src/pth/impls/roles/default-roles";
import { setDefaultRoles } from "../src/pth/kernel/execution/worker-cluster";
import { registerBuiltinSpaces } from "../src/pth/impls/spaces/builtin-spaces";
import { spaceRegistry } from "../src/pth/kernel/execution/space-registry";
import { setSpaceLookup } from "@away_from/pth-memory";

/** 测试装配：注入内置角色数据 + 标签注册（生产走 assembly——2026-08-13 审计 P2 核心/实现解耦）。
 *  2026-08-15 拆分：pth-memory 不 import core——测试同时注入内置空间查询。 */
export function installDefaultRoles(): void {
  setDefaultRoles(ORIGIN_ROLE, DEFAULT_ROLES, MID_ROLES, GOVERNANCE_ROLES);
  registerBuiltinSpaces(spaceRegistry);
  setSpaceLookup({ get: (id) => spaceRegistry.get(id) });
}
