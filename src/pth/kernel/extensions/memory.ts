/**
 * extensions/memory.ts —— memory 扩展（标准扩展包成员）。
 * 迁入自 capability.ts（2026-08-09 工具面收敛）：memory.query（受限只读 SQL）
 * + 封装写入（bindAll——方法提取 this 防护）。
 */

import type { TsReplExtension } from "./types.js";
import { checkWrite, checkUpdate, normalizeWriteArgs } from "@away_from/pth-memory";
import { checkVisibilityDeclaration, stampScope, filterVisibleEntries, ancestorChain, requireMetaColumn, validateWikiWrite } from "@away_from/pth-memory";
import { spaceRegistry } from "../execution/space-registry.js";

/**
 * 环境断言守卫（2026-08-13 鲁棒性：洞察污染防线）。
 * 模型基于错误观察的否定性环境断言（"X 空间无注册工具"——write 族裁剪 bug 实机案例）
 * 会污染共享记忆库——写入前与系统事实源（spaceRegistry）核对：矛盾即拒。
 */
function checkEnvAssertion(content: string): { ok: true } | { ok: false; reason: string } {
  const m = content.match(/([a-z0-9-]{1,32})\s*空间(?:无|没有|不存在)(?:注册)?(?:工具|函数)/);
  if (!m) return { ok: true };
  const spaceId = m[1]!;
  const sp = spaceRegistry.get(spaceId);
  if (sp?.execTool) {
    return { ok: false, reason: `环境断言与系统事实矛盾：${spaceId} 空间有执行工具（execTool=${sp.execTool}）——"${m[0]}" 基于错误观察——拒绝写入（污染防线）` };
  }
  return { ok: true };   // 空间确实无 execTool——断言合理
}

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
          return filterVisibleEntries([entry], space)[0];
        },
        // ASP 可见性过滤（读侧——仅在会话态（ASP 模式）下生效；无会话=过渡兼容不过滤）
        query: async (sql: string) => {
          const space = ctx.sessionRef?.current?.currentSpace;
          if (!space) return ctx.dataWorld.queryReadOnly(sql);
          // H3：可见性谓词下推 SQL（meta 列必查 + private 仅本空间 + public 祖先链白名单）
          requireMetaColumn(sql);
          return ctx.dataWorld.queryReadOnly(sql, { currentSpace: space, ancestors: ancestorChain(space) });
        },
        retrieve: async (opts?: unknown) => {
          const space = ctx.sessionRef?.current?.currentSpace;
          return filterVisibleEntries(await store.retrieve(opts as never), space);
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
          // 环境断言守卫（2026-08-13 污染防线）：knowledge 层洞察写前与系统事实核对
          const envCheck = checkEnvAssertion(String(entry.content ?? ""));
          if (!envCheck.ok) throw new Error(envCheck.reason);
          const meta = (entry.meta as Record<string, unknown>) ?? {};
          const vc = checkVisibilityDeclaration(meta);
          if (!vc.ok) throw new Error(vc.reason);
          const currentSpace = ctx.sessionRef?.current?.currentSpace ?? "meta";
          entry = { ...entry, meta: stampScope(meta, currentSpace) };
          // B5 / N1b：百科写入词表校验（写侧污染防线——重复术语/锚点不符/三要素缺失拒绝）
          if (entry.kind === "pth-wiki") {
            const wikiCheck = await validateWikiWrite(store, entry as never);
            if (!wikiCheck.ok) throw new Error(wikiCheck.reason);
          }
          return store.write(entry as never);   // force 不透传——worker 无系统通道
        },
        update: async (id: string, patch: { content?: string; status?: "draft" | "official" | "archived" }) => {
          // 2026-08-15 筛查 H6：worker 面仅允许 content/status——meta 等额外字段不可透传
          // （store.update 的 jsonb 合并可被用来覆写 spaceScope 提权）
          const allowed = new Set(["content", "status"]);
          const extra = Object.keys(patch ?? {}).filter((k) => !allowed.has(k));
          if (extra.length > 0) throw new Error(`memory.update: 仅允许 content/status（拒绝: ${extra.join(",")}）`);
          const existing = await store.get(id);
          if (existing) {
            const check = checkUpdate(existing.kind, patch.status, existing.status);
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
