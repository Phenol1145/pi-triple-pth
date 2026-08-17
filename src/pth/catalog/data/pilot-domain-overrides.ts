/**
 * catalog/data/pilot-domain-overrides.ts — N23 K5 评测批：试点域检索别名覆盖。
 *
 * 覆盖 programming-languages 与 materials-science 两个既有 discipline id；
 * aliases 追加去重（大小写不敏感）后由 buildPilotCatalog() 合并进
 * DISCIPLINE_DEFINITIONS，再用 DisciplineCatalogBuilder 构建快照。
 */

import type { DomainDefinition } from "../../contracts/domains.js";
import { DisciplineCatalogBuilder } from "../discipline-catalog.js";
import { DISCIPLINE_DEFINITIONS } from "./discipline-catalog-data.js";

export interface PilotDomainOverride {
  id: string; // 必须已存在于 DISCIPLINE_DEFINITIONS
  aliases: string[]; // 追加的检索别名（小写/中文均可——resolver 大小写不敏感）
  names?: Record<string, string>; // 覆盖 names（可选）
}

export const PILOT_DOMAIN_OVERRIDES: PilotDomainOverride[] = [
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

/** 把 overrides 合并进 DISCIPLINE_DEFINITIONS 后构建 catalog 快照。 */
export function buildPilotCatalog(): ReturnType<DisciplineCatalogBuilder["build"]> {
  const knownIds = new Set(DISCIPLINE_DEFINITIONS.map((def) => def.id));
  const seenOverrides = new Set<string>();
  for (const override of PILOT_DOMAIN_OVERRIDES) {
    if (seenOverrides.has(override.id)) {
      throw new Error(`pilot domain override: duplicate override id ${override.id}`);
    }
    seenOverrides.add(override.id);
    if (!knownIds.has(override.id)) {
      throw new Error(`pilot domain override: unknown domain id ${override.id}`);
    }
  }

  const builder = new DisciplineCatalogBuilder();
  const overridesById = new Map(PILOT_DOMAIN_OVERRIDES.map((o) => [o.id, o]));

  for (const def of DISCIPLINE_DEFINITIONS) {
    const override = overridesById.get(def.id);
    if (!override) {
      builder.add(def);
      continue;
    }
    const merged: DomainDefinition = {
      ...def,
      names: { ...def.names, ...(override.names ?? {}) },
      aliases: dedupeAliases(def.aliases, override.aliases),
    };
    builder.add(merged);
  }

  return builder.build();
}
