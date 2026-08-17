/**
 * catalog/discipline-catalog.ts — 学科目录契约与结构（K0 Phase 0 设计纠偏，
 * n18-v12-phase0-1a-design §1.2）。
 *
 * 只放契约与结构：校验、无环构建、确定排序、稳定 version 指纹与快照导航。
 * 不 import 百科/知识正文/数据库。
 *
 * 语义约定（本 lane 契约）：
 *  - ancestors(id) 含自身，按深度稳定序（同深度按 id 字典序）；
 *  - descendants(id) 不含自身，按深度稳定序（同深度按 id 字典序）；
 *  - resolveAlias(aliasOrId) 先 id 后 aliases；未知与歧义一律 fail-closed。
 */

import {
  validateDomainDefinition,
  type DomainDefinition,
  type DomainId,
} from "../contracts/domains.js";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** FNV-1a 32-bit → 8 位 hex 指纹。 */
function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function computeVersion(defs: readonly DomainDefinition[]): string {
  const records = defs.map((d) => `${d.id}:${d.level}:${d.parents.join(">")}:${d.names["zh-CN"] ?? ""}`);
  records.sort();
  return fnv1aHex(records.join("\n"));
}

export class DisciplineCatalogBuilder {
  private sealed = false;
  private readonly defs = new Map<DomainId, DomainDefinition>();

  private assertMutable(): void {
    if (this.sealed) throw new Error("discipline catalog builder sealed after build()");
  }

  add(d: DomainDefinition): this {
    this.assertMutable();
    const check = validateDomainDefinition(d);
    if (!check.ok) throw new Error(check.error);
    if (this.defs.has(d.id)) throw new Error(`discipline catalog: duplicate id ${d.id}`);
    this.defs.set(d.id, {
      ...d,
      names: { ...d.names },
      aliases: [...d.aliases],
      parents: [...d.parents].sort(),
      methodAnchors: [...d.methodAnchors],
      sourceRegistryIds: [...d.sourceRegistryIds],
      toolAnchors: [...d.toolAnchors],
    });
    return this;
  }

  build(): DisciplineCatalogSnapshot {
    this.assertMutable();

    const missingByChild = new Map<DomainId, DomainId[]>();
    for (const d of this.defs.values()) {
      for (const parent of d.parents) {
        if (!this.defs.has(parent)) {
          const list = missingByChild.get(d.id) ?? [];
          list.push(parent);
          missingByChild.set(d.id, list);
        }
      }
    }
    if (missingByChild.size > 0) {
      const details = [...missingByChild.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([child, parents]) => `${child} -> ${[...parents].sort().join(", ")}`)
        .join("; ");
      throw new Error(`discipline catalog: missing parent(s): ${details}`);
    }

    // Kahn 入度校验：多父 DAG 无环；环上节点名进错误信息。
    const ids = [...this.defs.keys()];
    const childrenByParent = new Map<DomainId, Set<DomainId>>();
    const indegree = new Map<DomainId, number>();
    for (const id of ids) {
      indegree.set(id, 0);
      childrenByParent.set(id, new Set());
    }
    for (const d of this.defs.values()) {
      indegree.set(d.id, d.parents.length);
      for (const parent of d.parents) {
        childrenByParent.get(parent)?.add(d.id);
      }
    }
    const queue = ids.filter((id) => (indegree.get(id) ?? 0) === 0).sort();
    let visited = 0;
    while (queue.length > 0) {
      const id = queue.shift()!;
      visited += 1;
      for (const child of childrenByParent.get(id) ?? []) {
        const next = (indegree.get(child) ?? 0) - 1;
        indegree.set(child, next);
        if (next === 0) queue.push(child);
      }
      queue.sort();
    }
    const cycleNodes = ids.filter((id) => (indegree.get(id) ?? 0) > 0).sort();
    if (cycleNodes.length > 0) {
      throw new Error(`discipline catalog: cycle detected on nodes: ${cycleNodes.join(", ")}`);
    }

    const sorted = [...this.defs.values()].sort((a, b) => a.id.localeCompare(b.id));
    const version = computeVersion(sorted);
    this.sealed = true;
    return new DisciplineCatalogSnapshot(sorted, version);
  }
}

