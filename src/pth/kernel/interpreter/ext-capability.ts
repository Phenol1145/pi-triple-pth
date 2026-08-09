/**
 * ext-capability.ts —— 扩展编排面（用户裁决 2026-08-09：代码库式扩展 + 公共记忆区索引）
 *
 * 扩展 = 可引用代码库（toolstore 文件 / 编译单元 / memory 数据）——无注册装载。
 * 编排面 = ext 能力函数（ts 程序内按需引用）+ 公共记忆区索引（memory kind:extension-index）。
 *
 *   ext.index()       扫描 toolstore/extensions/ → 扩展清单（manifest 元数据 + 代码入口）
 *   ext.use(name,args) 读扩展代码 → eval 重放 → 执行（按需引用——零注册）
 *   ext.syncIndex()   扫描结果写入公共记忆区（memory kind:extension-index）——agent 可查询发现
 */

import type { ExtManifest } from "../extensions/ext-manifest.js";
import type { Toolstore } from "./toolstore.js";
import type { Interpreter } from "./types.js";
import type { PgMemoryStore } from "../storage/memory-store-pg.js";

export interface ExtIndexEntry {
  id: string;
  name: string;
  description?: string;
  version?: string;
  entry: string;          // toolstore 代码入口（extensions/<id>/index.ts）
  contracts: string[];    // manifest contracts 摘要（tools/capabilities/roles…）
}

export interface ExtCapabilityOptions {
  toolstore: Toolstore;
  memory?: { write: (e: { kind: string; content: string; anchors: string[] }) => Promise<unknown> };
  /** 新执行核注册（kernel-manager.registerKernel——ext.kernel 按需接线） */
  registerKernel?: (language: string, interpreter: unknown) => void;
}

/** 扫描 toolstore/extensions/ → 索引（manifest 元数据 + 入口） */
export async function scanExtensions(toolstore: Toolstore): Promise<ExtIndexEntry[]> {
  const dirs = await toolstore.listDirs("extensions").catch(() => [] as string[]);
  const out: ExtIndexEntry[] = [];
  for (const id of dirs) {
    try {
      const manifestJson = await toolstore.readText(`extensions/${id}/plugin.json`);
      const manifest: ExtManifest = JSON.parse(manifestJson);
      out.push({
        id: manifest.id ?? id,
        name: manifest.name ?? id,
        description: manifest.description,
        version: manifest.version,
        entry: `extensions/${id}/index.ts`,
        contracts: [
          ...(manifest.contracts?.tools ?? []).map((t) => `tool:${t}`),
          ...(manifest.contracts?.capabilities ?? []).map((c) => `capability:${c}`),
          ...(manifest.contracts?.roles ?? []).map((r) => `role:${r.id}`),
        ],
      });
    } catch {
      // manifest 缺失/非法——跳过（代码库式：非强制）
    }
  }
  return out;
}

/** 构建 ext 能力面（注入 ts 程序） */
export function createExtCapability(opts: ExtCapabilityOptions): Record<string, unknown> {
  return {
    ext: {
      /** 扩展清单（按需——不注册不装载） */
      index: async (): Promise<ExtIndexEntry[]> => scanExtensions(opts.toolstore),
      /** 引用扩展代码库（读 index.ts → eval 重放 → factory(extCtx) → 调用目标工具） */
      use: async (name: string, args: Record<string, unknown> = {}): Promise<unknown> => {
        const code = await opts.toolstore.readText(`extensions/${name}/index.ts`);
        // eval 重放（复用 recall 通道语义——扩展工厂约定 module.exports = factory(ctx)）
        const wrapped = `"use strict";
          const module = { exports: {} };
          const exports = module.exports;
          ${code}
          return module.exports.default ?? module.exports;`;
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        const fn = new Function(wrapped)() as unknown;
        const factory = typeof fn === "function" ? fn as (ctx: Record<string, unknown>) => unknown : null;
        if (!factory) throw new Error(`ext.use: ${name}/index.ts 未导出 factory`);
        const result = factory({ log: () => {} }) as { tools?: Record<string, (a: unknown) => Promise<unknown>> };
        // 目标工具：args.tool 指定扩展内工具（缺省取第一个）
        const toolName = (args["tool"] as string | undefined)
          ?? Object.keys(result.tools ?? {})[0];
        if (!toolName || !result.tools?.[toolName]) {
          throw new Error(`ext.use: ${name} 无工具 ${toolName ?? "(缺省)"}（可用: ${Object.keys(result.tools ?? {}).join("/")}）`);
        }
        return await result.tools[toolName]!(args["args"] ?? args);
      },
      /** 注册新执行核（代码库式接线：eval 代码 → Interpreter 实例 → kernel-manager 路由）——
       *  code 约定：module.exports = { create: (ctx) => ({ language, execute, reset, dispose, snapshot }) } */
      kernel: async (language: string, code: string): Promise<{ language: string; ok: boolean }> => {
        if (!opts.registerKernel) throw new Error("ext.kernel: registerKernel 未注入（batch 环境）");
        const wrapped = `"use strict";
          const module = { exports: {} };
          const exports = module.exports;
          ${code}
          return module.exports.default ?? module.exports;`;
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        const fn = new Function(wrapped)() as unknown;
        const mod = typeof fn === "function" ? fn({ log: () => {} }) : fn;
        const created = (mod as { create?: (ctx: Record<string, unknown>) => unknown }).create?.({ log: () => {} })
          ?? (mod as Record<string, unknown>)["interpreter"]
          ?? mod;
        if (!created || typeof (created as { execute?: unknown }).execute !== "function") {
          throw new Error(`ext.kernel: ${language} 代码未导出 execute 实现（Interpreter 接口）`);
        }
        opts.registerKernel(language, created as Interpreter);
        return { language, ok: true };
      },
      /** 同步索引到公共记忆区（memory kind:extension-index——编排面进公共记忆） */
      syncIndex: async (): Promise<{ count: number }> => {
        if (!opts.memory) throw new Error("ext.syncIndex: memory 未配置");
        const entries = await scanExtensions(opts.toolstore);
        const content = JSON.stringify(entries, null, 2);
        await opts.memory.write({
          kind: "extension-index",
          content,
          anchors: ["extensions", "index", "extension-index"],
        });
        return { count: entries.length };
      },
    },
  };
}
