/**
 * pit-providers — infer.ts
 *
 * 未知模型 id 的元数据推断。
 *
 * inferRules 语义（忠实于 ustc-llm index.ts:612-626 + spec 规则化设计）：
 *   - 全匹配合并：遍历规则，命中则合并字段（命中中后者覆盖前者），未命中取 defaults
 *   - 规则数组顺序即合并顺序
 *   - 返回 ModelDef（id 为输入 id，name 取 id）
 */
import type { InferRule, InferDefaults, ModelDef, ModelCost } from "./types.js";

function mergeModelDef(base: Partial<ModelDef>, rule: InferRule): void {
  if (rule.contextWindow !== undefined) base.contextWindow = rule.contextWindow;
  if (rule.maxTokens !== undefined) base.maxTokens = rule.maxTokens;
  if (rule.reasoning !== undefined) base.reasoning = rule.reasoning;
  if (rule.cost) base.cost = { ...(base.cost ?? {}), ...rule.cost } as ModelCost;
  if (rule.input) base.input = [...rule.input];
  if (rule.compat) base.compat = { ...(base.compat ?? {}), ...rule.compat };
}

export function inferModel(
  id: string,
  rules?: InferRule[] | null,
  defaults?: InferDefaults,
): ModelDef {
  const base: ModelDef = {
    id,
    name: id,
    ...(defaults ?? {}),
    input: defaults?.input ? [...defaults.input] : ["text"],
    cost: defaults?.cost ? { ...defaults.cost } : undefined,
    compat: defaults?.compat ? { ...defaults.compat } : undefined,
  };

  if (rules) {
    for (const rule of rules) {
      if (new RegExp(rule.pattern, "i").test(id)) {
        mergeModelDef(base, rule);
      }
    }
  }

  return base;
}
