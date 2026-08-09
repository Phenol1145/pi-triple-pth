/**
 * ext-registry.ts —— 兼容性扩展装载器（P2——SPEC 2026-08-09 §5）
 *
 * ExtRegistry：扫描 toolstore/extensions/<id>/plugin.json → 校验 → eval index.ts → factory(ExtContext)
 * → 注册 contracts（tools/capabilities/events/roles/kernels/debugAdapters）。
 *
 * 多 batch 兼容：每 batch 进程内独立装载（toolstore 扫描——eval 重放——隔离无共享状态冲突）。
 * 权限分层：ExtContext 受限（memory/fs/llm/c——与任务代码同源白名单）——执行核命令不直接暴露。
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { parseExtManifest, type ExtManifest, type ExtRole } from "./ext-manifest.js";
import { getEventBus, type KernelEventHandler } from "../execution/event-bus.js";
import { registerWorkerRole } from "../execution/worker-cluster.js";
import type { Toolstore } from "../interpreter/toolstore.js";

/** 扩展工厂返回（contracts 实现——index.ts 导出形态） */
export interface ExtFactoryResult {
  tools?: Record<string, (args: unknown, ctx?: unknown) => Promise<unknown>>;
  capabilities?: Record<string, (args: unknown) => Promise<unknown>>;
  events?: Record<string, KernelEventHandler>;
  roles?: ExtRole[];
  kernels?: Array<{ language: string; create: (opts: unknown) => unknown }>;
  debugAdapters?: Array<{ language: string; create: (opts: unknown) => unknown }>;
}

/** 扩展上下文（受限——能力白名单） */
export interface ExtContext {
  memory?: { query: (sql: string) => Promise<unknown>; write: (kind: string, content: string, opts?: unknown) => Promise<unknown> };
  fs?: { readText: (name: string) => Promise<string>; writeText?: (name: string, content: string) => Promise<void> };
  llm?: { complete: (opts: unknown) => Promise<unknown> };
  c?: { execute: (code: string, opts?: unknown) => Promise<unknown>; executeUnit?: (name: string) => Promise<unknown> };
  log?: (msg: string) => void;
}

export interface ExtRegistryOptions {
  toolstore: Toolstore;
  extContext: ExtContext;
  pluginApiVersion?: string;
  onError?: (extId: string, err: Error) => void;
}

export interface LoadedExt {
  manifest: ExtManifest;
  tools: Record<string, (args: unknown, ctx?: unknown) => Promise<unknown>>;
  capabilities: Record<string, (args: unknown) => Promise<unknown>>;
  roles: ExtRole[];
  kernels: Array<{ language: string; create: (opts: unknown) => unknown }>;
  debugAdapters: Array<{ language: string; create: (opts: unknown) => unknown }>;
}

export class ExtRegistry {
  private loaded = new Map<string, LoadedExt>();

  constructor(private opts: ExtRegistryOptions) {}

  /** 扫描 toolstore/extensions/ → 装载全部（onStartup） */
  async loadAll(): Promise<string[]> {
    const ids = await this.opts.toolstore.listDirs("extensions").catch(() => [] as string[]);
    const loaded: string[] = [];
    for (const entry of ids) {
      // extensions/<id>/——listSubdir 返回文件名（目录无法区分——约定目录名为扩展 id）
      const id = entry.replace(/\/$/, "");
      try {
        await this.loadOne(id);
        loaded.push(id);
      } catch (e) {
        this.opts.onError?.(id, e as Error);
      }
    }
    return loaded;
  }

  /** 装载单个扩展（plugin.json 校验 → index.ts eval → contracts 注册） */
  async loadOne(id: string): Promise<LoadedExt> {
    // 1. manifest 校验
    const manifestJson = await this.opts.toolstore.readText(`extensions/${id}/plugin.json`);
    const manifest = parseExtManifest(manifestJson, this.opts.pluginApiVersion);

    // 2. index.ts eval（复用 toolstore 代码通道——eval 重放）
    const code = await this.opts.toolstore.readText(`extensions/${id}/index.ts`);
    const factory = this.evalFactory(code, id);

    // 3. factory(ExtContext) → contracts 实现
    const result: ExtFactoryResult = await factory(this.opts.extContext);

    const loaded: LoadedExt = {
      manifest,
      tools: result.tools ?? {},
      capabilities: result.capabilities ?? {},
      roles: result.roles ?? [],
      kernels: result.kernels ?? [],
      debugAdapters: result.debugAdapters ?? [],
    };

    // 4. contracts 处理（代码库式——2026-08-09 用户裁决：无 tools/capabilities/events 注册装载；
    //    编排面 = ext 能力（index/use/syncIndex）+ 公共记忆区索引）
    //    roles 保留：PTH 独有正交角色谱系扩展（装载注册——独立价值）
    for (const role of loaded.roles) {
      try {
        registerWorkerRole(role);
      } catch (e) {
        // 幂等：重复装载同一角色（同 id）跳过（loadAll 后再 loadOne 的场景）；
        // 真冲突（labelPatterns 重叠）仍抛出
        if ((e as Error).message.includes("已存在")) continue;
        throw e;
      }
    }

    this.loaded.set(id, loaded);
    return loaded;
  }

  /** eval 扩展工厂（toolstore 代码 → factory 函数——复用 recall-functions 通道语义） */
  private evalFactory(code: string, id: string): (ctx: ExtContext) => Promise<ExtFactoryResult> {
    // strip 类型（TS → JS——toolstore 重放通道的简单化：直接 new Function eval——
    // 扩展工厂约定 export default function factory(ctx) {...} → 包装为 factory 调用）
    const wrapped = `"use strict";
      const module = { exports: {} };
      const exports = module.exports;
      ${code}
      return module.exports.default ?? module.exports;`;
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function(wrapped) as () => unknown;
    const factory = fn();
    if (typeof factory !== "function") {
      throw new Error(`extension ${id}: index.ts 未导出 factory 函数`);
    }
    return factory as (ctx: ExtContext) => Promise<ExtFactoryResult>;
  }


  /** 已装载扩展查询 */
  getLoaded(id: string): LoadedExt | undefined { return this.loaded.get(id); }
  get loadedIds(): string[] { return [...this.loaded.keys()]; }
}
