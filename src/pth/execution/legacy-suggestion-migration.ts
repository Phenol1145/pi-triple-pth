/**
 * execution/legacy-suggestion-migration.ts —— W4：optimizer-suggestion 存量条目分类迁移。
 *
 * 规则（不确定项保留原 kind + 人工分流标记）：
 *  - 含 modification-plan 结构字段（goal/changes/expected/rollback/retestWindow/implementation）→ modification-plan
 *  - 含观测语义（observation/severity/evidence 等）且不含方案结构 → observation-report
 *  - 其它 → 保留 optimizer-suggestion，meta.needsReview=true
 */

export type LegacySuggestionKind = "observation-report" | "modification-plan" | "optimizer-suggestion";

const PLAN_FIELDS = ["goal", "changes", "expected", "rollback", "retestWindow", "implementation"];
const OBS_FIELDS = ["observation", "severity", "evidence", "findings", "metrics"];

export function classifyLegacySuggestionKind(content: unknown): LegacySuggestionKind {
  const c = (content ?? {}) as Record<string, unknown>;
  if (typeof c !== "object" || c === null) return "optimizer-suggestion";
  const hasPlan = PLAN_FIELDS.some((f) => typeof c[f] === "string" && (c[f] as string).trim().length > 0)
    || (typeof c["implementation"] === "object" && c["implementation"] !== null);
  if (hasPlan) return "modification-plan";
  const hasObs = OBS_FIELDS.some((f) => typeof c[f] === "string" && (c[f] as string).trim().length > 0);
  return hasObs ? "observation-report" : "optimizer-suggestion";
}
