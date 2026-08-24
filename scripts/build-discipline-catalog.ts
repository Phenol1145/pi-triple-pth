/**
 * scripts/build-discipline-catalog.ts — K0 Discipline Catalog 数据生成器。
 *
 * 事实源：docs/pth/design/n16-v1.2-role-expansion.md §2.1–§2.5（§2.6 非 researcher 不导入）。
 * 解析规则：只取形如 `| id | 3/4/5 | parent | 职责 |` 的行；
 *   gen 映射 3→category、4→discipline、5→sub-discipline。
 *
 * 模式：
 *   默认（无参数）：解析 → 复算数量断言 → 写 src/pth/catalog/data/discipline-catalog-data.ts；
 *   --check：解析 → 与磁盘文件逐字节一致 + 数量断言。
 *
 * 数量钉死（manifest 复算取代文档手写总数）：
 *   category=5、discipline=32、sub-discipline=147、total=184。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  validateDomainDefinition,
  type DomainDefinition,
  type DomainLevel,
} from "@away_from/pth-contracts";
import {
  applyDisciplineAliasOverrides,
  PRODUCTION_DOMAIN_ALIAS_OVERRIDES,
} from "../src/pth/catalog/data/discipline-alias-overrides.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_DOC = resolve(ROOT, "docs/pth/design/n16-v1.2-role-expansion.md");
const OUT_FILE = resolve(ROOT, "src/pth/catalog/data/discipline-catalog-data.ts");

const EXPECTED_COUNTS = { category: 5, discipline: 32, subDiscipline: 147, total: 184 };
const GEN_TO_LEVEL: Record<string, DomainLevel> = {
  "3": "category",
  "4": "discipline",
  "5": "sub-discipline",
};

function fail(message: string): never {
  throw new Error(message);
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

/** 职责列中“——”之前的最短职责名；无“——”则整段截断 80 字符。 */
function deriveZhName(duty: string): string {
  const trimmed = duty.trim();
  const idx = trimmed.indexOf("——");
  const name = idx >= 0 ? trimmed.slice(0, idx).trim() : trimmed;
  return truncate(name, 80);
}

interface ParsedRow {
  id: string;
  gen: string;
  parent: string;
  duty: string;
}

