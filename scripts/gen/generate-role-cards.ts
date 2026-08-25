#!/usr/bin/env tsx
/**
 * scripts/gen/generate-role-cards.ts —— Role Catalog W1：从当前内置角色 bundle 生成等价 JSON 卡片。
 *
 * 生成的卡片与现行 RoleDefinition 零行为变化（loader 投影回同一结构）。
 * 输出：src/pth/catalog/data/roles/<id 冒号转连字符>.json
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_ROLES, MID_ROLES, GOVERNANCE_ROLES } from "@away_from/pth-kernel-execution";
import { PROFESSIONAL_ROLES } from "@away_from/pth-kernel-execution";
import type { RoleDefinition } from "@away_from/pth-kernel-execution";
import type { RoleCardV1 } from "../../src/pth/catalog/role-definition-v1.js";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "../../src/pth/catalog/data/roles");

function toCard(r: RoleDefinition): RoleCardV1 {
  return {
    id: r.id,
    version: 1,
    identity: {
      tags: r.tags,
      prompt: r.prompt,
      ...(r.description ? { description: r.description } : {}),
      ...(r.parent ? { parent: r.parent } : {}),
      ...(r.differentiation ? { differentiation: r.differentiation } : {}),
    },
    capabilities: {
      functions: r.capabilities ?? [],
      actionTools: r.actionTools ?? [],
    },
    resources: {
      ...(r.thinking ? { thinking: r.thinking } : {}),
      ...(r.model ? { model: r.model } : {}),
    },
    modules: {
      ...(r.memoryScope || r.produces || r.defaultReads
        ? {
            memory: {
              ...(r.memoryScope ? { scope: r.memoryScope } : {}),
              ...(r.produces ? { produces: [...r.produces] } : {}),
              ...(r.defaultReads ? { defaultReads: r.defaultReads } : {}),
            },
          }
        : {}),
    },
  };
}

const all = [...DEFAULT_ROLES, ...MID_ROLES, ...GOVERNANCE_ROLES, ...PROFESSIONAL_ROLES];
mkdirSync(outDir, { recursive: true });
for (const r of all) {
  const card = toCard(r);
  const file = join(outDir, `${r.id.replace(/:/g, "-")}.json`);
  writeFileSync(file, `${JSON.stringify(card, null, 2)}\n`, "utf-8");
}
console.log(`role cards generated: ${all.length} → ${outDir}`);
