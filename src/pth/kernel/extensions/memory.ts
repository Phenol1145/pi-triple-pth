/**
 * extensions/memory.ts —— memory 扩展（标准扩展包成员）。
 * 迁入自 capability.ts（2026-08-09 工具面收敛）：memory.query（受限只读 SQL）
 * + 封装写入（bindAll——方法提取 this 防护）。
 */

import type { TsReplExtension } from "./index.js";

/** bindAll：对象函数属性逐个 bind（防 vm 解构丢 this——Finding F1） */
function bindAll<T extends object>(obj: T): T {
  const out: Record<string, unknown> = {};
  const targets: Array<[string, (...args: unknown[]) => unknown]> = [];
  let proto: object | null = obj;
  const seen = new Set<string>();
  while (proto !== null && proto !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (seen.has(key)) continue;
      seen.add(key);
      const desc = Object.getOwnPropertyDescriptor(proto, key);
      if (desc && typeof desc.value === "function" && key !== "constructor") {
        targets.push([key, desc.value]);
      }
    }
    proto = Object.getPrototypeOf(proto);
  }
  for (const [key, fn] of targets) out[key] = fn.bind(obj);
  return out as T;
}

export const memoryExtension: TsReplExtension = {
  id: "memory",
  provide: (ctx) => ({
    // 记忆查询：受限只读 SQL（与 agent 侧同源执行器——仅 SELECT/单语句/强制 LIMIT/禁 pg 系统表）
    memory: {
      ...bindAll(ctx.dataWorld.memory),
      query: ctx.dataWorld.queryReadOnly.bind(ctx.dataWorld),
    },
  }),
  doc: `- memory.query: {sql} —— 只读 SQL 查记忆库 read-only（仅 SELECT；自动 LIMIT 防无界扫描）。memory_entries 表：id text, kind text('tool-function'|'task-insight'|'refine-report'|'dev-artifact'|'memory'), anchors jsonb, content text, status text('draft'|'official'|'archived'), version int, hit_count int, ttl_expires_at timestamptz, created_at timestamptz, updated_at timestamptz
- memory.write: {id?, kind, anchors, content} —— 写入记忆（沉淀）`,
};
