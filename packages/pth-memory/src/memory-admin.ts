/**
 * memory-admin.ts —— 记忆治理提案执行端（2026-08-14 T7 裁决：归档闭环补齐）。
 *
 * 链路：sensor:memory 观测 → controller:memory 裁决 → manage.memory.archive 落
 * memory-admin-proposal（draft）→ 监督层批准（routes-kernel /memory-admin/approve）
 * → 本模块执行（提案 official + 目标条目 archived——删除类动作经人工闸门，不自动）。
 */

import type { PgMemoryStore } from "./memory-store-pg.js";

export interface MemoryAdminResult {
  ok: boolean;
  error?: string;
  target?: string;
}

/** 批准并执行一条记忆治理提案（当前支持 archive 动作——目标条目 status→archived） */
export async function applyMemoryAdminProposal(store: PgMemoryStore, proposalId: string): Promise<MemoryAdminResult> {
  const p = await store.get(proposalId);
  if (!p || p.kind !== "memory-admin-proposal") {
    return { ok: false, error: `提案不存在或类型不符（id=${proposalId}）` };
  }
  if (p.status !== "draft") {
    return { ok: false, error: `提案状态 ${p.status}——仅 draft 可批准（幂等）` };
  }
  const content = (typeof p.content === "string" ? JSON.parse(p.content) : p.content) as { action?: string; target?: string; rationale?: string };
  if (content.action !== "archive") {
    return { ok: false, error: `动作 "${content.action ?? "?"}" 暂不支持（当前仅 archive）` };
  }
  const target = String(content.target ?? "");
  if (!target) return { ok: false, error: "提案缺 target" };
  const t = await store.get(target).catch(() => undefined);
  if (!t) return { ok: false, error: `目标条目不存在（id=${target}）` };
  if (t.kind === "role-doc" || t.kind.startsWith("role-doc:") || t.kind === "capability-index") {
    return { ok: false, error: "系统资产（prompt 层）不可归档——拒绝" };
  }
  await store.update(target, { status: "archived", meta: { ...(t.meta ?? {}), archivedAt: Date.now(), archiveProposal: proposalId } } as never);
  await store.update(proposalId, { status: "official", meta: { ...(p.meta ?? {}), approvedAt: Date.now(), target } } as never);
  return { ok: true, target };
}

