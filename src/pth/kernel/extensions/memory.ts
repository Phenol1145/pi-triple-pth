/**
 * extensions/memory.ts —— memory 扩展（标准扩展包成员）。
 * 迁入自 capability.ts（2026-08-09 工具面收敛）：memory.query（受限只读 SQL）
 * + 封装写入（bindAll——方法提取 this 防护）。
 */

import type { TsReplExtension } from "./index.js";
import { checkWrite, checkUpdate, normalizeWriteArgs } from "./memory-policy.js";
import { checkVisibilityDeclaration, stampScope, isVisible } from "../execution/memory-visibility.js";

export const memoryExtension: TsReplExtension = {
  id: "memory",
  provide: (ctx) => {
    const store = ctx.dataWorld.memory;
    return {
      // 记忆查询：受限只读 SQL（与 agent 侧同源执行器——仅 SELECT/单语句/强制 LIMIT/禁 pg 系统表）
      // 2026-08-12 审计 CRITICAL-1 修复：bindAll(store) 曾把 raw 方法（incrementAggregate/get/bumpHitCount/
      // listIds…）直接暴露给 ts 程序——incrementAggregate 键拼 SQL 可注入——改为显式白名单
      // （只有策略包装过的 query/retrieve/write/update + 可见性过滤的 get）。
      memory: {
        // get 包装：可见性过滤（与 query/retrieve 对齐——避免读隐藏条目）
        get: async (id: string) => {
          const entry = await store.get(id);
          const space = ctx.sessionRef?.current?.currentSpace;
          if (!entry || !space) return entry;
          return isVisible(entry.meta as Record<string, unknown>, space) ? entry : undefined;
        },
        // ASP 可见性过滤（读侧——仅在会话态（ASP 模式）下生效；无会话=过渡兼容不过滤）
        query: async (sql: string) => {
          const rows = await ctx.dataWorld.queryReadOnly(sql) as Array<{ meta?: Record<string, unknown> }>;
          const space = ctx.sessionRef?.current?.currentSpace;
          if (!space) return rows;
          return rows.filter((r) => isVisible(r.meta, space));
        },
        retrieve: async (opts?: unknown) => {
          const entries = await store.retrieve(opts as never);
          const space = ctx.sessionRef?.current?.currentSpace;
          if (!space) return entries;
          return entries.filter((e) => isVisible(e.meta as Record<string, unknown>, space));
        },
        // 用途层策略包装（权限 v2 R1——worker 面内嵌规则）：
        //   prompt/config 层拒写；governance 层强制 draft；force 参数剥离（防旁路 store 层系统文档保护）
        //   双签名归一（对象形/位置形——normalizeWriteArgs）
        // ASP 可见性（R-空间维度）：显式声明必检 + 系统盖章当前空间
        write: async (a: unknown, b?: unknown, c?: unknown) => {
          let entry = normalizeWriteArgs(a, b, c);
          // 顶层 visibility 归一到 meta（声明位）
          if (entry["visibility"] !== undefined) {
            entry.meta = { ...((entry.meta as Record<string, unknown>) ?? {}), visibility: entry["visibility"] };
            delete entry["visibility"];
          }
          const check = checkWrite(entry.kind, entry.status);
          if (!check.ok) throw new Error(check.reason);
          if (check.forceStatus) entry = { ...entry, status: check.forceStatus };
          const meta = (entry.meta as Record<string, unknown>) ?? {};
          const vc = checkVisibilityDeclaration(meta);
          if (!vc.ok) throw new Error(vc.reason);
          const currentSpace = ctx.sessionRef?.current?.currentSpace ?? "meta";
          entry = { ...entry, meta: stampScope(meta, currentSpace) };
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
  doc: `- memory.query: {sql} —— 只读 SQL 查记忆库（仅 SELECT memory_entries；自动 LIMIT 防无界扫描）。memory_entries 表：id text, kind text, anchors jsonb, content text, status text('draft'|'official'|'archived'), version int, hit_count int, created_at timestamptz, updated_at timestamptz
- memory.write: {id?, kind, anchors, content} —— 写入记忆（沉淀）。【用途层规则】知识层（task-insight/tool-function/dev-artifact 等）自由写；治理层（differentiation-proposal）强制 draft（提交草案——official 由监督层流转）；prompt/config 层（role-doc/trigger/capability-index 等系统资产）只读
- memory.update: {id, content?} —— 内容修正（系统层不可改；治理层不可改状态）`,
};
