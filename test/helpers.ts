import { ORIGIN_ROLE, DEFAULT_ROLES, MID_ROLES, GOVERNANCE_ROLES } from "../src/pth/impls/roles/default-roles";
import { setDefaultRoles } from "../src/pth/kernel/execution/worker-cluster";

/** 测试装配：注入内置角色数据 + 标签注册（生产走 assembly——2026-08-13 审计 P2 核心/实现解耦） */
export function installDefaultRoles(): void {
  setDefaultRoles(ORIGIN_ROLE, DEFAULT_ROLES, MID_ROLES, GOVERNANCE_ROLES);
}
