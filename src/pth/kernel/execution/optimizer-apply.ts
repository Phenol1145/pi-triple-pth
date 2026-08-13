/**
 * optimizer-apply.ts —— 优化建议批准应用器（2026-08-12 体系自制——闭环的"部署"动作）。
 *
 * 闭环：sensor 观测 → controller 建议（draft）→ 监督批准（apply）→ 部署（prompt 资产追加规则）
 *   → 复测（scorecard 对比——下窗口）。
 *
 * 治理：建议是 draft（worker 面无自批权）；apply 走系统通道（主进程直写 store——
 * 不经 worker 面 memory-policy——prompt 层资产由监督层批准后写入）。
 *
 * 应用目标（v1）：capability-index / role-doc:<role>——把建议中的"建议规则"行追加为分节规则。
 * 幂等：建议仅 draft 可批准（official 后拒绝重复）；同 pattern 同 target 已应用过则追加不重复
 * （按规则行去重——防建议风暴导致的规则堆积）。
 */

import type { PgMemoryStore } from "../storage/memory-store-pg.js";
import type { OptimizerSuggestion } from "./optimizer-loop.js";

export interface ApplyResult {
  ok: boolean;
  error?: string;
  applied?: { target: string; pattern: string };
}

/** 同 target+pattern 最大应用次数（防规则堆积——振荡防护上限，待决点 4 落地：
 *  应用 3 次后同一模式不再可追加（规则应已生效——连续建议说明规则无效/需人工介入）） */
export const MAX_APPLY_PER_PATTERN = 3;

/** 从建议文本提取"建议规则:"行（规则段落——追加进 prompt 资产的原子单元） */
export function extractRuleLine(suggestionText: string): string {
  const line = suggestionText.split("\n").find((l) => l.includes("建议规则"));
  if (line) return line.replace(/^建议规则:\s*/, "").trim();
  // 兜底：整段首行（防格式漂移）
  return suggestionText.split("\n").find((l) => l.trim().length > 10)?.trim() ?? suggestionText.trim();
}

/** 可逆微调判定（2026-08-14 T4 裁决：分层闸门——
 *  可逆 = prompt 资产（capability-index/role-doc 规则追加——deopt 可回滚）；
 *  不可逆 = 角色分化/代码/删除类——必须人工闸门，不经本自动通道） */
export function isReversibleSuggestion(target: string): boolean {
  return target === "capability-index" || target.startsWith("role-doc:");
}

/** 批准并应用一条优化建议（draft → official + 目标资产追加规则） */
export async function applyOptimizerSuggestion(store: PgMemoryStore, suggestionId: string, queryReadOnly?: (sql: string) => Promise<unknown>): Promise<ApplyResult> {
  const sug = await store.get(suggestionId);
  if (!sug || sug.kind !== "optimizer-suggestion") {
    return { ok: false, error: `建议不存在（id=${suggestionId}）` };
  }
  if (sug.status !== "draft") {
    return { ok: false, error: `建议状态 ${sug.status}——仅 draft 可批准（幂等：已应用/已拒绝不重复）` };
  }
  // memory_entries.content 是 text 列——对象写入时序列化为 JSON 字符串（get 返回字符串）
  const content = (typeof sug.content === "string" ? JSON.parse(sug.content) : sug.content) as OptimizerSuggestion;
  const target = content.target;
  const pattern = content.evidence?.pattern ?? "rule";
  if (!isReversibleSuggestion(target)) {
    return { ok: false, error: `target "${target}" 为不可逆大变——自动应用通道不接（人工闸门：角色分化→lineage 审批，代码/删除类→监督层）` };
  }
  const existing = await store.get(target).catch(() => undefined);
  const base = existing ? String(existing.content ?? "") : "";
  const rule = extractRuleLine(content.content);
  if (!rule) return { ok: false, error: "建议无规则行——无法应用" };
  // 同规则去重（防建议风暴堆积——按规则行包含判定）
  if (base.includes(rule.slice(0, 40))) {
    await store.update(suggestionId, { status: "official", meta: { ...(sug.meta ?? {}), appliedAt: Date.now(), target, note: "规则已存在——标记应用（去重）" } } as never);
    return { ok: true, applied: { target, pattern } };
  }
  // 振荡防护上限（待决点 4）：同 target+pattern 已应用 ≥ MAX_APPLY_PER_PATTERN 次 → 拒绝
  // （规则堆 3 条仍未生效 = 建议无效/需人工——不再自动追加）——从目标资产数历史 stamp 统计
  const appliedCount = (base.match(new RegExp(`优化规则 · ${pattern}`, "g")) ?? []).length;
  if (appliedCount >= MAX_APPLY_PER_PATTERN) {
    return { ok: false, error: `已达应用上限（${MAX_APPLY_PER_PATTERN} 次）——规则未生效需人工介入（pattern=${pattern} target=${target}）` };
  }
  const stamp = `\n\n【优化规则 · ${pattern}（${new Date().toISOString().slice(0, 10)} 批准）】\n- ${rule}`;
  await store.update(target, { content: base + stamp } as never);
  // deopt 基线快照（2026-08-13 稳定循环刹车）：应用时记目标角色聚合指标——
  // 复测窗口积累后对比——劣化则回滚（optimizer-loop.checkDeopt）
  let baseline: { avgFails: number; avgSteps: number; taskCount: number } | undefined;
  const roleId = target.startsWith("role-doc:") ? target.slice("role-doc:".length) : undefined;
  if (roleId) {
    try {
      const agg = await queryReadOnly?.(
        `SELECT content FROM memory_entries WHERE id = 'task-scorecard-aggregate:${roleId}'`,
      ) as Array<{ content: string }> | undefined;
      const a = agg && agg[0] ? JSON.parse(String(agg[0].content)) as Record<string, number> : undefined;
      if (a?.taskCount) baseline = {
        avgFails: (a.sumFails ?? 0) / a.taskCount,
        avgSteps: (a.sumSteps ?? 0) / a.taskCount,
        taskCount: a.taskCount,
      };
    } catch { /* 基线读取失败——deopt 降级为无回滚（原行为） */ }
  }
  await store.update(suggestionId, {
    status: "official",
    meta: { ...(sug.meta ?? {}), appliedAt: Date.now(), target, appliedCount: appliedCount + 1, verifyAfterWindow: true, ...(baseline ? { baseline, baselineRole: roleId } : {}) },
  } as never);
  return { ok: true, applied: { target, pattern } };
}
