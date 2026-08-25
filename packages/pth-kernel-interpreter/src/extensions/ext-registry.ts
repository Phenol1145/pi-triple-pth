/**
 * ext-registry.ts —— 兼容性扩展装载器（P2——SPEC 2026-08-09 §5）
 *
 * ExtRegistry：扫描 toolstore/extensions/<id>/plugin.json → 校验 → eval index.ts → factory(ExtContext)
 * → 注册 contracts（tools/capabilities/events/roles/kernels/debugAdapters）。
 *
 * 多 batch 兼容：每 batch 进程内独立装载（toolstore 扫描——eval 重放——隔离无共享状态冲突）。
 * 权限分层：ExtContext 受限（memory/fs/llm/c/exec/http/db——与任务代码同源白名单）。
 *
 * 扩展开发 SDK（2026-08-12 完善——toolstore/extensions/sdk.d.ts 类型面 + 标准通道）：
 *   - 类型：sdk.d.ts 导出 PthExtContext/PthExtFactoryResult——扩展作者 /// reference 引用 +
 *     // @ts-check 获得类型提示；scripts/tools/ext-check.ts 做类型检查 + 装载冒烟
 *   - 标准通道：ctx.exec（子进程）/ ctx.http.get（fetch 封装）/ ctx.db.query（只读白名单）——
 *     替代扩展内裸 import node 模块（new Function 环境无 require）
 *   - 错误可见性：loadAll 默认 onError 记日志（不静默）；evalFactory 语法错误提示
 *     （含 TS 语法误用提示——扩展运行于 JS 环境）
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { parseExtManifest, type ExtManifest, type ExtRole } from "./ext-manifest.js";
import { getEventBus, type KernelEventHandler } from "../execution/event-bus.js";
import { validateCatalogContributions } from "@away_from/pth-contracts";
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

/** 子进程执行结果（ctx.exec） */
export interface ExecResult {
  ok: boolean;
  stdout?: string;
  stderr?: string;
  error?: string;
  code?: number;
}

/** HTTP 获取结果（ctx.http.get） */
export interface HttpResult {
  ok: boolean;
  status?: number;
  text?: string;
  bytes?: number;
  contentType?: string;
  error?: string;
}

/** 扩展上下文（受限——能力白名单；2026-08-12 补标准通道 exec/http/db） */
export interface ExtContext {
  memory?: { query: (sql: string) => Promise<unknown>; write: (kind: string, content: string, opts?: unknown) => Promise<unknown> };
  fs?: { readText: (name: string) => Promise<string>; writeText?: (name: string, content: string) => Promise<void> };
  llm?: { complete: (opts: unknown) => Promise<unknown> };
  c?: { execute: (code: string, opts?: unknown) => Promise<unknown>; executeUnit?: (name: string) => Promise<unknown> };
  /** 子进程执行（受控：超时/输出上限——替代扩展内裸 import child_process） */
  exec?: (command: string, args?: string[], opts?: { cwd?: string; timeoutMs?: number; maxOutputBytes?: number }) => Promise<ExecResult>;
  /** HTTP 只读获取（协议约束 https/本地——超时/大小上限——替代裸 fetch 约定重复实现） */
  http?: { get: (url: string, opts?: { maxBytes?: number; timeoutMs?: number; headers?: Record<string, string> }) => Promise<HttpResult> };
  /** 只读数据库查询（白名单表——tasks/memory_entries/transcripts——键值对过滤防注入） */
  db?: { query: (table: string, opts?: { where?: Record<string, string | number>; limit?: number }) => Promise<unknown> };
  log?: (msg: string) => void;
}

export interface ExtRegistryOptions {
  toolstore: Toolstore;
  extContext: ExtContext;
  pluginApiVersion?: string;
  onError?: (extId: string, err: Error) => void;
  /** P3-3：catalog 严格贡献模式（默认 false=legacy 兼容；bootstrap 走 true） */
  strictCatalogContributions?: boolean;
  /** 模块化优化 P0：扩展角色注册回调（装配层注入 registerWorkerRole——断开 ext-registry→worker-cluster 环） */
  roleRegistrar?: (role: ExtRole) => void;
}