export interface DisciplineCounts {
  category: number;
  discipline: number;
  subDiscipline: number;
  total: number;
}

export class DisciplineCatalogSnapshot {
  readonly version: string;
  readonly #defs: readonly DomainDefinition[];
  readonly #byId: ReadonlyMap<DomainId, DomainDefinition>;
  readonly #childrenByParent: ReadonlyMap<DomainId, readonly DomainId[]>;

  constructor(defs: readonly DomainDefinition[], version: string) {
    this.version = version;
    this.#defs = Object.freeze(
      defs.map((d) =>
        Object.freeze({
          ...d,
          names: Object.freeze({ ...d.names }),
          aliases: Object.freeze([...d.aliases]),
          parents: Object.freeze([...d.parents]),
          methodAnchors: Object.freeze([...d.methodAnchors]),
          sourceRegistryIds: Object.freeze([...d.sourceRegistryIds]),
          toolAnchors: Object.freeze([...d.toolAnchors]),
        }),
      ),
    ) as unknown as readonly DomainDefinition[];
    this.#byId = new Map(this.#defs.map((d) => [d.id, d]));

    const children = new Map<DomainId, Set<DomainId>>();
    for (const d of this.#defs) {
      for (const parent of d.parents) {
        const set = children.get(parent) ?? new Set<DomainId>();
        set.add(d.id);
        children.set(parent, set);
      }
    }
    const sortedChildren = new Map<DomainId, readonly DomainId[]>();
    for (const [parent, set] of children) {
      sortedChildren.set(parent, Object.freeze([...set].sort()));
    }
    this.#childrenByParent = sortedChildren;
  }

  get(id: DomainId): DomainDefinition | undefined {
    const d = this.#byId.get(id);
    return d ? clone(d) : undefined;
  }

  list(): DomainDefinition[] {
    return clone([...this.#defs]);
  }

  ancestors(id: DomainId): DomainId[] {
    this.#assertKnown(id);
    const out: DomainId[] = [id];
    const seen = new Set<DomainId>([id]);
    let frontier: DomainId[] = [id];
    while (frontier.length > 0) {
      const next: DomainId[] = [];
      for (const current of frontier) {
        for (const parent of this.#byId.get(current)?.parents ?? []) {
          if (!seen.has(parent)) {
            seen.add(parent);
            next.push(parent);
          }
        }
      }
      next.sort();
      out.push(...next);
      frontier = next;
    }
    return out;
  }

  descendants(id: DomainId): DomainId[] {
    this.#assertKnown(id);
    const out: DomainId[] = [];
    const seen = new Set<DomainId>([id]);
    let frontier: DomainId[] = [id];
    while (frontier.length > 0) {
      const next: DomainId[] = [];
      for (const current of frontier) {
        for (const child of this.#childrenByParent.get(current) ?? []) {
          if (!seen.has(child)) {
            seen.add(child);
            next.push(child);
          }
        }
      }
      next.sort();
      out.push(...next);
      frontier = next;
    }
    return out;
  }

  resolveAlias(aliasOrId: DomainId): DomainDefinition {
    const byId = this.#byId.get(aliasOrId);
    if (byId) return clone(byId);

    const hits = this.#defs.filter((d) => d.aliases.includes(aliasOrId));
    if (hits.length === 0) {
      throw new Error(`discipline catalog: unknown domain id or alias: ${aliasOrId}`);
    }
    if (hits.length > 1) {
      throw new Error(`discipline catalog: ambiguous alias ${aliasOrId}: ${hits.map((h) => h.id).sort().join(", ")}`);
    }
    return clone(hits[0]!);
  }

  counts(): DisciplineCounts {
    const counts = { category: 0, discipline: 0, subDiscipline: 0, total: this.#defs.length };
    for (const d of this.#defs) {
      if (d.level === "category") counts.category += 1;
      else if (d.level === "discipline") counts.discipline += 1;
      else counts.subDiscipline += 1;
    }
    return counts;
  }

  #assertKnown(id: DomainId): void {
    if (!this.#byId.has(id)) {
      throw new Error(`discipline catalog: unknown domain id: ${id}`);
    }
  }
}
