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

import { DEFAULT_TENANT_ID, type PgMemoryStore } from "@away_from/pth-memory";
import type { OptimizerSuggestion } from "./optimizer-loop.js";
import { rollupAggregateRows } from "./optimizer-loop.js";
import { GUARD_TUNABLE_DEFS } from "./guardrails.js";
import { config } from "../extensions/perf-params.js";

export interface ApplyResult {
  ok: boolean;
  error?: string;
  applied?: { target: string; pattern: string };
}

/** 运行时配置接口（A4 护栏 JIT 热调/回滚——缺省 perf-params config()；测试注入 fake） */
export interface RuntimeConfigLike {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
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
 *  可逆 = prompt 资产（capability-index/role-doc 规则追加——deopt 可回滚）
 *       + guard-config 参数热调（2026-08-18 A4——runtimeConfig set 可回滚）；
 *  不可逆 = 角色分化/代码/删除类——必须人工闸门，不经本自动通道） */
export function isReversibleSuggestion(target: string): boolean {
  return target === "capability-index" || target.startsWith("role-doc:") || target.startsWith("guard-config:");
}

/** 批准并应用一条优化建议（draft → official + 目标资产追加规则 + 派发复测任务） */
export async function applyOptimizerSuggestion(
  store: PgMemoryStore,
  suggestionId: string,
  queryReadOnly?: (sql: string) => Promise<unknown>,
  /** 复测任务派发（2026-08-14 N6 一等化——独立复测任务）：role-doc 目标派发受控复现任务
   *  （flow 路由到目标角色）；capability-index 目标无单一角色——不派发（走全局聚合复测） */
  publishVerifyTask?: (t: { title: string; text: string; tags: string[]; payload: unknown }) => Promise<unknown>,
  /** 运行时配置（A4 护栏 JIT 热调——缺省 perf-params config()；测试注入 fake） */
  runtimeConfig?: RuntimeConfigLike,
): Promise<ApplyResult> {
  const sug = await store.get(suggestionId, { tenantId: DEFAULT_TENANT_ID });
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

  // ── A4 护栏 JIT（2026-08-18）：guard-config 参数热调——白名单校验 → 当前值解析 →
  //    next = max(cur+1, ceil(cur*scale)) 且 ≤ ceil(cur*5) → set → 全局聚合基线（fail-closed） →
  //    official + verifyAfterWindow（不派发独立复测任务——无单一角色）。
  if (target.startsWith("guard-config:")) {
    const guardId = target.slice("guard-config:".length);
    const tunable = GUARD_TUNABLE_DEFS[guardId];
    const guard = content.guard;
    if (!tunable || !guard || guard.guard !== guardId) {
      return { ok: false, error: `guard "${guardId}" 不在可调白名单（仅软处置/负结果族可自动放宽）或建议缺 guard 信息` };
    }
    if (guard.limitKey !== tunable.limitKey) {
      return { ok: false, error: `guard limitKey "${guard.limitKey}" 与白名单不一致（期望 ${tunable.limitKey}）` };
    }
    if (typeof guard.scale !== "number" || !Number.isFinite(guard.scale) || guard.scale <= 0) {
      return { ok: false, error: `非法 scale（${String(guard.scale)}）——护栏热调拒绝` };
    }
    const rc = runtimeConfig ?? config();
    const curRaw = rc.get(tunable.limitKey);
    const curNum = Number(curRaw);
    const cur = curRaw !== undefined && curRaw !== "" && Number.isFinite(curNum) ? curNum : tunable.default;
    const next = Math.min(Math.max(cur + 1, Math.ceil(cur * guard.scale)), Math.ceil(cur * 5));
    if (next <= cur) {
      return { ok: false, error: `护栏 ${guardId} 参数已在顶（cur=${cur}）——无需放宽` };
    }
    // 基线先行（fail-closed）：护栏是安全面——无全局聚合基线不热调。
    let baseline: { taskCount: number; avgGuardKills: number; avgGuardHits: number } | undefined;
    try {
      const rows = await queryReadOnly?.(`SELECT content FROM memory_entries WHERE kind = 'task-scorecard-aggregate'`) as Array<{ content: string }> | undefined;
      const g = rows ? rollupAggregateRows(rows) : {};
      if (g.taskCount) {
        baseline = {
          taskCount: g.taskCount,
          avgGuardKills: (g.sumGuardKills ?? 0) / g.taskCount,
          avgGuardHits: (g.sumGuardHits ?? 0) / g.taskCount,
        };
      }
    } catch { /* 查询异常 → baseline 保持 undefined → fail-closed */ }
    if (!baseline) {
      return { ok: false, error: "全局聚合基线缺失——护栏热调 fail-closed 拒绝（无基线不热调）" };
    }
    rc.set(tunable.limitKey, String(next));
    await store.update(suggestionId, {
      status: "official",
      meta: {
        ...(sug.meta ?? {}),
        appliedAt: Date.now(),
        target,
        verifyAfterWindow: true,
        guardBaseline: { limitKey: tunable.limitKey, from: String(cur), to: String(next), values: { [tunable.limitKey]: String(cur) } },
        baseline,
      },
    } as never, { tenantId: DEFAULT_TENANT_ID });
    return { ok: true, applied: { target, pattern } };
  }

  const existing = await store.get(target, { tenantId: DEFAULT_TENANT_ID }).catch(() => undefined);
  const base = existing ? String(existing.content ?? "") : "";
  const rule = extractRuleLine(content.content);
  if (!rule) return { ok: false, error: "建议无规则行——无法应用" };
  // 同规则去重（防建议风暴堆积——按规则行包含判定）
  if (base.includes(rule.slice(0, 40))) {
    await store.update(suggestionId, { status: "official", meta: { ...(sug.meta ?? {}), appliedAt: Date.now(), target, note: "规则已存在——标记应用（去重）" } } as never, { tenantId: DEFAULT_TENANT_ID });
    return { ok: true, applied: { target, pattern } };
  }
  // 振荡防护上限（待决点 4）：同 target+pattern 已应用 ≥ MAX_APPLY_PER_PATTERN 次 → 拒绝
  // （规则堆 3 条仍未生效 = 建议无效/需人工——不再自动追加）——从目标资产数历史 stamp 统计
  const appliedCount = (base.match(new RegExp(`优化规则 · ${pattern}`, "g")) ?? []).length;
  if (appliedCount >= MAX_APPLY_PER_PATTERN) {
    return { ok: false, error: `已达应用上限（${MAX_APPLY_PER_PATTERN} 次）——规则未生效需人工介入（pattern=${pattern} target=${target}）` };
  }
  const stamp = `\n\n【优化规则 · ${pattern}（${new Date().toISOString().slice(0, 10)} 批准）】\n- ${rule}`;
  await store.update(target, { content: base + stamp } as never, { tenantId: DEFAULT_TENANT_ID });
  // deopt 基线快照（2026-08-13 稳定循环刹车）：应用时记目标指标——
  // 复测窗口积累后对比——劣化则回滚（optimizer-loop.checkDeopt）。
  // 2026-08-14 N6：基线分两类——role-doc 目标取角色聚合；capability-index 取全局 rollup
  // （无单一角色指标——跨角色求和；checkDeopt 按 baselineKind 选证据通道）。
  let baseline: { avgFails: number; avgSteps: number; taskCount: number } | undefined;
  const roleId = target.startsWith("role-doc:") ? target.slice("role-doc:".length) : undefined;
  try {
    if (roleId) {
      const agg = await queryReadOnly?.(
        `SELECT content FROM memory_entries WHERE id = 'task-scorecard-aggregate:${roleId}'`,
      ) as Array<{ content: string }> | undefined;
      const a = agg && agg[0] ? JSON.parse(String(agg[0].content)) as Record<string, number> : undefined;
      if (a?.taskCount) baseline = {
        avgFails: (a.sumFails ?? 0) / a.taskCount,
        avgSteps: (a.sumSteps ?? 0) / a.taskCount,
        taskCount: a.taskCount,
      };
    } else {
      const rows = await queryReadOnly?.(`SELECT content FROM memory_entries WHERE kind = 'task-scorecard-aggregate'`) as Array<{ content: string }> | undefined;
      const g = rows ? rollupAggregateRows(rows) : {};
      if (g.taskCount) baseline = {
        avgFails: (g.sumFails ?? 0) / g.taskCount,
        avgSteps: (g.sumSteps ?? 0) / g.taskCount,
        taskCount: g.taskCount,
      };
    }
  } catch { /* 基线读取失败——deopt 降级为无回滚（原行为） */ }
  // 独立复测任务派发（2026-08-14 N6 一等化）：role-doc 目标派受控复现任务——
  // flow 显式路由到目标角色；任务完成 → task-loop verifyOf → verify-aggregate → checkDeopt 受控结算。
  let verifyTaskPublished = false;
  if (roleId && publishVerifyTask) {
    try {
      await publishVerifyTask({
        title: `复测：${pattern}（${target} 优化验证）`,
        text: `优化复测任务（JIT 环自动派发——受控复现）。背景：优化规则「${pattern}」已应用于 ${target}（规则：${rule.slice(0, 200)}）。请按该规则适用的典型场景完整执行一次任务（证据场景：${JSON.stringify(content.evidence?.metric ?? {}).slice(0, 300)}），正常完成并 done 提交。你的执行质量（步数/失败动作数）将作为该规则的复测证据与基线对比——正常完成任务即可，无需额外文档。`,
        tags: [],
        payload: { flow: { stages: [{ task: { role: roleId } }] }, verifyOf: suggestionId, pattern, target },
      });
      verifyTaskPublished = true;
    } catch (e) {
      console.warn(`[optimizer] 复测任务派发失败 ${suggestionId}: ${e instanceof Error ? e.message : String(e)}——降级有机窗口复测`);
    }
  }
  await store.update(suggestionId, {
    status: "official",
    meta: { ...(sug.meta ?? {}), appliedAt: Date.now(), target, appliedCount: appliedCount + 1, verifyAfterWindow: true, verifyTaskPublished, ...(baseline ? { baseline, baselineKind: roleId ? "role" : "global", baselineRole: roleId } : {}) },
  } as never, { tenantId: DEFAULT_TENANT_ID });
  return { ok: true, applied: { target, pattern } };
}
