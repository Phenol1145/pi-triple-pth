/**
 * role-definition-v1.ts —— Role Catalog W0：四元组角色卡 schema + 装载校验骨架。
 *
 * 第一期只做「校验 + 投影」：卡片 → 现行 RoleDefinition（运行时不感知卡片结构）。
 * generation 由 parent 链派生（装载器后续计算），revision = 内容哈希（后续）。
 */

import type { RoleDefinition } from "@away_from/pth-kernel-execution";
import { ROLE_CAPABILITY_VOCABULARY, ROLE_ACTION_TOOL_VOCABULARY } from "./role-vocabulary.js";

export interface RoleCardV1 {
  id: string;
  version: number;
  identity: {
    tags: string[];
    prompt: string;
    description?: string;
    parent?: string;
    differentiation?: string;
  };
  capabilities: {
    functions: string[];
    actionTools: string[];
  };
  resources: {
    thinking?: "high" | "medium" | "low";
    model?: string | null;
  };
  modules: {
    memory?: {
      scope?: "own" | "all";
      produces?: string[];
      defaultReads?: string[];
    };
  };
}

export type RoleCardV1Result =
  | { ok: true; role: RoleDefinition }
  | { ok: false; errors: string[] };

export function validateRoleCardV1(card: RoleCardV1): RoleCardV1Result {
  const errors: string[] = [];
  if (!card.id || typeof card.id !== "string") errors.push("id 必填");
  if (!Number.isInteger(card.version) || card.version < 1) errors.push("version 必须为正整数");
  if (!Array.isArray(card.identity?.tags) || card.identity.tags.length === 0) errors.push("identity.tags 必填非空数组");
  if (typeof card.identity?.prompt !== "string" || card.identity.prompt.trim() === "") errors.push("identity.prompt 必填非空");
  if (!Array.isArray(card.capabilities?.functions)) errors.push("capabilities.functions 必填数组");
  if (!Array.isArray(card.capabilities?.actionTools)) errors.push("capabilities.actionTools 必填数组");

  if (errors.length > 0) return { ok: false, errors };

  const unknownFuncs = card.capabilities.functions.filter((c) => !ROLE_CAPABILITY_VOCABULARY.has(c));
  if (unknownFuncs.length > 0) errors.push(`capabilities.functions 含未登记词汇: ${unknownFuncs.join(", ")}`);
  const unknownTools = card.capabilities.actionTools.filter((t) => !ROLE_ACTION_TOOL_VOCABULARY.has(t));
  if (unknownTools.length > 0) errors.push(`capabilities.actionTools 含未登记词汇: ${unknownTools.join(", ")}`);

  if (card.modules?.memory?.scope && !["own", "all"].includes(card.modules.memory.scope)) {
    errors.push("modules.memory.scope 仅支持 own/all");
  }
  if (card.resources?.thinking && !["high", "medium", "low"].includes(card.resources.thinking)) {
    errors.push("resources.thinking 仅支持 high/medium/low");
  }

  if (errors.length > 0) return { ok: false, errors };

  const role: RoleDefinition = {
    id: card.id,
    tags: card.identity.tags,
    prompt: card.identity.prompt,
    capabilities: card.capabilities.functions,
    actionTools: card.capabilities.actionTools,
    ...(card.identity.description ? { description: card.identity.description } : {}),
    ...(card.identity.parent ? { parent: card.identity.parent } : {}),
    ...(card.identity.differentiation ? { differentiation: card.identity.differentiation } : {}),
    ...(card.resources.thinking ? { thinking: card.resources.thinking } : {}),
    ...(card.resources.model ? { model: card.resources.model } : {}),
    ...(card.modules.memory?.scope ? { memoryScope: card.modules.memory.scope } : {}),
    ...(card.modules.memory?.produces ? { produces: card.modules.memory.produces } : {}),
    ...(card.modules.memory?.defaultReads ? { defaultReads: card.modules.memory.defaultReads } : {}),
  };

  return { ok: true, role };
}
