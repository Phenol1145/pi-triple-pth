/**
 * GENERATED FILE — 请勿手改。
 *
 * 生成源：docs/pth/n16-v1.2-role-expansion.md §2.1–§2.5
 * （只取 | id | 3/4/5 | parent | 职责 | 行；§2.6 非 researcher 不导入）
 * + src/pth/catalog/data/discipline-alias-overrides.ts（生产别名覆盖，F4 AB-06）。
 * 生成命令：npx tsx scripts/build-discipline-catalog.ts
 * 数量断言（manifest 复算）：category=5、discipline=32、
 *   sub-discipline=147、total=184。
 */
import type { DomainDefinition } from "@away_from/pth-contracts";
import { DISCIPLINE_DEFINITIONS_A_F } from "./discipline-catalog-data-a-f.js";
import { DISCIPLINE_DEFINITIONS_G_M } from "./discipline-catalog-data-g-m.js";
import { DISCIPLINE_DEFINITIONS_N_Z } from "./discipline-catalog-data-n-z.js";

export const DISCIPLINE_DEFINITIONS: DomainDefinition[] = [
  ...DISCIPLINE_DEFINITIONS_A_F,
  ...DISCIPLINE_DEFINITIONS_G_M,
  ...DISCIPLINE_DEFINITIONS_N_Z,
];
