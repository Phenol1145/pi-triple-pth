/**
 * pit-providers — 统一 Provider 后端
 *
 * 从 providers.json 加载声明式 provider 定义，
 * 自动 registerProvider + /keys 多 Key 管理 + 401/403 failover。
 *
 * 单一 entry：export default function(pi) 由 pi 扩展加载器调用。
 */
import fs from "node:fs";
import path from "node:path";
import { loadProviders, ensureDefaultProviders } from "./registry.js";
import { ProviderManager } from "./manager.js";
import { registerFailover } from "./failover.js";
import { simpleProviderOpts, multiKeyProviderOpts } from "./registration.js";
import { switchActiveKey, checkAllKeys, listActiveModels } from "./commands.js";
import type { ProviderDef, KeyEntry } from "./types.js";

// ─── 双注册防护 ──────────────────────────────────────────────

/** 检查共享层的 extensions/ 目录下是否存在旧扩展 */
function hasLegacyExtension(): { kimi: boolean; ustc: boolean } {
  // __dirname 在 ESM 中为 import.meta 的产物；pi 扩展环境类似。
  // 这里用 PI_CODING_AGENT_DIR 下的 extensions/ 路径检测。
  const dir = process.env.PI_CODING_AGENT_DIR;
  const extDir = dir ? path.join(dir, "extensions") : null;
  if (!extDir) return { kimi: false, ustc: false };
  return {
    kimi: fs.existsSync(path.join(extDir, "kimi-platform")),
    ustc: fs.existsSync(path.join(extDir, "ustc-llm")),
  };
}

// ─── Entry Point ─────────────────────────────────────────────

export default function pitProviders(pi: any) {
  // 确保 providers.json 存在
  ensureDefaultProviders();

  // 加载 provider 定义
  const { providers, errors } = loadProviders();

  if (errors.length > 0) {
    process.stderr.write(`[pit-providers] providers.json 警告:\n`);
    for (const e of errors) {
      process.stderr.write(`  ${e}\n`);
    }
  }

  if (providers.length === 0) {
    process.stderr.write("[pit-providers] 没有有效的 provider 定义，扩展未注册任何 provider\n");
    return;
  }

  // 双注册防护：检测旧扩展
  const legacy = hasLegacyExtension();

  // 收集所有 multiKey manager（failover / /keys 用）
  const multiKeyManagers = new Map<string, ProviderManager>();

  // 按 providerId 索引所有 manager（failover 查找用）
  const allManagers = new Map<string, ProviderManager>();

  for (const def of providers) {
    const manager = new ProviderManager(def);
    allManagers.set(def.id, manager);
    // 也按 alias[0] 索引（/keys 匹配 + failover）
    if (def.alias && def.alias.length > 0) {
      allManagers.set(def.alias[0], manager);
    }

    // 双注册防护：检测对应旧扩展
    const skipKimi = legacy.kimi && def.id === "kimi";
    const skipUstc = legacy.ustc && (def.id === "ustc-llm" || def.id === "suntomb");
    if (skipKimi || skipUstc) {
      const oldExt = skipKimi ? "kimi-platform" : "ustc-llm";
      process.stderr.write(
        `[pit-providers] ⚠ 检测到旧扩展 "${oldExt}"，跳过 ${def.name} provider 注册。\n` +
        `  请删除共享层 extensions/ 中的 "${oldExt}" 目录后重启 pi。\n`,
      );
      continue;
    }

    // 迁移旧 Key 池（multiKey 且 providerId match）
    if (def.multiKey) {
      manager.migrateLegacy();
      multiKeyManagers.set(def.id, manager);
    }

    if (def.multiKey) {
      pi.registerProvider(def.id, multiKeyProviderOpts(def, manager));
    } else {
      pi.registerProvider(def.id, simpleProviderOpts(def));
    }
  }

  // /keys 命令（仅 multiKey provider）
  if (multiKeyManagers.size > 0) {
    pi.registerCommand("keys", {
      description: "管理多 API Key: /keys <provider> [switch|check|list]",
      getArgumentCompletions: (prefix: string) => {
        const p = prefix.trim().split(/\s+/)[0] ?? "";
        // 第一级：provider 名称（支持 id 和 alias）
        const candidates = new Set<string>();
        for (const [id, mgr] of allManagers) {
          if (mgr.multiKey) {
            candidates.add(id);
            if (mgr.def.alias) {
              for (const a of mgr.def.alias) candidates.add(a);
            }
          }
        }
        const filtered = [...candidates].filter((c) => c.startsWith(p.toLowerCase()));
        return filtered.length > 0
          ? filtered.map((c) => ({
              value: c,
              label: c,
              description: allManagers.get(c)?.name ?? "",
            }))
          : null;
      },
      handler: async (args: string, ctx: any) => {
        const parts = (args || "").trim().split(/\s+/).filter(Boolean);
        let manager: ProviderManager | undefined;
        let sub: string | undefined;

        if (parts.length === 0) {
          if (multiKeyManagers.size === 1) {
            manager = Array.from(multiKeyManagers.values())[0];
          } else {
            const opts = Array.from(multiKeyManagers.values()).map(
              (m) => `${m.alias} — ${m.name}`,
            );
            const choice = await ctx.ui.select("选择 provider", opts);
            if (!choice) return;
            const alias = choice.split(" — ")[0].toLowerCase();
            manager = Array.from(multiKeyManagers.values()).find(
              (m) =>
                m.alias === alias ||
                m.def.alias?.includes(alias) ||
                m.id === alias,
            );
          }
        } else {
          // 按 alias 或 id 查找
          const key = parts[0].toLowerCase();
          manager = Array.from(multiKeyManagers.values()).find(
            (m) =>
              m.alias === key ||
              m.def.alias?.includes(key) ||
              m.id === key,
          );
          sub = parts[1]?.toLowerCase();
        }

        if (!manager) {
          const avail = Array.from(multiKeyManagers.values())
            .map((m) => m.alias)
            .join(", ");
          ctx.ui.notify(`未知 provider。可用: ${avail}`, "warning");
          return;
        }

        if (sub === "switch") return switchActiveKey(ctx, manager);
        if (sub === "check") return checkAllKeys(ctx, manager);
        if (sub === "list" || sub === "models") return listActiveModels(ctx, manager);

        // 无子命令：状态 + 菜单
        const pool = manager.loadPool();
        if (pool.keys.length === 0) {
          ctx.ui.notify(
            `没有已注册的 Key。用 /login ${manager.id} 添加。`,
            "warning",
          );
          return;
        }
        const active = pool.keys.find((k: KeyEntry) => k.id === pool.activeId);
        const statusLines = [
          `${manager.name} Key 状态`,
          "──────────────────────",
          ...pool.keys.map((k: KeyEntry) => keyLabel(k, pool.activeId)),
          "──────────────────────",
          `Active: ${active?.alias ?? "无"}`,
        ];
        const choice = await ctx.ui.select(statusLines.join("\n"), [
          "⇄ 切换 Active Key",
          "🔍 检查所有 Key 可用性",
          "📋 查看当前 Key 的模型列表",
        ]);
        if (!choice) return;
        if (choice.startsWith("⇄")) return switchActiveKey(ctx, manager);
        if (choice.startsWith("🔍")) return checkAllKeys(ctx, manager);
        if (choice.startsWith("📋")) return listActiveModels(ctx, manager);
      },
    });
  }

  // failover hook
  if (multiKeyManagers.size > 0) {
    registerFailover(pi, allManagers);
  }
}
