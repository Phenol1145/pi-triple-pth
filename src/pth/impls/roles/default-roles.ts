/**
 * impls/roles/default-roles.ts —— 内置 worker 谱系（兼容 re-export）。
 *
 * 模块化优化 P0：定义数据已下移 kernel/execution/builtin-roles.ts（断开 kernel→impls 反向边）。
 * 新代码请直接 import kernel/execution/builtin-roles.js；本文件仅为既有消费者保留。
 */
export { ORIGIN_ROLE, DEFAULT_ROLES, MID_ROLES, GOVERNANCE_ROLES } from "../../kernel/execution/builtin-roles.js";
