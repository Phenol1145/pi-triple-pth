/**
 * pit-providers/registration.ts —— provider 注册选项构建 + login + refreshModels。
 * （模块专项 ② 大文件拆分：自 index.ts 抽出）
 */
import { getNextAvailableKey, generateId } from "./keypool.js";
import { inferModel } from "./infer.js";
import type { ProviderDef, KeyPool, ModelDef } from "./types.js";
import type { ProviderManager } from "./manager.js";

const FAR_FUTURE = 9999999999999;

/**
 * 创建单 Key provider 的 registerProvider options（无 oauth）。
 */
function simpleProviderOpts(def: ProviderDef) {
  return {
    name: def.name,
    baseUrl: def.baseUrl,
    api: def.api as any,
    apiKey: def.apiKeyEnv ? `$${def.apiKeyEnv}` : undefined,
    compat: def.compat,
    models: def.models.map((m) => ({ ...m })),
  };
}

/**
 * 创建多 Key provider 的 registerProvider options（含 oauth + refreshModels）。
 *
 * manager 持有此 provider 的 KeyPool 生命周期。
 */
function multiKeyProviderOpts(def: ProviderDef, manager: ProviderManager) {
  const opts: Record<string, unknown> = {
    name: def.name,
    baseUrl: def.baseUrl,
    api: def.api as any,
    compat: def.compat,
    models: def.models.map((m) => ({ ...m })),
  };

  // 空池兜底：env 变量
  if (def.apiKeyEnv) {
    opts.apiKey = `$${def.apiKeyEnv}`;
  }

  // oauth 回调：/login 交互 + failover 钩子的持久化后端
  opts.oauth = {
    name: `${def.name}（多 Key 管理 + 自动 Failover）`,
    login: async (cb: any) => {
      return loginProvider(cb, manager);
    },
    refreshToken: async (_cred: any) => {
      // FAR_FUTURE → pi 永不调用；保留为防御性回调
      const pool = manager.loadPool();
      const key = getNextAvailableKey(pool);
      return {
        refresh: JSON.stringify(pool),
        access: key?.key ?? "",
        expires: FAR_FUTURE,
      };
    },
    getApiKey: (_cred: any) => {
      return manager.getApiKey();
    },
  };

  // 动态模型列表（refreshModels = true）
  if (def.refreshModels) {
    opts.refreshModels = async (ctx: any) => {
      return refreshModels(ctx, manager, def);
    };
  }

  return opts;
}

// ─── /login 交互 ─────────────────────────────────────────────

