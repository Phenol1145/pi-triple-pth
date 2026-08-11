/**
 * cache-store —— 随身缓存（ASP v2——2026-08-10）。
 *
 * 定位：元空间级状态（行李）——随 asp.cd 携带，任何空间可编程访问。
 * 与各空间本地状态（ts 变量/python globals）严格区分：本地状态 cd 即留下，缓存不留下。
 *
 * 硬性容量限制（用户裁决）：双上限——字符总量 + 条目数。
 * load 超容即拒绝（报错引导 cache.cancel 腾位）——容量管理是 AI 的显式职责
 * （背包约束：迫使对信息价值做判断，防无限囤积）。
 *
 * 生命周期：任务级（task-loop 每任务创建——任务结束随会话消亡；要持久化走 memory.save）。
 */

import { configNumber } from "../extensions/perf-params.js";

export interface CacheEntry {
  key: string;
  content: string;
  chars: number;
  loadedAt: number;
  /** 来源（记忆条目 id / 自定义键） */
  source: string;
}

export class CacheStore {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly maxChars: number;
  private readonly maxEntries: number;

  constructor(opts?: { maxChars?: number; maxEntries?: number }) {
    this.maxChars = opts?.maxChars ?? configNumber("PTH_CACHE_MAX_CHARS", 16 * 1024);
    this.maxEntries = opts?.maxEntries ?? configNumber("PTH_CACHE_MAX_ENTRIES", 20);
  }

  private get usedChars(): number {
    let n = 0;
    for (const e of this.entries.values()) n += e.chars;
    return n;
  }

  /** 载入（硬性容量——超容拒绝并引导 cancel） */
  load(key: string, content: string, source: string): { ok: true } | { ok: false; reason: string } {
    if (this.entries.has(key)) {
      // 同键覆盖——先释放旧占用再校验
      this.entries.delete(key);
    }
    const chars = content.length;
    if (chars > this.maxChars) {
      return { ok: false, reason: `cache.load: 条目 "${key}"（${chars} 字符）超过缓存总容量（${this.maxChars}）——单条目都装不下` };
    }
    if (!this.entries.has(key) && this.entries.size >= this.maxEntries) {
      return { ok: false, reason: `cache.load: 条目数达上限（${this.maxEntries}）——先 cache.cancel 释放（cache.index 查看）` };
    }
    if (this.usedChars + chars > this.maxChars) {
      return { ok: false, reason: `cache.load: 容量不足（已用 ${this.usedChars}/${this.maxChars} 字符，需 ${chars}）——先 cache.cancel 腾位（cache.index 查看占用）` };
    }
    this.entries.set(key, { key, content, chars, loadedAt: Date.now(), source });
    return { ok: true };
  }

  get(key: string): string | undefined {
    return this.entries.get(key)?.content;
  }

  cancel(key: string): boolean {
    return this.entries.delete(key);
  }

  /** 自检视图（键/大小/余量） */
  index(): string {
    const lines = [...this.entries.values()].map((e) => `${e.key}  ${e.chars}c  ← ${e.source}`);
    return `【随身缓存】${this.entries.size}/${this.maxEntries} 条目 · ${this.usedChars}/${this.maxChars} 字符\n${lines.join("\n") || "（空——cache.load 载入）"}`;
  }

  keys(): string[] {
    return [...this.entries.keys()];
  }
}
