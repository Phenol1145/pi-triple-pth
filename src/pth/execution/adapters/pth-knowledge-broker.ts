/**
 * execution/adapters/pth-knowledge-broker.ts — KnowledgeBroker 的 PTH 数据世界适配器
 * （模块化 v2 P2-5）。
 *
 * 把 kernel dataWorld（memory + queryReadOnly）与 pth-memory 可见性判定装进 broker；
 * 本文件不暴露 dataWorld 给调用方。
 */

import { isVisible } from "@away_from/pth-memory";
import type { DataWorldAccess } from "../../kernel/storage/index.js";
import type { ExecutionGrantService } from "../authorization/execution-grant-service.js";
import { createKnowledgeBroker, type KnowledgeBroker } from "../knowledge-broker.js";

export interface PthKnowledgeBrokerDeps {
  grantService: ExecutionGrantService;
  dataWorld: DataWorldAccess;
}

export function createPthKnowledgeBroker(deps: PthKnowledgeBrokerDeps): KnowledgeBroker {
  return createKnowledgeBroker({
    grantService: deps.grantService,
    dataWorld: {
      queryReadOnly: (sql) => deps.dataWorld.queryReadOnly(sql),
      memory: deps.dataWorld.memory,
    },
    isVisible: (meta, space) => isVisible(meta, space),
  });
}
