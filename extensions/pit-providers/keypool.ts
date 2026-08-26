/**
 * pit-providers — KeyPool 纯逻辑
 *
 * 从 ustc-llm/types.ts 提取，语义不变。
 * 无副作用，不依赖 Node.js 内置模块。
 */
import type { KeyEntry, KeyPool } from "./types.js";

/** 空池 */
export function makeKeyPool(): KeyPool {
  return { keys: [], activeId: "" };
}

/** 8-char unique id */
export function generateId(): string {
  return crypto.randomUUID().slice(0, 8);
}

/**
 * 返回 activeId 指向的 KeyEntry。
 * activeId 不在池中或池为空 → undefined。
 */
export function getActiveKey(pool: KeyPool): KeyEntry | undefined {
  return pool.keys.find((k) => k.id === pool.activeId);
}

/**
 * 返回下一个可用 Key：
 *   active 存在且未失败 → active
 *   否则 → 第一个未失败的 Key
 *   全部失败或空池 → undefined
 *
 * 注意：不修改 pool。state 变更由上层（failover/manager）负责。
 */
export function getNextAvailableKey(pool: KeyPool): KeyEntry | undefined {
  const active = getActiveKey(pool);
  if (active && !active.failed) return active;

  return pool.keys.find((k) => !k.failed);
}
