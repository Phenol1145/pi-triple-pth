/**
 * catalog/data/discipline-alias-overrides.ts — 生产域别名覆盖（F4 AB-06）。
 *
 * 覆盖 programming-languages 与 materials-science 两个既有 discipline id；
 * aliases 追加去重（大小写不敏感）后由 scripts/gen/build-discipline-catalog.ts 在生成
 * DISCIPLINE_DEFINITIONS 时合并；names 为可选的 names 覆盖。
 * 生产 assembly/batch/evaluator 都使用同一份生成数据。
 */

import type { DomainDefinition } from "@away_from/pth-contracts";

export interface DisciplineAliasOverride {
  id: string; // 必须已存在于 DISCIPLINE_DEFINITIONS
  aliases: string[]; // 追加的检索别名（小写/中文均可——resolver 大小写不敏感）
  names?: Record<string, string>; // 覆盖 names（可选）
}

export const PRODUCTION_DOMAIN_ALIAS_OVERRIDES: DisciplineAliasOverride[] = [
  {
    id: "programming-languages",
    aliases: [
      "编程语言",
      "类型系统",
      "编译器",
      "程序分析",
      "类型检查",
      "中间表示",
      "语言规范",
    ],
  },
  {
    id: "materials-science",
    aliases: [
      "材料科学",
      "固态电解质",
      "离子电导率",
      "电化学稳定窗口",
      "材料数据库",
      "Materials Project",
      "NOMAD",
    ],
  },
];

function dedupeAliases(existing: readonly string[], additional: readonly string[]): string[] {
  const out = [...existing];
  for (const alias of additional) {
    if (alias.trim() === "") continue;
    const lower = alias.toLocaleLowerCase();
    if (!out.some((a) => a.toLocaleLowerCase() === lower)) {
      out.push(alias);
    }
  }
  return out;
}

/** 把生产 overrides 合并进目录定义：aliases 追加去重、names 覆盖。 */
export function applyDisciplineAliasOverrides(
  defs: readonly DomainDefinition[],
  overrides: readonly DisciplineAliasOverride[],
): DomainDefinition[] {
  const knownIds = new Set(defs.map((def) => def.id));
  const seenOverrides = new Set<string>();
  for (const override of overrides) {
    if (seenOverrides.has(override.id)) {
      throw new Error(`discipline alias override: duplicate override id ${override.id}`);
    }
    seenOverrides.add(override.id);
    if (!knownIds.has(override.id)) {
      throw new Error(`discipline alias override: unknown domain id ${override.id}`);
    }
  }

  const overridesById = new Map(overrides.map((o) => [o.id, o]));
  return defs.map((def) => {
    const override = overridesById.get(def.id);
    if (!override) return def;
    return {
      ...def,
      names: { ...def.names, ...(override.names ?? {}) },
      aliases: dedupeAliases(def.aliases, override.aliases),
    };
  });
}
