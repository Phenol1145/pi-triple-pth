/**
 * pit-providers/commands.ts —— /keys 子命令（switch/check/list）。
 * （模块专项 ② 大文件拆分：自 index.ts 抽出）
 */
import type { KeyEntry } from "./types.js";
import type { ProviderManager } from "./manager.js";


function keyLabel(k: KeyEntry, activeId: string): string {
  const mark = k.id === activeId ? " ← active" : "";
  const fail = k.failed ? " [失效]" : "";
  return `${k.alias}${mark}${fail}`;
}

async function switchActiveKey(ctx: any, manager: ProviderManager): Promise<void> {
  const pool = manager.loadPool();
  if (pool.keys.length === 0) {
    ctx.ui.notify(`没有已注册的 Key。用 /login ${manager.id} 添加。`, "warning");
    return;
  }
  const choice = await ctx.ui.select(
    "选择要激活的 Key",
    pool.keys.map((k: KeyEntry) => keyLabel(k, pool.activeId)),
  );
  if (!choice) return;
  const idx = pool.keys.findIndex((k: KeyEntry) => keyLabel(k, pool.activeId) === choice);
  if (idx < 0) return;
  const selected = pool.keys[idx];
  if (selected.id === pool.activeId) {
    ctx.ui.notify(`"${selected.alias}" 已是当前 Key`, "info");
    return;
  }
  const next = { ...pool, activeId: selected.id };
  manager.savePool(next);
  ctx.ui.notify(`已切换到 "${selected.alias}"，正在刷新模型列表...`, "info");
  try {
    await ctx.modelRegistry.refresh();
    ctx.ui.notify(`模型列表已按 "${selected.alias}" 更新`, "info");
  } catch {
    ctx.ui.notify("模型刷新失败，但 Key 已切换", "warning");
  }
}

async function checkAllKeys(ctx: any, manager: ProviderManager): Promise<void> {
  const pool = manager.loadPool();
  if (pool.keys.length === 0) {
    ctx.ui.notify(`没有已注册的 Key。用 /login ${manager.id} 添加。`, "warning");
    return;
  }

  const next = { ...pool, keys: pool.keys.map((k: KeyEntry) => ({ ...k })) };
  const lines: string[] = [`${manager.name} Key 探测结果:`, "──────────────────────"];

  for (let i = 0; i < next.keys.length; i++) {
    const k = next.keys[i];
    ctx.ui.setStatus("keys-check", `正在探测 "${k.alias}" (${i + 1}/${next.keys.length})...`);
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 8000);
      const resp = await fetch(`${manager.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${k.key}` },
        signal: controller.signal,
      });
      clearTimeout(t);
      if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
      const data = (await resp.json()) as any;
      const ids: string[] = (data?.data ?? []).map((m: any) => m.id).filter(Boolean);
      next.keys[i] = { ...next.keys[i], failed: false };
      const mark = k.id === pool.activeId ? " ← active" : "";
      lines.push(`✓ ${k.alias}: ${ids.length} 个模型${mark}`);
    } catch (e: any) {
      const msg = e.message || String(e);
      const isAuth = /^HTTP (401|403)\b/.test(msg);
      next.keys[i] = { ...next.keys[i], failed: isAuth };
      const tag = isAuth ? " [已标记失效]" : " (瞬时失败，状态不变)";
      lines.push(`✗ ${k.alias}: ${msg}${tag}`);
    }
  }
  ctx.ui.setStatus("keys-check", undefined);

  // active Key 认证失败 → 自动切换
  if (next.activeId) {
    const active = next.keys.find((k: KeyEntry) => k.id === next.activeId);
    if (active?.failed) {
      const alt = next.keys.find((k: KeyEntry) => !k.failed);
      if (alt) {
        next.activeId = alt.id;
        lines.push("──────────────────────");
        lines.push(`⚠ active Key 认证失败，已自动切换到 "${alt.alias}"`);
      }
    }
  }
  manager.savePool(next);
  ctx.ui.notify(lines.join("\n"), "info");
}

async function listActiveModels(ctx: any, manager: ProviderManager): Promise<void> {
  const pool = manager.loadPool();
  const active = pool.keys.find((k: KeyEntry) => k.id === pool.activeId);
  if (!active) {
    ctx.ui.notify(`没有 active Key。用 /login ${manager.id} 添加。`, "warning");
    return;
  }

  ctx.ui.setStatus("keys-list", `正在拉取 "${active.alias}" 的模型列表...`);
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 8000);
    const resp = await fetch(`${manager.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${active.key}` },
      signal: controller.signal,
    });
    clearTimeout(t);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    const data = (await resp.json()) as any;
    const ids: string[] = (data?.data ?? []).map((m: any) => m.id).filter(Boolean);
    ctx.ui.setStatus("keys-list", undefined);
    const lines = [
      `Active Key: ${active.alias} (${active.key.slice(0, 6)}...${active.key.slice(-4)})`,
      `可访问模型 (${ids.length}):`,
      "──────────────────────",
      ...ids.map((id: string) => `  • ${id}`),
    ];
    ctx.ui.notify(lines.join("\n"), "info");
  } catch (e: any) {
    ctx.ui.setStatus("keys-list", undefined);
    ctx.ui.notify(`拉取失败: ${e.message}`, "error");
  }
}

// ─── Entry Point ─────────────────────────────────────────────
