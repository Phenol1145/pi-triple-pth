/**
 * role-router —— 任务分配正交化 v2（2026-08-10 任务池纯化设计 D4/D5）。
 *
 * v1 → v2 变更（用户裁决）：
 *   - 角色标签是分选器唯一标准：tag-registry 精确匹配（双向 includes 模糊匹配废止——
 *     "testing" 不再命中 "test"，单字符 tag 不再误伤）
 *   - hash 分片兜底删除：无路由依据的任务在 publish 校验期即被拒（严格模式）——
 *     不再把无主任务随机派给任意角色（d30aa357 落 greeting-agent 事故的根源修复）
 *
 * 路由规则：
 *   ① payload.flow 显式 role（需为已注册角色）→ 优先
 *   ② tags 精确匹配 role 标签（tag-registry——唯一角色；多角色歧义校验期已拦截）
 *   ③ 无——checkTaskRouting 保证 publish 前必有路由依据
 */
import type { WorkerRole } from "./worker-cluster.js";
import { allKnownRoles } from "./worker-cluster.js";
import { tagRegistry } from "./tag-registry.js";
import type { RoleRoutingPolicy } from "@away_from/pth-contracts";

// 模块化优化 P0：策略端口由 catalog setRuntimeCatalog 注入（方向 catalog→kernel）。
let runtimePolicy: RoleRoutingPolicy | null = null;

export function setKernelRoleRoutingPolicy(policy: RoleRoutingPolicy | null): void {
  runtimePolicy = policy;
}

export function getKernelRoleRoutingPolicy(): RoleRoutingPolicy | null {
  return runtimePolicy;
}

export interface RouteInput {
  id: string;
  tags?: string[];
  payload?: unknown;
}

function flowRole(payload: unknown): string | null {
  const flow = (payload as { flow?: { stages?: Array<{ task?: { role?: string } }> } } | undefined)?.flow;
  const role = flow?.stages?.[0]?.task?.role;
  return typeof role === "string" && role.length > 0 ? role : null;
}

/**
 * 发布前路由校验（严格模式——publish 唯一入口把关；调用方将 error 映射 400）。
 * 检查序列：未知标签 → flow 角色存在性 → 多角色歧义 → 路由依据缺失。
 */
export type RoutingCheck = { ok: true } | { ok: false; error: string };

export function checkTaskRouting(input: { tags?: string[]; payload?: unknown }): RoutingCheck {
  const tags = input.tags ?? [];
  const policy = runtimePolicy;
  // P3-2：catalog 注入路径优先；旧全局 getter 仅作 deprecated 兼容（装配未注入时兜底）
  const v = policy?.validate(tags) ?? tagRegistry.validate(tags);
  if (!v.ok) {
    const known = policy
      ? tags.map((t) => t)
      : tagRegistry.list().filter((d) => d.kind === "role").map((d) => d.name);
    return { ok: false, error: `未知标签: ${v.unknown.join(", ")}（已注册角色标签: ${known.join(", ")}）` };
  }
  const flow = policy?.flowRole(input.payload) ?? flowRole(input.payload);
  const knownIds = policy?.knownRoleIds() ?? allKnownRoles().map((r) => r.id);
  if (flow && !knownIds.includes(flow)) {
    return { ok: false, error: `flow 指定的角色 "${flow}" 未注册（可选: ${knownIds.join("/")}）` };
  }
  // flow 显式指定时跳过歧义检查（governance 同标签多角色——如 controller 标签命中 5 个 controller——
  // 2026-08-12：flow 已确定角色则无需标签歧义裁决）
  const r = flow ? { ok: true as const, role: undefined as string | undefined } : (policy?.routeRole(tags) ?? tagRegistry.routeRole(tags));
  if (!r.ok) {
    return { ok: false, error: `标签歧义：命中多个角色（${r.conflict.join(" / ")}）——一个任务只能派发一个角色` };
  }
  if (!flow && !r.role) {
    return { ok: false, error: "缺少角色标签：tags 需含一个角色标签（如 code/test/analysis…），或 payload.flow 显式指定角色" };
  }
  return { ok: true };
}

/**
 * 任务 → 归属角色（确定性）。
 * 前置：publish 已经 checkTaskRouting——此处无路由依据属内部错误（throw）。
 */
export function routeTaskRole(input: RouteInput, roles: WorkerRole[] = allKnownRoles()): string {
  const policy = runtimePolicy;
  // ① flow 显式 role（校验期已保证已注册）
  const explicit = policy?.flowRole(input.payload) ?? flowRole(input.payload);
  if (explicit && roles.some((r) => r.id === explicit)) return explicit;
  // ② tags 精确匹配
  const r = policy?.routeRole(input.tags ?? []) ?? tagRegistry.routeRole(input.tags ?? []);
  if (r.ok && r.role) return r.role;
  throw new Error(`routeTaskRole: 任务 ${input.id} 无路由依据（应已被 checkTaskRouting 拦截）`);
}
