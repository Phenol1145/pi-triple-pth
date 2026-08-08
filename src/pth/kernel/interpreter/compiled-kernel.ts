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
  /** 工作区根（缓存目录 <root>/.build-cache/<lang>/） */
  workDir: string;
  /** 编译器命令（默认 cc——gcc/clang 兼容） */
  cc?: string;
  /** 编译超时 ms（默认 120s） */
  compileTimeoutMs?: number;
  /** 运行超时 ms（默认 30s） */
  runTimeoutMs?: number;
  /** 缓存二进制上限（默认 50——LRU 淘汰） */
  maxCache?: number;
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
  private entries: Map<string, CacheEntry> = new Map(); // hash → entry

  constructor(opts: CompiledKernelOptions) {
    this.workDir = opts.workDir;
    this.cacheDir = path.join(opts.workDir, ".build-cache", "c");
    this.cc = opts.cc ?? "cc";
    this.compileTimeoutMs = opts.compileTimeoutMs ?? 120_000;
    this.runTimeoutMs = opts.runTimeoutMs ?? 30_000;
    this.maxCache = opts.maxCache ?? 50;
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
      return { ok: true, binaryRef: hash, durationMs: 0 };
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
    void fs.rm(this.cacheDir, { recursive: true, force: true }).catch(() => {});
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
