/**
 * concept-design.ts —— PTL→PTH 概念设计交接（2026-08-14 T9 裁决 → 2026-08-15 D3）。
 *
 * T9 裁决：废止「渐进降输入」（任务文本只写核心意图）。
 * 协作模型：PTL 侧确保理解用户全部需求/想法 → 产出**概念设计** →
 * 交 PTH 生成实施方案（任务文本 = 概念设计文档）。
 *
 * 本模块定义交接格式与最小完整性校验；PTH CLI（pth submit --concept）与提交指南共用。
 */

export const CONCEPT_DESIGN_TEMPLATE = `【目标】
（用户最终要什么——一句话：可验收的结果）

【背景与约束】
（为什么做 / 不可违反的约束 / 依赖的环境事实）

【现状】
（已经知道什么：现有实现、相关记忆/文档、已尝试过的路径）

【概念方案】
（核心思路：怎么达成目标——关键设计决策与取舍）

【边界 / 非目标】
（明确不做什么——防止 PTH 实施时扩界）

【验收标准】
（怎么证明完成：可执行的验收条件）

【风险与未决】
（已知风险 / 需要实施中裁决的点）`;

/** 概念设计必须包含的段落（缺一不可——PTH 据此生成实施方案） */
export const REQUIRED_SECTIONS = ["【目标】", "【背景与约束】", "【现状】", "【概念方案】", "【验收标准】"] as const;

export type ConceptDesignCheck = { ok: true } | { ok: false; missing: readonly string[] };

export function validateConceptDesign(text: string): ConceptDesignCheck {
  const missing = REQUIRED_SECTIONS.filter((section) => !text.includes(section));
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true };
}

/** PTH CLI 的交接任务组装（概念设计缺省路由 planner——PTH 生成实施方案） */
export function buildConceptDesignSubmit(desc: string, opts: { title?: string; tags?: string[]; role?: string } = {}) {
  const check = validateConceptDesign(desc);
  if (!check.ok) {
    throw new Error(`概念设计不完整，缺少段落: ${check.missing.join(", ")}\n\n模板:\n${CONCEPT_DESIGN_TEMPLATE}`);
  }
  const title = opts.title ?? (desc.length > 60 ? `${desc.slice(0, 57)}…` : desc);
  const tags = [...(opts.tags ?? []), "concept-design"];
  const role = opts.role ?? "planner";
  return {
    title,
    text: desc,
    tags,
    payload: { flow: { stages: [{ task: { role } }] } },
  };
}
