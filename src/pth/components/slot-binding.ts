/**
 * components/slot-binding.ts — targetSlot 空位绑定（F/WP4 Task 18）
 *
 * 生效语义（spec §5.2 + 骨架 §4.2）：**部署=登记**——O(1) 登记校验（字段良构即可，
 * 不做深度语义校验；信任链暂缓期间无前置验证，仅登记+审计）。
 *
 * WP5 前交付降级版：
 *   - scheduler/optimizer → 框架层 registry 接线依赖 Task 23/24（常驻系统会话代理调用），
 *     WP5 前仅绑定登记+审计，registry 接线子项并入 Task 28
 *   - agent-program → 可装配常驻标记（绑定记录即可，无额外 registry）
 *
 * Redis key：`slot:<slotId>:binding`（JSON 记录）
 * 读取 API：SlotBindingStore.get/list 供后续 Task 21 observe 使用。
 */

import type { Redis } from "ioredis";
import type { ComponentType } from "./types.js";
import type { Result } from "../programs/types.js";

/** 空位绑定记录（slot 查询/审计追溯用） */
export interface SlotBinding {
  slotId: string;
  type: ComponentType;
  name: string;
  version: number;
  tenantId: string;
  boundAt: string; // ISO 时间戳
  legalAuth?: string; // 声明式授权引用（§5.3，F/WP4 Task 19）
}

/**
 * O(1) 良构校验：非空字符串、长度上限、无控制字符。
 * 不做深度语义校验（不查 slot 是否存在/构件是否兼容——语义求值推迟到信任链实例化后）。
 */
export function validateSlotId(slotId: unknown): string | null {
  if (typeof slotId !== "string" || slotId.length === 0) {
    return "must be a non-empty string";
  }
  if (slotId.length > 128) {
    return "must be at most 128 chars";
  }
  if (/[\u0000-\u001f]/.test(slotId)) {
    return "must not contain control characters";
  }
  return null;
}

export class SlotBindingStore {
  constructor(private redis: Redis) {}

  key(slotId: string): string {
    return `slot:${slotId}:binding`;
  }

  /** 登记绑定：写入 slot:<slotId>:binding（同 slot 二次绑定=覆盖，latest wins）。 */
  async bind(
    tenantId: string,
    slotId: string,
    type: ComponentType,
    name: string,
    version: number,
    legalAuth?: string,
  ): Promise<Result<SlotBinding>> {
    const err = validateSlotId(slotId);
    if (err) return { ok: false, error: `invalid targetSlot: ${err}` };
    const binding: SlotBinding = {
      slotId,
      type,
      name,
      version,
      tenantId,
      boundAt: new Date().toISOString(),
      ...(legalAuth !== undefined ? { legalAuth } : {}),
    };
    await this.redis.set(this.key(slotId), JSON.stringify(binding));
    return { ok: true, value: binding };
  }

  /** 读取 slot 绑定（Task 21 observe 用）。 */
  async get(slotId: string): Promise<Result<SlotBinding>> {
    const raw = await this.redis.get(this.key(slotId));
    if (!raw) return { ok: false, error: `no binding for slot "${slotId}"` };
    return { ok: true, value: JSON.parse(raw) as SlotBinding };
  }
}
