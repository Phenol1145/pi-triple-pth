/**
 * pit-providers — failover.ts
 *
 * 注册 after_provider_response hook：
 *   仅 401/403 触发 Key 切换（429/5xx/超时不动）。
 *   active 标记 failed → 切到下一个未失败 Key → savePool。
 *
 * 与 ustc-llm index.ts:1120-1162 语义对齐（schema 版本口径见跨仓 contract）：
 *   - 早退: !pool.activeId || pool.keys.length === 0
 *   - getActiveKey + getNextAvailableKey（从 keypool.ts 导入）
 *   - ctx.hasUI 守卫（headless 不崩）
 *   - warn/error 分级（有 next → warn，全灭 → error）
 */
import { getActiveKey, getNextAvailableKey } from "./keypool.js";

interface ManagerLike {
  alias: string;
  providerId: string;
  name: string;
  loadPool(): import("./types.js").KeyPool;
  savePool(pool: import("./types.js").KeyPool): void;
}

interface PiLike {
  on(event: "after_provider_response", handler: (event: any, ctx: any) => void): void;
}

export function registerFailover(
  pi: PiLike,
  managers: Map<string, ManagerLike>,
): void {
  pi.on("after_provider_response", (event, ctx) => {
    // 仅 401/403
    if (event.status !== 401 && event.status !== 403) return;

    // 匹配 provider
    const providerId = ctx.model?.provider;
    if (!providerId) return;
    const manager = managers.get(providerId);
    if (!manager) return;

    const pool = manager.loadPool();
    if (!pool.activeId || pool.keys.length === 0) return;

    const active = getActiveKey(pool);
    if (!active) return;

    active.failed = true;

    const next = getNextAvailableKey(pool);
    if (next) pool.activeId = next.id;

    manager.savePool(pool);

    if (!ctx.hasUI) return;

    if (next) {
      ctx.ui.notify(
        `${manager.name} Key "${active.alias}" 认证失败(${event.status})，已切换到 "${next.alias}"`,
        "warn",
      );
    } else {
      ctx.ui.notify(
        `${manager.name} Key "${active.alias}" 认证失败，无可用 Key——/keys ${manager.alias} 处理`,
        "error",
      );
    }
  });
}
