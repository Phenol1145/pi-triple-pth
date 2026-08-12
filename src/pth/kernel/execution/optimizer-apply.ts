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

/** 从建议文本提取"建议规则:"行（规则段落——追加进 prompt 资产的原子单元） */
export function extractRuleLine(suggestionText: string): string {
  const line = suggestionText.split("\n").find((l) => l.includes("建议规则"));
  if (line) return line.replace(/^建议规则:\s*/, "").trim();
  // 兜底：整段首行（防格式漂移）
  return suggestionText.split("\n").find((l) => l.trim().length > 10)?.trim() ?? suggestionText.trim();
}

/** 批准并应用一条优化建议（draft → official + 目标资产追加规则） */
export async function applyOptimizerSuggestion(store: PgMemoryStore, suggestionId: string): Promise<ApplyResult> {
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
  if (target !== "capability-index" && !target.startsWith("role-doc:")) {
    return { ok: false, error: `target "${target}" 暂不支持自动应用（v1：capability-index/role-doc:*）` };
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
  const stamp = `\n\n【优化规则 · ${pattern}（${new Date().toISOString().slice(0, 10)} 批准）】\n- ${rule}`;
  await store.update(target, { content: base + stamp } as never);
  await store.update(suggestionId, {
    status: "official",
    meta: { ...(sug.meta ?? {}), appliedAt: Date.now(), target },
  } as never);
  return { ok: true, applied: { target, pattern } };
}
