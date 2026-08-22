/**
 * programs/store.ts — ProgramStore 兼容门面（agent-program 专用）
 *
 * F/WP4 Task 17：存储逻辑已泛化为 ComponentStore（components/store.ts，components 卷
 * `<tenantId>/<type>/<name>/<version>/`，Redis 原子 INCR/GC 沿用）。ProgramStore 保留为
 * agent-program 兼容别名：方法签名不变（老调用方与既有测试零改动），内部固定
 * type="agent-program" 转发 ComponentStore；agent-program 读侧双查 legacy programs 路径
 * （DATA_DIR/programs/programs/...，v1 直接切换、不做自动迁移——plan N4）。
 *
 * 落盘目录：DATA_DIR/components/<tenantId>/agent-program/<name>/<version>/（由 main 传入
 * 基础 DATA_DIR，本门面不再拼接 "programs"）。
 */

import type { Redis } from "ioredis";
import { ComponentStore } from "../components/index.js";
import type { AuditWriter } from "../observability/index.js";
import type { ProgramManifest, ProgramInfo, ProgramVersion, Result } from "./types.js";

/**
 * ProgramStore 兼容门面：ComponentStore 的 agent-program 视图。
 * 方法签名与旧版一致（list/get/delete/materialize 的 type 参数缺省=agent-program；
 * save 的 type 取自 manifest，缺省=agent-program），老调用方与既有测试零改动。
 * 不做覆写——泛化方法本身已兼容（避免子类覆写篡改基类内部调用）。
 */
export class ProgramStore extends ComponentStore {
  constructor(redis: Redis, dataDir: string, audit?: AuditWriter) {
    super(redis, dataDir, audit);
  }
}

export type { ProgramManifest, ProgramInfo, ProgramVersion, Result };
