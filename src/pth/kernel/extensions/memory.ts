/**
 * extensions/memory.ts —— memory 扩展（标准扩展包成员）。
 * 迁入自 capability.ts（2026-08-09 工具面收敛）：memory.query（受限只读 SQL）
 * + 封装写入（bindAll——方法提取 this 防护）。
 */

import type { TsReplExtension } from "./index.js";
import { checkWrite, checkUpdate, normalizeWriteArgs } from "./memory-policy.js";

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
  provide: (ctx) => {
    const store = ctx.dataWorld.memory;
    return {
      // 记忆查询：受限只读 SQL（与 agent 侧同源执行器——仅 SELECT/单语句/强制 LIMIT/禁 pg 系统表）
      memory: {
        ...bindAll(store),
        query: ctx.dataWorld.queryReadOnly.bind(ctx.dataWorld),
        // 用途层策略包装（权限 v2 R1——worker 面内嵌规则）：
        //   prompt/config 层拒写；governance 层强制 draft；force 参数剥离（防旁路 store 层系统文档保护）
        //   双签名归一（对象形/位置形——normalizeWriteArgs）
        write: async (a: unknown, b?: unknown, c?: unknown) => {
          let entry = normalizeWriteArgs(a, b, c);
          const check = checkWrite(entry.kind, entry.status);
          if (!check.ok) throw new Error(check.reason);
          if (check.forceStatus) entry = { ...entry, status: check.forceStatus };
          return store.write(entry as never);   // force 不透传——worker 无系统通道
        },
        update: async (id: string, patch: { content?: string; status?: "draft" | "official" | "archived" }) => {
          const existing = await store.get(id);
          if (existing) {
            const check = checkUpdate(existing.kind, patch.status);
            if (!check.ok) throw new Error(check.reason);
          }
          return store.update(id, patch);
        },
      },
    };
  },
  doc: `- memory.query: {sql} —— 只读 SQL 查记忆库 read-only（仅 SELECT；自动 LIMIT 防无界扫描）。memory_entries 表：id text, kind text('tool-function'|'task-insight'|'refine-report'|'dev-artifact'|'memory'), anchors jsonb, content text, status text('draft'|'official'|'archived'), version int, hit_count int, ttl_expires_at timestamptz, created_at timestamptz, updated_at timestamptz
- memory.write: {id?, kind, anchors, content} —— 写入记忆（沉淀）`,
};
