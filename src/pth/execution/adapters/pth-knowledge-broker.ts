/**
 * execution/adapters/pth-knowledge-broker.ts — KnowledgeBroker 的 PTH 数据世界适配器
 * （模块化 v2 P2-5）。
 *
 * 把 kernel dataWorld（memory + queryReadOnly）与 pth-memory 可见性判定装进 broker；
 * 本文件不暴露 dataWorld 给调用方。
 */

import { isVisible } from "@away_from/pth-memory";
import type { DataWorldAccess } from "@away_from/pth-kernel-storage";
import type { ExecutionGrantService } from "../authorization/execution-grant-service.js";
import { createKnowledgeBroker, searchKnowledgeEntries, type KnowledgeBroker } from "../knowledge-broker.js";

export interface PthKnowledgeBrokerDeps {
  grantService: ExecutionGrantService;
  dataWorld: DataWorldAccess;
}

export function createPthKnowledgeBroker(deps: PthKnowledgeBrokerDeps): KnowledgeBroker {
  return createKnowledgeBroker({
    grantService: deps.grantService,
    dataWorld: {
      queryReadOnly: (sql) => deps.dataWorld.queryReadOnly(sql),
      memory: {
        retrieve: (opts) => deps.dataWorld.memory.retrieve(opts),
        get: (id, opts) => deps.dataWorld.memory.get(id, opts),
        // K3 search：注入 retrieve + queryText 过滤的单一实现（searchKnowledgeEntries），
        // 空间可见性仍由 broker 统一收口。
        search: (opts) => searchKnowledgeEntries(deps.dataWorld.memory, opts),
      },
    },
    isVisible: (meta, space) => isVisible(meta, space),
    // K1a hit 计数最小接线：get 命中（全文 consumption）→ bumpHitCount；retrieve 列表 exposure 不计数。
    recordConsumption: (id, tenantId) => deps.dataWorld.memory.bumpHitCount(id, { tenantId }),
  });
}
