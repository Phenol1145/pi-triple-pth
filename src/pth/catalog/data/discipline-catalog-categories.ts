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
import type { DomainDefinition } from "../../contracts/domains.js";

export const DISCIPLINE_CATEGORY_DEFINITIONS: DomainDefinition[] = [
  {
    "id": "applied-science",
    "names": {
      "zh-CN": "应用科学门类",
      "en": "applied-science"
    },
    "aliases": [],
    "parents": [],
    "level": "category",
    "description": "应用科学门类——工程/医学/农业/建筑/传媒/教育/商业/军事的中层",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "formal-science",
    "names": {
      "zh-CN": "形式科学门类",
      "en": "formal-science"
    },
    "aliases": [],
    "parents": [],
    "level": "category",
    "description": "形式科学门类——数学/逻辑/CS/统计/系统科学的中层",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "humanities",
    "names": {
      "zh-CN": "人文学科门类",
      "en": "humanities"
    },
    "aliases": [],
    "parents": [],
    "level": "category",
    "description": "人文学科门类——文学/哲学/艺术/宗教/区域的中层",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "natural-science",
    "names": {
      "zh-CN": "自然科学门类",
      "en": "natural-science"
    },
    "aliases": [],
    "parents": [],
    "level": "category",
    "description": "自然科学门类——物理/化学/生物/地球/空间的中层",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  },
  {
    "id": "social-science",
    "names": {
      "zh-CN": "社会科学门类",
      "en": "social-science"
    },
    "aliases": [],
    "parents": [],
    "level": "category",
    "description": "社会科学门类——经济/社会/心理/政治/人类/语言/地理/历史的中层",
    "methodAnchors": [],
    "sourceRegistryIds": [],
    "toolAnchors": []
  }
];
