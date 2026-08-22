/**
 * contracts/domains.ts — 学科目录契约（K0 Phase 0 设计纠偏，n18-v12-phase0-1a-design §1.1）。
 *
 * 纯类型 + 结构校验；本目录不 import fastify / pg / redis / 运行时实现。
 * DomainDefinition 描述目录中的静态节点；DomainBinding 描述一次任务与学科节点的
 * 解析结果（matches 可为空——识别失败不伪造领域，由调用方决定降级路由）。
 */

export type DomainId = string;
export type DomainLevel = "category" | "discipline" | "sub-discipline";

/** 小写 id 风格：首字符小写字母/数字，后续可带连字符，总长 1–64。 */
export const DOMAIN_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const DOMAIN_LEVELS: readonly DomainLevel[] = ["category", "discipline", "sub-discipline"];

export interface DomainDefinition {
  id: DomainId;
  /** 多语言名称；至少含 zh-CN；en 可为 id 派生的回退 */
  names: Record<string, string>;
  aliases: string[];
  /** 允许多父；目录整体必须无环 */
  parents: DomainId[];
  level: DomainLevel;
  description: string;
  methodAnchors: string[];
  sourceRegistryIds: string[];
  toolAnchors: string[];
}

export interface DomainMatch {
  domainId: DomainId;
  confidence: number;
  evidence: string[];
}

/**
 * 目录快照的最小结构契约（供 runner/execution 等跨模块消费方使用，避免反向依赖 catalog）。
 * DisciplineCatalogSnapshot 在结构上满足本接口。
 */
export interface DisciplineCatalogLike {
  readonly version: string;
  ancestors(id: DomainId): DomainId[];
}

export interface DomainBinding {
  /** 可为空数组：识别失败保留空绑定，不伪造领域 */
  matches: Array<DomainMatch>;
  primaryDomain?: DomainId;
  catalogVersion: string;
  resolverVersion: string;
}

export type DomainDefinitionValidation = { ok: true } | { ok: false; error: string };
export type DomainBindingValidation = { ok: true } | { ok: false; error: string };

const NON_EMPTY_STRING = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

export function validateDomainDefinition(d: DomainDefinition): DomainDefinitionValidation {
  if (typeof d !== "object" || d === null) return { ok: false, error: "domain definition: object required" };
  const def = d as unknown as Record<string, unknown>;

  if (typeof def.id !== "string" || !DOMAIN_ID_RE.test(def.id)) {
    return { ok: false, error: `domain definition: invalid id ${JSON.stringify(def.id)}` };
  }
  const id = def.id;

  if (typeof def.level !== "string" || !DOMAIN_LEVELS.includes(def.level as DomainLevel)) {
    return { ok: false, error: `domain ${id}: invalid level ${JSON.stringify(def.level)}` };
  }

  if (typeof def.names !== "object" || def.names === null || Array.isArray(def.names)) {
    return { ok: false, error: `domain ${id}: names must be an object` };
  }
  const names = def.names as Record<string, unknown>;
  const nameValues = Object.values(names);
  if (nameValues.some((v) => typeof v !== "string")) {
    return { ok: false, error: `domain ${id}: names values must be strings` };
  }
  if (!nameValues.some((v) => NON_EMPTY_STRING(v))) {
    return { ok: false, error: `domain ${id}: names must contain at least one non-empty value` };
  }

  if (!NON_EMPTY_STRING(def.description)) {
    return { ok: false, error: `domain ${id}: description required` };
  }

  for (const key of ["aliases", "methodAnchors", "sourceRegistryIds", "toolAnchors"] as const) {
    if (!isStringArray(def[key])) {
      return { ok: false, error: `domain ${id}: ${key} must be a string array` };
    }
  }

  if (!isStringArray(def.parents)) {
    return { ok: false, error: `domain ${id}: parents must be a string array` };
  }
  const parents = def.parents as string[];
  if (parents.some((p) => !DOMAIN_ID_RE.test(p))) {
    return { ok: false, error: `domain ${id}: parents contain invalid id ${JSON.stringify(parents.find((p) => !DOMAIN_ID_RE.test(p)))}` };
  }
  if (new Set(parents).size !== parents.length) {
    return { ok: false, error: `domain ${id}: parents must not contain duplicates` };
  }

  return { ok: true };
}

export function validateDomainBinding(b: DomainBinding, knownIds: ReadonlySet<DomainId>): DomainBindingValidation {
  if (typeof b !== "object" || b === null) return { ok: false, error: "domain binding: object required" };
  const binding = b as unknown as Record<string, unknown>;

  if (!NON_EMPTY_STRING(binding.catalogVersion)) {
    return { ok: false, error: "domain binding: catalogVersion required" };
  }
  if (!NON_EMPTY_STRING(binding.resolverVersion)) {
    return { ok: false, error: "domain binding: resolverVersion required" };
  }

  if (!Array.isArray(binding.matches)) {
    return { ok: false, error: "domain binding: matches must be an array（可为空）" };
  }
  const seen = new Set<string>();
  for (const [index, m] of (binding.matches as unknown[]).entries()) {
    if (typeof m !== "object" || m === null) {
      return { ok: false, error: `domain binding: matches[${index}] must be an object` };
    }
    const match = m as Record<string, unknown>;
    if (typeof match.domainId !== "string" || !knownIds.has(match.domainId)) {
      return { ok: false, error: `domain binding: matches[${index}].domainId not in known ids: ${JSON.stringify(match.domainId)}` };
    }
    const domainId = match.domainId;
    if (seen.has(domainId)) {
      return { ok: false, error: `domain binding: duplicate domainId in matches: ${domainId}` };
    }
    seen.add(domainId);

    if (typeof match.confidence !== "number" || !Number.isFinite(match.confidence) || match.confidence < 0 || match.confidence > 1) {
      return { ok: false, error: `domain binding: matches[${index}].confidence must be within [0,1]` };
    }
    if (!isStringArray(match.evidence)) {
      return { ok: false, error: `domain binding: matches[${index}].evidence must be a string array` };
    }
  }

  if (binding.primaryDomain !== undefined) {
    if (typeof binding.primaryDomain !== "string" || !seen.has(binding.primaryDomain)) {
      return { ok: false, error: "domain binding: primaryDomain must be in matches" };
    }
  }

  return { ok: true };
}
