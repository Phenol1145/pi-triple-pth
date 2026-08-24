/**
 * role-catalog-loader.ts —— Role Catalog W1：目录装载器。
 *
 * 读取 `src/pth/catalog/data/roles/*.json`，逐卡片 schema 校验并投影为 RoleDefinition。
 * 尚未接入装配三调用点（W1 后半）；本模块提供装载能力与测试。
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_ROLES, MID_ROLES, GOVERNANCE_ROLES, PROFESSIONAL_ROLES, type RoleDefinition } from "@away_from/pth-kernel-execution";
import { validateRoleCardV1, type RoleCardV1 } from "./role-definition-v1.js";

export interface RoleCatalogLoadResult {
  roles: RoleDefinition[];
  cards: RoleCardV1[];
  errors: string[];
}

export function loadRoleCardsFromDir(dir: string): RoleCatalogLoadResult {
  const errors: string[] = [];
  const roles: RoleDefinition[] = [];
  const cards: RoleCardV1[] = [];

  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  } catch (e) {
    return { roles, cards, errors: [`无法读取角色目录 ${dir}: ${(e as Error).message}`] };
  }

  for (const file of files) {
    const full = join(dir, file);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(full, "utf-8"));
    } catch (e) {
      errors.push(`${file}: JSON 解析失败 ${(e as Error).message}`);
      continue;
    }
    const r = validateRoleCardV1(raw as RoleCardV1);
    if (r.ok) {
      roles.push(r.role);
      cards.push(raw as RoleCardV1);
    } else {
      errors.push(`${file}: ${r.errors.join("; ")}`);
    }
  }

  return { roles, cards, errors };
}

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROLE_CARDS_DIR = join(here, "data/roles");

export function loadDefaultRoleCards(): RoleCatalogLoadResult {
  return loadRoleCardsFromDir(DEFAULT_ROLE_CARDS_DIR);
}

export function loadDefaultRoles(): RoleDefinition[] {
  const result = loadDefaultRoleCards();
  if (result.errors.length > 0) {
    throw new Error(`role catalog 装载失败: ${result.errors.join("; ")}`);
  }
  return result.roles;
}

export interface RoleCatalogSets {
  defaultRoles: RoleDefinition[];
  midRoles: RoleDefinition[];
  governanceRoles: RoleDefinition[];
  professionalRoles: RoleDefinition[];
}

/** W1：按现有四类 id 集合从 catalog 装载并分桶（内容来自卡片，分桶沿用内置分类）。 */
export function loadDefaultRoleSets(): RoleCatalogSets {
  const all = loadDefaultRoles();
  const byId = new Map(all.map((r) => [r.id, r]));
  const pick = (ids: readonly RoleDefinition[]) => ids.map((r) => byId.get(r.id)!);
  return {
    defaultRoles: pick(DEFAULT_ROLES),
    midRoles: pick(MID_ROLES),
    governanceRoles: pick(GOVERNANCE_ROLES),
    professionalRoles: pick(PROFESSIONAL_ROLES),
  };
}
