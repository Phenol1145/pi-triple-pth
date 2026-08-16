/**
 * catalog/space-lookup.ts — catalog 注入的空间查询策略（模块化 v2 P3-2）。
 *
 * 只读 RuntimeCatalogSnapshot；供 role-router/worker-cluster 与 asp 装配面使用。
 */

import type { CatalogSpace, RuntimeCatalogSnapshot } from "./runtime-catalog.js";

export interface SpaceLookup {
  get(id: string): CatalogSpace | undefined;
  childrenOf(id: string): CatalogSpace[];
  depthOf(id: string): number;
  ids(): string[];
}

export function createSpaceLookup(snapshot: RuntimeCatalogSnapshot): SpaceLookup {
  const spaces = snapshot.spaces();
  return {
    get(id) {
      return spaces.find((s) => s.id === id);
    },
    childrenOf(id) {
      return spaces.filter((s) => s.parent === id);
    },
    depthOf(id) {
      const seen = new Set<string>();
      let depth = 0;
      let cur = spaces.find((s) => s.id === id);
      while (cur?.parent && !seen.has(cur.parent)) {
        const parent = cur.parent;
        seen.add(parent);
        depth += 1;
        cur = spaces.find((s) => s.id === parent);
      }
      return depth;
    },
    ids() {
      return spaces.map((s) => s.id);
    },
  };
}
