/**
 * GENERATED FILE — 请勿手改。本文件只是分片 barrel：拼接顺序必须与生成器一致。
 * 生成命令：npx tsx scripts/build-discipline-catalog.ts
 * 数量断言（manifest 复算）：category=5、discipline=32、
 *   sub-discipline=147、total=184。
 */
import type { DomainDefinition } from "../../contracts/domains.js";
import { DISCIPLINE_CATEGORY_DEFINITIONS } from "./discipline-catalog-categories.js";
import { DISCIPLINE_DEFINITION_ENTRIES } from "./discipline-catalog-disciplines.js";
import { DISCIPLINE_SUBDISCIPLINE_DEFINITIONS_1 } from "./discipline-catalog-subdisciplines-1.js";
import { DISCIPLINE_SUBDISCIPLINE_DEFINITIONS_2 } from "./discipline-catalog-subdisciplines-2.js";
import { DISCIPLINE_SUBDISCIPLINE_DEFINITIONS_3 } from "./discipline-catalog-subdisciplines-3.js";
import { DISCIPLINE_SUBDISCIPLINE_DEFINITIONS_4 } from "./discipline-catalog-subdisciplines-4.js";

export const DISCIPLINE_DEFINITIONS: DomainDefinition[] = [
  ...DISCIPLINE_CATEGORY_DEFINITIONS,
  ...DISCIPLINE_DEFINITION_ENTRIES,
  ...DISCIPLINE_SUBDISCIPLINE_DEFINITIONS_1,
  ...DISCIPLINE_SUBDISCIPLINE_DEFINITIONS_2,
  ...DISCIPLINE_SUBDISCIPLINE_DEFINITIONS_3,
  ...DISCIPLINE_SUBDISCIPLINE_DEFINITIONS_4,
];
