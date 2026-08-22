/**
 * catalog/discipline-resolver.ts — K2 学科识别 Resolver（v1-explicit-alias）。
 *
 * 保守可解释：显式 domains 只做 catalog 校验（未知 fail-closed、confidence=1、
 * evidence=explicit:<id>）；显式为空时用「别名 + names.zh-CN 子串扫描」识别，
 * 命中 confidence=0.6、evidence=text:<alias>，按 id 排序取前 5。
 * 不做 tags 与 domain 互转（role tags 与 domain ids 命名空间分离，P0-4 裁决）。
 */

import {
  validateDomainBinding,
  type DomainBinding,
  type DomainId,
  type DomainMatch,
} from "@away_from/pth-contracts";
import type { DisciplineCatalogSnapshot } from "./discipline-catalog.js";

export interface DisciplineResolveInput {
  title: string;
  text: string;
  tags: readonly string[];
  /** 显式 domains（调用方声明——仍需 catalog 校验；可为空） */
  explicitDomains?: readonly DomainId[];
}

export type DisciplineResolveResult =
  | { ok: true; binding: DomainBinding }
  | { ok: false; error: string };

export interface DisciplineResolver {
  resolve(input: DisciplineResolveInput): DisciplineResolveResult;
}

export const DISCIPLINE_RESOLVER_VERSION = "v1-explicit-alias";
export const DISCIPLINE_ALIAS_SCAN_MAX_MATCHES = 5;

function compareIds(a: string, b: string): number {
  return a.localeCompare(b);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

export function createDisciplineResolver(catalog: DisciplineCatalogSnapshot): DisciplineResolver {
  return {
    resolve(input) {
      const title = typeof input.title === "string" ? input.title : "";
      const text = typeof input.text === "string" ? input.text : "";
      const explicitDomains = Array.isArray(input.explicitDomains)
        ? input.explicitDomains.filter((id): id is string => typeof id === "string")
        : [];

      let matches: DomainMatch[];

      if (explicitDomains.length > 0) {
        // 规则 1：显式 domains 非空——每个 id 必须存在；去重后按 id 排序。
        for (const id of explicitDomains) {
          if (!catalog.get(id)) {
            return { ok: false, error: `discipline resolver: unknown domain id: ${id}` };
          }
        }
        const unique = [...new Set(explicitDomains)].sort(compareIds);
        matches = unique.map((domainId) => ({
          domainId,
          confidence: 1,
          evidence: [`explicit:${domainId}`],
        }));
      } else {
        // 规则 2：显式为空 → 别名扫描（非 LLM）——title + " " + text 大小写不敏感子串匹配。
        const haystack = `${title} ${text}`.toLocaleLowerCase();
        const hits: Array<{ domainId: DomainId; alias: string }> = [];
        for (const def of catalog.list()) {
          const needles: string[] = [...def.aliases];
          const zhName = def.names["zh-CN"];
          if (isNonEmptyString(zhName)) needles.push(zhName);

          for (const alias of needles) {
            if (!isNonEmptyString(alias)) continue;
            if (haystack.includes(alias.toLocaleLowerCase())) {
              hits.push({ domainId: def.id, alias });
              break; // 每个节点只保留一条证据（首个命中别名/名称）
            }
          }
        }
        hits.sort((a, b) => compareIds(a.domainId, b.domainId));
        matches = hits.slice(0, DISCIPLINE_ALIAS_SCAN_MAX_MATCHES).map((hit) => ({
          domainId: hit.domainId,
          confidence: 0.6,
          evidence: [`text:${hit.alias}`],
        }));
      }

      const binding: DomainBinding = {
        matches,
        ...(matches.length > 0 ? { primaryDomain: matches[0]!.domainId } : {}),
        catalogVersion: catalog.version,
        resolverVersion: DISCIPLINE_RESOLVER_VERSION,
      };

      // 规则 4：输出必须通过结构校验（未知 id / 重复 / 越界 confidence 都会 fail-closed）。
      const check = validateDomainBinding(binding, catalog.ids());
      if (!check.ok) {
        return { ok: false, error: `discipline resolver: ${check.error}` };
      }
      return { ok: true, binding };
    },
  };
}
