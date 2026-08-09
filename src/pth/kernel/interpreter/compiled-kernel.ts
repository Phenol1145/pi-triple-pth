/**
 * compiled-kernel.ts —— 编译核（编译-运行管道 + sha256 增量缓存）。
 *
 * 编译类语言统一协议（编译核 SPEC 2026-08-09）：
 *   execute(source) → 自动两阶段（增量编译 + 独立进程运行）→ Observation
 *   build(source) / run(binaryRef) 分离（LLM 可分开控制）
 *   reset() → 清构建缓存；snapshot() → 产物清单
 * 状态模型：文件即状态（无命名空间——跨 execute 靠工作区文件）
 * 首发语言：C（gcc/clang——用户裁决 2026-08-09）
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { ExecuteOptions, Interpreter, InterpreterResult, InterpreterSnapshot } from "./types.js";

export interface CompiledKernelOptions {
  /** 工作区根（编译运行目录——可临时可删） */
  workDir: string;
  /** 缓存目录（默认 <workDir>/.build-cache/<lang>——持久缓存可独立挂卷跨调用复用） */
  cacheDir?: string;
  /** 编译器命令（默认 cc——gcc/clang 兼容） */
  cc?: string;
  /** 编译超时 ms（默认 120s） */
  compileTimeoutMs?: number;
  /** 运行超时 ms（默认 30s） */
  runTimeoutMs?: number;
  /** 缓存二进制上限（默认 50——LRU 淘汰） */
  maxCache?: number;
  /** 缓存磁盘上限（默认 200MB——超限启动/写入时清理最旧条目） */
  maxCacheBytes?: number;
  /** 编译事件回调（监视组件：cache-hit/compile/evict——cold/hot 与变体计量） */
  onMetric?: (m: CompiledKernelMetric) => void;
}

/** 编译核指标事件（kernel-host 聚合 → /kernel/status → PTH obs.kernels） */
export interface CompiledKernelMetric {
  type: "cache-hit" | "compile" | "evict";
  cc: string;
  durationMs: number;
  cold?: boolean;
  cacheSize?: number;
}

interface CacheEntry {
  hash: string;
  binaryPath: string;
  sourcePath: string;
  lastUsedAt: number;
}

export interface BuildResult {
  ok: boolean;
  binaryRef?: string;
  diagnostics?: string;
  durationMs: number;
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 24);
}