export interface LoadedExt {
  manifest: ExtManifest;
  tools: Record<string, (args: unknown, ctx?: unknown) => Promise<unknown>>;
  capabilities: Record<string, (args: unknown) => Promise<unknown>>;
  roles: ExtRole[];
  kernels: Array<{ language: string; create: (opts: unknown) => unknown }>;
  debugAdapters: Array<{ language: string; create: (opts: unknown) => unknown }>;
}

/** 默认装载错误处理（2026-08-12：不静默——单扩展失败可见；调用方可覆盖） */
export function defaultExtOnError(extId: string, err: Error): void {
  console.error(`[ext-load] 扩展 ${extId} 装载失败: ${err.message}`);
}

/**
 * 构造标准扩展通道（exec/http/db 默认实现——2026-08-12 SDK 完善）。
 * 返回与既有 ExtContext 合并用（memory/fs/llm/c/log 由调用方注入）。
 */
export function buildStdExtChannels(deps: {
  /** db.query 实际执行通道（缺省 = 无——扩展内 db.query 返回不可用错误）；
   *  注入方（assembly）接 pg 只读查询。白名单表/过滤构建由本函数内建（扩展无脑用）。 */
  dbQuery?: (table: string, sql: string) => Promise<unknown>;
  /** 子进程执行白名单（缺省 = 全部放行——扩展为受信 toolstore 代码；可收紧为命令名集合） */
  execAllowlist?: string[];
}): Pick<ExtContext, "exec" | "http" | "db"> {
  // 只读查询白名单（与 sql-readonly 扩展语义同源——2026-08-12 SDK 完善：通道层保证）
  const DB_ALLOWED_TABLES = ["tasks", "memory_entries", "transcripts"] as const;
  const DB_COLS: Record<string, string> = {
    tasks: "id, title, status, assigned_role, created_at",
    memory_entries: "id, kind, status, hit_count, created_at",
    transcripts: "id, created_at",
  };
  const buildWhere = (where?: Record<string, string | number>): { sql: string; error?: string } => {
    if (!where) return { sql: "" };
    const parts: string[] = [];
    for (const [k, v] of Object.entries(where).slice(0, 5)) {
      if (!/^[a-z_]{1,32}$/.test(k)) return { sql: "", error: `列名非法 "${k}"` };
      const sv = String(v);
      if (!/^[A-Za-z0-9 _\-.:]{0,64}$/.test(sv)) return { sql: "", error: `值含非法字符（col=${k}）` };
      parts.push(`${k} = '${sv.replace(/'/g, "''")}'`);
    }
    return { sql: parts.length ? ` WHERE ${parts.join(" AND ")}` : "" };
  };

  return {
    // 子进程执行（受控）
    exec: async (command, args = [], opts = {}) => {
      if (deps.execAllowlist && !deps.execAllowlist.includes(command)) {
        return { ok: false, error: `ctx.exec: 命令 "${command}" 不在白名单（${deps.execAllowlist.join("/")}）` };
      }
      const { execFile } = await import("node:child_process");
      const timeoutMs = opts.timeoutMs ?? 15000;
      const maxOutput = opts.maxOutputBytes ?? 4 * 1024 * 1024;
      return await new Promise<ExecResult>((resolve) => {
        execFile(command, args, { cwd: opts.cwd ?? process.cwd(), timeout: timeoutMs, maxBuffer: maxOutput },
          (err, stdout, stderr) => {
            if (err) {
              const e = err as NodeJS.ErrnoException;
              resolve({
                ok: false,
                stdout,
                stderr,
                code: typeof e.code === "number" ? e.code : undefined,
                error: (stderr || e.message || String(e.code ?? "?").slice(0, 400)),
              });
              return;
            }
            resolve({ ok: true, stdout, stderr, code: 0 });
          });
      });
    },
    // HTTP 只读获取（协议约束 + 大小上限）
    http: {
      get: async (url, opts = {}) => {
        try {
          const u = new URL(url);
          const allowed = u.protocol === "https:" || (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1"));
          if (!allowed) return { ok: false, error: `ctx.http.get: 仅允许 https（或 http localhost）——协议/主机不合法` };
          const maxBytes = Math.min(opts.maxBytes ?? 512 * 1024, 2 * 1024 * 1024);
          const res = await fetch(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? 15000), redirect: "follow", headers: { "user-agent": "pth-ext-http/1.0", ...(opts.headers ?? {}) } });
          if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status} ${res.statusText}` };
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length > maxBytes) return { ok: false, error: `响应 ${buf.length} 字节超上限 ${maxBytes}` };
          const ct = res.headers.get("content-type") ?? "";
          const text = ct.includes("text") || ct.includes("json") || ct.includes("xml") || ct.includes("html") || ct.includes("javascript")
            ? buf.toString("utf8")
            : `(binary ${ct || "unknown"}——${buf.length} 字节)`;
          return { ok: true, status: res.status, text: text.slice(0, maxBytes), bytes: buf.length, contentType: ct };
        } catch (e) {
          return { ok: false, error: `ctx.http.get 失败: ${(e as Error).message.slice(0, 200)}` };
        }
      },
    },
    // 只读数据库查询（白名单表 + 键值对过滤防注入——通道层内建）
    db: {
      query: async (table, opts = {}) => {
        if (!deps.dbQuery) return { ok: false, error: "ctx.db.query: 运行环境未注入查询通道" };
        if (!DB_ALLOWED_TABLES.includes(table as (typeof DB_ALLOWED_TABLES)[number])) {
          return { ok: false, error: `ctx.db.query: 表白名单（${DB_ALLOWED_TABLES.join("/")}）——"${table}" 不允许` };
        }
        const w = buildWhere(opts.where ?? {});
        if (w.error) return { ok: false, error: `ctx.db.query: ${w.error}` };
        const limit = Math.min(Math.max(Number(opts.limit ?? 20) || 20, 1), 100);
        const sql = `SELECT ${DB_COLS[table]} FROM ${table}${w.sql} ORDER BY created_at DESC LIMIT ${limit}`;
        try {
          const rows = await deps.dbQuery(table, sql);
          return { ok: true, rows };
        } catch (e) {
          return { ok: false, error: `ctx.db.query 失败: ${(e as Error).message.slice(0, 200)}` };
        }
      },
    },
  };
}

export class ExtRegistry {
  private loaded = new Map<string, LoadedExt>();

  constructor(private opts: ExtRegistryOptions) {
    this.opts.onError ??= defaultExtOnError;   // 2026-08-12：默认记日志——不静默
  }

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

    // P3-3：catalog 严格模式——tools/events/kernels/debugAdapters/onStartup 声明拒绝
    if (this.opts.strictCatalogContributions) {
      const check = validateCatalogContributions(manifest.contracts);
      if (!check.ok) {
        throw new Error(`扩展 ${id} 贡献声明不支持 catalog（${check.unsupported.join(", ") || "缺少实现"}）：${check.diagnostics.join("；")}`);
      }
    }

    // 2. index.js/index.ts eval（复用 toolstore 代码通道——eval 重放；2026-08-12 SDK 完善：
    //    入口约定 .js（checkJs + JSDoc 类型检查友好）——.ts 向后兼容（纯 JS 内容））
    let code = "";
    try {
      code = await this.opts.toolstore.readText(`extensions/${id}/index.js`);
    } catch {
      code = await this.opts.toolstore.readText(`extensions/${id}/index.ts`);
    }
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
        this.opts.roleRegistrar?.(role);
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
    let fn: () => unknown;
    try {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      fn = new Function(wrapped) as () => unknown;
    } catch (e) {
      // 2026-08-12 SDK 完善：语法错误可见 + 友好提示（扩展运行于 JS——TS 标注需移除/转译）
      const raw = (e as Error).message;
      const tsHint = /\bas\b|interface |type [A-Za-z]|: [A-Za-z]/.test(code)
        ? "——检测到疑似 TS 语法（as 断言/interface/类型标注）：扩展 index.ts 运行于 JS 环境（new Function eval），TS 类型标注请移除或用 JSDoc 注释"
        : "";
      throw new Error(`扩展 ${id}: index.ts 语法错误${tsHint}\n  ${raw.split("\n")[0] ?? raw}`);
    }
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
