/**
 * role-router —— 任务分配正交化（角色间零竞速抢票）。
 *
 * 背景：v1 任务池是"广播式抢票"——7 角色每 tick 都 peek 全部 pending 并逐个抢锁
 * （SKIP LOCKED），acceptor 抢优化任务 / analyst 一人抢 3 个串行执行——无语义路由。
 *
 * 正交化：任务发布时确定性路由到唯一角色（assigned_role），candidates 只查自己的队列：
 *   ① payload.flow 显式 role（flow 任务已自带路由）→ 优先
 *   ② tags 匹配角色 labelPatterns → 语义路由
 *   ③ 无匹配（无主任务）→ hash(taskId) % 角色数 → 确定性分片（负载均衡）
 */
import type { WorkerRole } from "./worker-cluster.js";
import { allWorkerRoles } from "./worker-cluster.js";

export interface RouteInput {
  id: string;
  tags?: string[];
  payload?: unknown;
}

/** djb2 字符串 hash（确定性、均匀） */
export function hashString(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;  // h * 33 + c
  }
  return Math.abs(h);
}

function flowRole(payload: unknown): string | null {
  const flow = (payload as { flow?: { stages?: Array<{ task?: { role?: string } }> } } | undefined)?.flow;
  const role = flow?.stages?.[0]?.task?.role;
  return typeof role === "string" && role.length > 0 ? role : null;
}

function tagRole(tags: string[], roles: WorkerRole[]): string | null {
  const lowerTags = tags.map((t) => t.toLowerCase());
  for (const role of roles) {
    for (const pat of role.labelPatterns) {
      if (lowerTags.some((t) => t.includes(pat) || pat.includes(t))) {
        return role.id;
      }
    }
  }
  return null;
}

/**
 * 任务 → 归属角色（确定性）。
 * roles 可注入（默认 DEFAULT_ROLES）；测试可传自定义角色集。
 */
export function routeTaskRole(input: RouteInput, roles: WorkerRole[] = allWorkerRoles()): string {
  if (roles.length === 0) throw new Error("routeTaskRole: empty roles");
  // ① flow 显式 role（可能不在 DEFAULT_ROLES——校验存在性，未知角色回退分片）
  const explicit = flowRole(input.payload);
  if (explicit && roles.some((r) => r.id === explicit)) return explicit;
  // ② tags 语义匹配
  if (input.tags && input.tags.length > 0) {
    const matched = tagRole(input.tags, roles);
    if (matched) return matched;
  }
  // ③ 确定性分片（无主任务负载均衡）
  return roles[hashString(input.id) % roles.length]!.id;
}