function exec(cmd: string, args: string[], timeoutMs: number, cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, cwd, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? ((err as any).code ?? (err as any).killed ? -1 : -1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

export class CCompiledKernel implements Interpreter {
  readonly language = "c";
  private workDir: string;
  private cacheDir: string;
  private cc: string;
  private compileTimeoutMs: number;
  private runTimeoutMs: number;
  private maxCache: number;
  private maxCacheBytes: number;
  private onMetric?: (m: CompiledKernelMetric) => void;
  private entries: Map<string, CacheEntry> = new Map(); // hash → entry

  constructor(opts: CompiledKernelOptions) {
    this.workDir = opts.workDir;
    this.cacheDir = opts.cacheDir ?? path.join(opts.workDir, ".build-cache", "c");
    this.cc = opts.cc ?? "cc";
    this.compileTimeoutMs = opts.compileTimeoutMs ?? 120_000;
    this.runTimeoutMs = opts.runTimeoutMs ?? 30_000;
    this.maxCache = opts.maxCache ?? 50;
    this.maxCacheBytes = opts.maxCacheBytes ?? 200 * 1024 * 1024;
    this.onMetric = opts.onMetric;
    // 持久缓存恢复（跨调用/跨进程）：扫描 cacheDir 子目录（目录名=源码 sha256）→ entries
    void this.restoreFromDisk();
  }

  /** 启动恢复：磁盘缓存目录 → 内存 entries（mtime → lastUsedAt；超限清理最旧） */
  private async restoreFromDisk(): Promise<void> {
    try {
      const entries = await fs.readdir(this.cacheDir, { withFileTypes: true }).catch(() => [] as Array<{ name: string }>);
      for (const e of entries) {
        const name = typeof e === "string" ? e : e.name;
        // hash 长度兼容（实现用截断 sha256——26 字符；不硬编码——目录名含 main 即候选）
        if (name.length < 8) continue;
        const dir = path.join(this.cacheDir, name);
        const binaryPath = path.join(dir, "main");
        const sourcePath = path.join(dir, "main.c");
        const st = await fs.stat(binaryPath).catch(() => null);
        if (!st) continue;
        this.entries.set(name, { hash: name, binaryPath, sourcePath, lastUsedAt: st.mtimeMs });
      }
      await this.enforceDiskLimit();
    } catch { /* 恢复失败不阻塞（下次编译重建） */ }
  }

  /** 磁盘上限清理：总大小超限 → 删最旧（按 lastUsedAt）——跨进程持久缓存的空间治理 */
  private async enforceDiskLimit(): Promise<void> {
    try {
      const files = await fs.readdir(this.cacheDir, { withFileTypes: true }).catch(() => [] as Array<{ name: string }>);
      let total = 0;
      const sizes = new Map<string, number>();
      for (const f of files) {
        const name = typeof f === "string" ? f : f.name;
        const dir = path.join(this.cacheDir, name);
        const st = await fs.stat(path.join(dir, "main")).catch(() => null);
        if (!st) continue;
        sizes.set(name, st.size);
        total += st.size;
      }
      if (total <= this.maxCacheBytes) return;
      // 超限：按内存 entries 的 lastUsedAt 删最旧（磁盘无 mtime 排序时兜底目录顺序）
      const order = [...this.entries.values()].sort((a, b) => a.lastUsedAt - b.lastUsedAt);
      for (const e of order) {
        if (total <= this.maxCacheBytes) break;
        await fs.rm(path.join(this.cacheDir, e.hash), { recursive: true, force: true }).catch(() => {});
        this.entries.delete(e.hash);
        this.onMetric?.({ type: "evict", cc: this.cc, durationMs: 0 });
        total -= (sizes.get(e.hash) ?? 0);
      }
    } catch { /* 清理失败容错 */ }
  }

  get state(): Record<string, unknown> {
    return { cacheSize: this.entries.size };
  }

  /** 编译（增量：源码 sha256 命中跳过）→ binaryRef */
  async build(source: string): Promise<BuildResult> {
    const hash = sha256(source);
    const existing = this.entries.get(hash);
    if (existing) {
      existing.lastUsedAt = Date.now();
      // 磁盘存在性（持久缓存可能被外部清理——miss 则重编译）
      const exists = await fs.access(existing.binaryPath).then(() => true).catch(() => false);
      if (exists) {
        this.onMetric?.({ type: "cache-hit", cc: this.cc, durationMs: 0, cacheSize: this.entries.size });
        return { ok: true, binaryRef: hash, durationMs: 0 };
      }
      this.entries.delete(hash);
    }
    const start = Date.now();
    const dir = path.join(this.cacheDir, hash);
    await fs.mkdir(dir, { recursive: true });
    const sourcePath = path.join(dir, "main.c");
    const binaryPath = path.join(dir, "main");
    await fs.writeFile(sourcePath, source);
    const r = await exec(this.cc, ["-O2", "-o", binaryPath, sourcePath, "-lm"], this.compileTimeoutMs, dir);
    if (r.code !== 0) {
      // 失败不留空产物
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      return { ok: false, diagnostics: r.stderr.slice(0, 4000), durationMs: Date.now() - start };
    }
    this.entries.set(hash, { hash, binaryPath, sourcePath, lastUsedAt: Date.now() });
    this.evict();
    this.onMetric?.({ type: "compile", cc: this.cc, durationMs: Date.now() - start, cold: true, cacheSize: this.entries.size });
    void this.enforceDiskLimit();   // 写入后磁盘上限检查（异步——不阻塞响应）
    return { ok: true, binaryRef: hash, durationMs: Date.now() - start };
  }

  /** 运行二进制（binaryRef = build 返回的 hash） */
  async run(binaryRef: string, opts?: { args?: string[]; stdin?: string; timeoutMs?: number }): Promise<InterpreterResult> {
    const entry = this.entries.get(binaryRef);
    if (!entry) throw new Error(`unknown binaryRef: ${binaryRef}`);
    entry.lastUsedAt = Date.now();
    const start = Date.now();
    const timeoutMs = opts?.timeoutMs ?? this.runTimeoutMs;
    try {
      const r = await exec(entry.binaryPath, opts?.args ?? [], timeoutMs, path.dirname(entry.binaryPath));
      const ok = r.code === 0;
      return {
        ok,
        stdout: r.stdout,
        stderr: r.stderr,
        error: ok ? undefined : { message: r.stderr.slice(0, 2000) || `exit code ${r.code}` },
        durationMs: Date.now() - start,
        language: "c",
      };
    } catch (e) {
      return { ok: false, error: { message: (e as Error).message }, durationMs: Date.now() - start, language: "c" };
    }
  }

  /** execute：自动两阶段（增量编译 + 运行）——与解释类同一 Observation */
  async execute(source: string, opts?: ExecuteOptions): Promise<InterpreterResult> {
    const b = await this.build(source);
    if (!b.ok) {
      return {
        ok: false,
        error: { message: `编译失败：${(b.diagnostics ?? "").slice(0, 2000)}` },
        durationMs: b.durationMs,
        language: "c",
      };
    }
    const r = await this.run(b.binaryRef!, { timeoutMs: opts?.timeoutMs });
    return { ...r, language: "c" };
  }

  /** 清构建缓存 */
  reset(): void {
    this.entries.clear();
    // 持久缓存（独立 cacheDir）保留——只清编译运行工作区（默认同目录时行为不变）
    if (this.cacheDir.startsWith(this.workDir + path.sep)) {
      void fs.rm(this.cacheDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** 产物清单（文件即状态——refine 输入） */
  async snapshot(): Promise<InterpreterSnapshot> {
    const variables = [...this.entries.values()].map((e) => ({
      key: `binary:${e.hash}`,
      value: { binaryPath: e.binaryPath, lastUsedAt: e.lastUsedAt },
      serializable: true,
    }));
    return { variables, functions: [], oversized: [] };
  }

  dispose(): void {
    this.entries.clear();
  }

  /** LRU 淘汰（超上限删最久未用） */
  private evict(): void {
    while (this.entries.size > this.maxCache) {
      let oldest: CacheEntry | null = null;
      for (const e of this.entries.values()) {
        if (!oldest || e.lastUsedAt < oldest.lastUsedAt) oldest = e;
      }
      if (!oldest) break;
      this.entries.delete(oldest.hash);
      void fs.rm(path.dirname(oldest.binaryPath), { recursive: true, force: true }).catch(() => {});
    }
  }
}