function parseRows(markdown: string): ParsedRow[] {
  const lines = markdown.split(/\r?\n/);
  const startIdx = lines.findIndex((line) => /^### 2\.1\b/.test(line));
  const endIdx = lines.findIndex((line) => /^### 2\.6\b/.test(line));
  if (startIdx === -1) fail("事实源解析失败：未找到 §2.1 标题");
  if (endIdx === -1 || endIdx <= startIdx) fail("事实源解析失败：未找到 §2.6 标题（解析边界）");

  for (const section of ["2.1", "2.2", "2.3", "2.4", "2.5"]) {
    const found = lines.slice(startIdx, endIdx).some((line) => new RegExp(`^### ${section}\\b`).test(line));
    if (!found) fail(`事实源解析失败：未找到 §${section} 标题`);
  }

  const rows: ParsedRow[] = [];
  for (let i = startIdx + 1; i < endIdx; i += 1) {
    const line = lines[i]!;
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.length !== 4) continue; // §2.6 等 5 列表格不导入
    const [id, gen, parent, duty] = cells;
    if (gen !== "3" && gen !== "4" && gen !== "5") continue; // 表头/分隔行跳过
    if (!id || !parent || !duty) fail(`事实源解析失败：表格行不完整：${line}`);
    rows.push({ id, gen, parent, duty });
  }
  return rows;
}

function buildDefinitions(rows: ParsedRow[]): DomainDefinition[] {
  const byId = new Map<string, DomainDefinition>();
  for (const row of rows) {
    if (byId.has(row.id)) fail(`事实源解析失败：重复 id ${row.id}`);
    const level = GEN_TO_LEVEL[row.gen] ?? fail(`事实源解析失败：非法 gen ${row.gen}（id=${row.id}）`);
    const def: DomainDefinition = {
      id: row.id,
      names: { "zh-CN": deriveZhName(row.duty), en: row.id },
      aliases: [],
      parents: level === "category" ? [] : [row.parent],
      level,
      description: truncate(row.duty.trim(), 200),
      methodAnchors: [],
      sourceRegistryIds: [],
      toolAnchors: [],
    };
    const check = validateDomainDefinition(def);
    if (!check.ok) fail(`生成校验失败：${check.error}`);
    byId.set(row.id, def);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function levelCounts(defs: DomainDefinition[]) {
  const counts = { category: 0, discipline: 0, subDiscipline: 0, total: defs.length };
  for (const d of defs) {
    if (d.level === "category") counts.category += 1;
    else if (d.level === "discipline") counts.discipline += 1;
    else if (d.level === "sub-discipline") counts.subDiscipline += 1;
  }
  return counts;
}

function assertCounts(defs: DomainDefinition[]) {
  const counts = levelCounts(defs);
  if (
    counts.category !== EXPECTED_COUNTS.category ||
    counts.discipline !== EXPECTED_COUNTS.discipline ||
    counts.subDiscipline !== EXPECTED_COUNTS.subDiscipline ||
    counts.total !== EXPECTED_COUNTS.total
  ) {
    fail(
      `数量断言失败：category=${counts.category}（期望 ${EXPECTED_COUNTS.category}）、` +
        `discipline=${counts.discipline}（期望 ${EXPECTED_COUNTS.discipline}）、` +
        `sub-discipline=${counts.subDiscipline}（期望 ${EXPECTED_COUNTS.subDiscipline}）、` +
        `total=${counts.total}（期望 ${EXPECTED_COUNTS.total}）`,
    );
  }
  return counts;
}

const PART_A_FILE = "discipline-catalog-data-a-f.ts";
const PART_B_FILE = "discipline-catalog-data-g-m.ts";
const PART_C_FILE = "discipline-catalog-data-n-z.ts";
const PART_A_EXPORT = "DISCIPLINE_DEFINITIONS_A_F";
const PART_B_EXPORT = "DISCIPLINE_DEFINITIONS_G_M";
const PART_C_EXPORT = "DISCIPLINE_DEFINITIONS_N_Z";

function partitionDefs(defs: DomainDefinition[]): { aF: DomainDefinition[]; gM: DomainDefinition[]; nZ: DomainDefinition[] } {
  const aF: DomainDefinition[] = [];
  const gM: DomainDefinition[] = [];
  const nZ: DomainDefinition[] = [];
  for (const def of defs) {
    const first = def.id.charAt(0).toLowerCase();
    if (first >= "a" && first <= "f") aF.push(def);
    else if (first >= "g" && first <= "m") gM.push(def);
    else nZ.push(def);
  }
  return { aF, gM, nZ };
}

function renderPart(defs: DomainDefinition[], exportName: string, counts: ReturnType<typeof levelCounts>): string {
  const json = JSON.stringify(defs, null, 2);
  return `/**
 * GENERATED FILE — 请勿手改。
 *
 * 生成源：docs/pth/design/n16-v1.2-role-expansion.md §2.1–§2.5
 * （只取 | id | 3/4/5 | parent | 职责 | 行；§2.6 非 researcher 不导入）
 * + src/pth/catalog/data/discipline-alias-overrides.ts（生产别名覆盖，F4 AB-06）。
 * 生成命令：npx tsx scripts/build-discipline-catalog.ts
 * 数量断言（manifest 复算）：category=${counts.category}、discipline=${counts.discipline}、
 *   sub-discipline=${counts.subDiscipline}、total=${counts.total}。
 */
import type { DomainDefinition } from "@away_from/pth-contracts";

export const ${exportName}: DomainDefinition[] = ${json};
`;
}

function renderMain(counts: ReturnType<typeof levelCounts>): string {
  return `/**
 * GENERATED FILE — 请勿手改。
 *
 * 生成源：docs/pth/design/n16-v1.2-role-expansion.md §2.1–§2.5
 * （只取 | id | 3/4/5 | parent | 职责 | 行；§2.6 非 researcher 不导入）
 * + src/pth/catalog/data/discipline-alias-overrides.ts（生产别名覆盖，F4 AB-06）。
 * 生成命令：npx tsx scripts/build-discipline-catalog.ts
 * 数量断言（manifest 复算）：category=${counts.category}、discipline=${counts.discipline}、
 *   sub-discipline=${counts.subDiscipline}、total=${counts.total}。
 */
import type { DomainDefinition } from "@away_from/pth-contracts";
import { ${PART_A_EXPORT} } from "./${PART_A_FILE.replace(/\.ts$/, ".js")}";
import { ${PART_B_EXPORT} } from "./${PART_B_FILE.replace(/\.ts$/, ".js")}";
import { ${PART_C_EXPORT} } from "./${PART_C_FILE.replace(/\.ts$/, ".js")}";

export const DISCIPLINE_DEFINITIONS: DomainDefinition[] = [
  ...${PART_A_EXPORT},
  ...${PART_B_EXPORT},
  ...${PART_C_EXPORT},
];
`;
}

function main(): void {
  const markdown = readFileSync(SOURCE_DOC, "utf8");
  const baseDefs = buildDefinitions(parseRows(markdown));
  const defs = applyDisciplineAliasOverrides(baseDefs, PRODUCTION_DOMAIN_ALIAS_OVERRIDES);
  const counts = assertCounts(defs);
  const { aF, gM, nZ } = partitionDefs(defs);
  const partA = renderPart(aF, PART_A_EXPORT, counts);
  const partB = renderPart(gM, PART_B_EXPORT, counts);
  const partC = renderPart(nZ, PART_C_EXPORT, counts);
  const mainSource = renderMain(counts);
  const checkMode = process.argv.includes("--check");

  const generatedFiles: Array<{ file: string; content: string }> = [
    { file: OUT_FILE, content: mainSource },
    { file: resolve(dirname(OUT_FILE), PART_A_FILE), content: partA },
    { file: resolve(dirname(OUT_FILE), PART_B_FILE), content: partB },
    { file: resolve(dirname(OUT_FILE), PART_C_FILE), content: partC },
  ];

  if (checkMode) {
    for (const { file, content } of generatedFiles) {
      const disk = readFileSync(file, "utf8");
      if (disk !== content) {
        fail(`--check 失败：${relative(ROOT, file)} 与重新解析内容不一致——请运行 npx tsx scripts/build-discipline-catalog.ts 重新生成`);
      }
    }
    console.log(
      `✓ --check 一致：category=${counts.category} discipline=${counts.discipline} ` +
        `sub-discipline=${counts.subDiscipline} total=${counts.total}`,
    );
    return;
  }

  mkdirSync(dirname(OUT_FILE), { recursive: true });
  for (const { file, content } of generatedFiles) {
    writeFileSync(file, content, "utf8");
    console.log(`✓ 已生成 ${relative(ROOT, file)}`);
  }
  console.log(
    `✓ manifest 复算：category=${counts.category} discipline=${counts.discipline} ` +
      `sub-discipline=${counts.subDiscipline} total=${counts.total}`,
  );
}

try {
  main();
} catch (error) {
  console.error(`[build-discipline-catalog] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