async function loginProvider(
  callbacks: { input: (prompt: string) => Promise<string>; ui: { select: (title: string, items: string[]) => Promise<string | undefined>; notify: (text: string, level?: string) => void } },
  manager: ProviderManager,
): Promise<{ refresh: string; access: string; expires: number }> {
  let pool = manager.loadPool();

  // 尝试从 auth.json 旧格式迁移未入池的 Key
  if (pool.keys.length === 0) {
    const ap = manager.authPath();
    if (ap && fs.existsSync(ap)) {
      try {
        const raw = JSON.parse(fs.readFileSync(ap, "utf-8"));
        const cred = raw[manager.id];
        if (cred?.refresh) {
          pool = JSON.parse(cred.refresh) as KeyPool;
        } else if (cred?.access && cred.access.length > 10) {
          pool.keys.push({ id: generateId(), alias: "默认", key: cred.access, failed: false });
          pool.activeId = pool.keys[0].id;
        } else if (cred?.key && cred.key.length > 10) {
          pool.keys.push({ id: generateId(), alias: "默认", key: cred.key, failed: false });
          pool.activeId = pool.keys[0].id;
        }
      } catch { /* ignore */ }
    }
  }

  while (true) {
    // 构造菜单
    const items: string[] = [];
    if (pool.keys.length > 0) {
      items.push("⇄ 切换 Active Key");
    }
    items.push("🔑 添加新 Key");
    if (pool.keys.length > 0) {
      items.push("🗑 删除 Key");
    }
    items.push("✓ 完成");

    const labels = pool.keys.length > 0
      ? pool.keys.map((k) => {
          const marker = k.id === pool.activeId ? " ← 当前" : "";
          const failMark = k.failed ? " [失效]" : "";
          return `  ${k.alias}${marker}${failMark}`;
        })
      : ["  (暂无 Key)"];

    const menuText = [
      `${manager.name} Key 管理 (${pool.keys.length} 个)`,
      "──────────────────────",
      ...labels,
      "──────────────────────",
    ].join("\n");

    const choice = await callbacks.ui.select(menuText, items);
    if (!choice || choice.startsWith("✓")) break;

    if (choice.startsWith("⇄")) {
      const keyItems = pool.keys.map((k) => {
        const marker = k.id === pool.activeId ? " ← 当前" : "";
        const failMark = k.failed ? " [失效]" : "";
        return `${k.alias}${marker}${failMark}`;
      });
      const sel = await callbacks.ui.select("选择要激活的 Key", keyItems);
      if (!sel) continue;
      const idx = keyItems.indexOf(sel);
      if (idx >= 0 && idx < pool.keys.length) {
        pool.activeId = pool.keys[idx].id;
        manager.savePool(pool);
        callbacks.ui.notify(`已切换到 "${pool.keys[idx].alias}"`, "info");
      }
      continue;
    }

    if (choice.startsWith("🔑")) {
      const name = await callbacks.input("Key 别名（可选，如 'key1'）:") || "";
      const key = await callbacks.input("API Key:") || "";
      if (key.trim().length < 10) {
        callbacks.ui.notify("API Key 太短，跳过", "warning");
        continue;
      }
      pool.keys.push({
        id: generateId(),
        alias: name.trim() || `Key-${pool.keys.length + 1}`,
        key: key.trim(),
        failed: false,
      });
      if (!pool.activeId || !pool.keys.find((k) => k.id === pool.activeId)) {
        pool.activeId = pool.keys[0].id;
      }
      manager.savePool(pool);
      callbacks.ui.notify(`已添加 "${name || `Key-${pool.keys.length}`}"`, "info");
      continue;
    }

    if (choice.startsWith("🗑")) {
      const keyItems = pool.keys.map((k) => {
        const marker = k.id === pool.activeId ? " ← 当前" : "";
        return `${k.alias}${marker}`;
      });
      const sel = await callbacks.ui.select("选择要删除的 Key", keyItems);
      if (!sel) continue;
      const idx = keyItems.indexOf(sel);
      if (idx >= 0 && idx < pool.keys.length) {
        const removed = pool.keys[idx];
        pool.keys = pool.keys.filter((_, i) => i !== idx);
        if (pool.activeId === removed.id && pool.keys.length > 0) {
          pool.activeId = pool.keys[0].id;
        } else if (pool.keys.length === 0) {
          pool.activeId = "";
        }
        manager.savePool(pool);
        callbacks.ui.notify(`已删除 "${removed.alias}"`, "info");
      }
      continue;
    }
  }

  const active = getNextAvailableKey(pool);
  return {
    refresh: JSON.stringify(pool),
    access: active?.key ?? "",
    expires: FAR_FUTURE,
  };
}

// ─── refreshModels ───────────────────────────────────────────

async function refreshModels(
  ctx: any,
  manager: ProviderManager,
  def: ProviderDef,
): Promise<any[] | void> {
  if (ctx.allowNetwork) {
    const apiKey = manager.getApiKey();
    if (apiKey) {
      try {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 8000);
        if (ctx.signal) {
          ctx.signal.addEventListener("abort", () => controller.abort(), { once: true });
        }
        const resp = await fetch(`${def.baseUrl}/models`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: controller.signal,
        });
        clearTimeout(t);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = (await resp.json()) as any;
        const ids: string[] = (data?.data ?? []).map((m: any) => m.id).filter(Boolean);
        if (ctx.signal?.aborted) return;
        if (ids.length > 0) {
          const models = buildModelsForIds(ids, def);
          await ctx.store.write({ models, checkedAt: Date.now() });
          return models;
        }
      } catch {
        // 拉取失败，回退到缓存
      }
    }
  }

  // 离线 / 失败：用缓存中的模型 ID 重新套用当前规格
  const cached = await ctx.store.read();
  if (cached?.models && cached.models.length > 0) {
    return buildModelsForIds(
      cached.models.map((m: any) => m.id),
      def,
    );
  }
}

/** 按模型 ID 列表构建 ModelDef[]：
 *   在静态 models（SPECS 查找表）中查找 → 命中复用元数据
 *   未命中走 inferRules 推断 */
function buildModelsForIds(ids: string[], def: ProviderDef): ModelDef[] {
  const lookups = new Map(def.models.map((m) => [m.id, m]));
  return ids.map((id) => {
    const staticDef = lookups.get(id);
    if (staticDef) {
      // quirk (spec): refresh 路径强制 cacheWrite: 0
      return {
        ...staticDef,
        cost: staticDef.cost ? { ...staticDef.cost, cacheWrite: 0 } : undefined,
      };
    }
    // 推断
    return {
      ...inferModel(id, def.inferRules, def.inferDefaults),
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        ...(def.inferDefaults?.cost ?? {}),
      },
    };
  });
}

// ─── /keys 命令 ──────────────────────────────────────────────
