/**
 * catalog/adapters/builtin-catalog-contributions.ts — 内置 manifest（模块化 v2 P3-2）。
 *
 * 把 impls 层的内置角色/空间数据折叠为同一 RuntimeCatalogSnapshot：
 * assembly 与 batch-process 用同一个 manifest 构建等价 catalog。
 */

import { CatalogBuilder } from "../catalog-builder.js";
import type { RuntimeCatalogSnapshot } from "../runtime-catalog.js";
import { ORIGIN_ROLE, DEFAULT_ROLES, MID_ROLES, GOVERNANCE_ROLES } from "../../impls/roles/default-roles.js";
import { BUILTIN_SPACE_DEFS } from "../../impls/spaces/builtin-spaces.js";

export function buildBuiltinCatalog(): RuntimeCatalogSnapshot {
  const builder = new CatalogBuilder();
  const roles = [ORIGIN_ROLE, ...DEFAULT_ROLES, ...MID_ROLES, ...GOVERNANCE_ROLES];
  for (const role of roles) {
    builder.addRole({
      id: role.id,
      parent: role.parent ?? null,
      generation: role.generation,
      tags: role.tags,
      prompt: role.prompt,
      description: role.description,
      capabilities: role.capabilities,
      thinking: role.thinking,
      acceptanceRole: role.acceptanceRole,
      output: role.output,
    });
  }
  for (const space of BUILTIN_SPACE_DEFS) {
    builder.addSpace({
      id: space.id,
      parent: space.parent ?? null,
      kind: space.kind,
      execTool: space.execTool ?? "",
      description: space.description,
      memoryScope: space.memoryScope,
      bindRoles: space.bindRoles,
      allowChildren: space.allowChildren,
      maxDepth: space.maxDepth,
    });
  }
  builder.setCapabilityPolicy({
    allow: ["memory.read", "memory.write", "memory.query", "llm.complete", "web.fetchText", "fs.readText", "fs.readSource", "fs.list", "fs.task", "python.execute", "bash.execute", "c.build", "c.run", "dev.build", "dev.run", "write.create", "write.edit", "readSource", "readText", "state.recallFunctions", "state.recallInsights", "skills.list", "skills.get", "ext.use", "cache.get", "cache.load"],
    deny: [],
  });
  return builder.build();
}
