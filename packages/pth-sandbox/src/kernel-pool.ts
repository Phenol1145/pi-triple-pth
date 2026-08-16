/**
 * kernel-pool.ts —— sandbox 侧共享 kernel 池（kernel sandbox SPEC §3.2）
 *
 * 职责：托管持久 PyKernel/BashKernel 进程，供多个 batch/worker 复用。
 *   - acquire：发放一次性 SandboxLease（空闲条目复用、容量内新建、满则 FIFO 排队）
 *   - execute/reset/snapshot/release：校验 lease id+generation 后转发（P0-4）
 *   - release：同一 lease 幂等；旧/不同 lease 一律拒绝
 *   - entry TTL 到期：active → cancelling/disposed，销毁进程并把条目移出池，
 *     绝不在旧 owner 可能仍在执行时标 idle 或复用
 *   - status：inFlight/idle/capacity 报告（不含可预测 kernel ID）
 *
 * 安全边界：本池不注入任何业务密钥（协议层无 env 字段——敏感信息约束 §4.5）。
 */

import { randomUUID } from "node:crypto";
import { PyKernel } from "./py-kernel.js";
import { BashKernel } from "./bash-kernel.js";
import type { SandboxLease, LeaseState } from "./kernel-lease.js";
import type { ExecuteOptions, Interpreter, InterpreterResult, InterpreterSnapshot } from "./kernel/interpreter/types.js";

export type KernelLang = "python" | "bash";

interface PoolEntry {
  /** 池内部 ID（绝不外发） */
  internalId: string;
  kernel: Interpreter;
  lease: SandboxLease | null;
  state: LeaseState;
  lastUsedAt: number;
}

interface Waiter {
  resolve: (lease: SandboxLease) => void;
  reject: (err: Error) => void;
  /** 排队超时计时器（PTH_KERNEL_ACQUIRE_TIMEOUT_MS——超时拒绝防池满无限卡） */
  timer: NodeJS.Timeout;
}

export interface KernelPoolOptions {
  lang: KernelLang;
  /** 池容量上限（默认 4） */
  max?: number;
  /** 空闲回收 ms（默认 0=宿主自行管理；>0 转给内核空闲回收） */
  idleMs?: number;
  /** acquire 排队超时 ms（默认 60s——池满超时拒绝防无限卡） */
  acquireTimeoutMs?: number;
  /** 池条目 TTL ms（active 超时强制回收——batch 崩溃泄漏兜底；0=关闭） */
  entryTtlMsMs?: number;
  onStderr?: (lang: string, line: string) => void;
  /** 时钟注入（测试） */
  clock?: () => number;
}

export class KernelPool {
  readonly lang: KernelLang;
  private entries: PoolEntry[] = [];
  private waiters: Waiter[] = [];
  private max: number;
  private idleMs: number;
  private onStderr?: (lang: string, line: string) => void;
  /** 池条目 TTL（active 超时强制回收——batch 崩溃未 release 的泄漏兜底；0=关闭） */
  private entryTtlMs: number;
  private acquireTimeoutMs: number;
  private clock: () => number;
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(opts: KernelPoolOptions) {
    this.lang = opts.lang;
    this.max = opts.max ?? 4;
    this.idleMs = opts.idleMs ?? 0;
    this.onStderr = opts.onStderr;
    this.entryTtlMs = opts.entryTtlMsMs ?? 0;
    this.acquireTimeoutMs = opts.acquireTimeoutMs ?? 60_000;
    this.clock = opts.clock ?? (() => Date.now());
    if (this.entryTtlMs > 0) {
      this.sweepTimer = setInterval(() => this.sweep(), Math.min(this.entryTtlMs, 60_000));
      this.sweepTimer.unref?.();
    }
  }

  /** 回收超时 active 条目（崩溃泄漏兜底）：先销毁进程，再移出池——绝不标 idle 复用 */
  private sweep(): void {
    const now = this.clock();
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i]!;
      if (e.state === "active" && e.lease && now - e.lastUsedAt > this.entryTtlMs) {
        this.disposeEntry(e);
      }
    }
    this.wakeWaiterIfPossible();
  }

  /** 测试/宿主显式触发 sweep（不等待定时器） */
  sweepForTest(): void {
    this.sweep();
  }

  private disposeEntry(e: PoolEntry): void {
    e.state = "cancelling";
    try { e.kernel.dispose(); } catch { /* 容错 */ }
    e.state = "disposed";
    e.lease = null;
    const i = this.entries.indexOf(e);
    if (i >= 0) this.entries.splice(i, 1);
  }

  private findByLease(leaseId: string): PoolEntry | undefined {
    return this.entries.find((e) => e.lease?.id === leaseId);
  }

  private makeLease(): SandboxLease {
    const ttl = this.entryTtlMs > 0 ? this.entryTtlMs : 24 * 60 * 60 * 1000;
    return { id: randomUUID(), generation: 1, expiresAt: new Date(this.clock() + ttl).toISOString() };
  }

  private createKernel(): Interpreter {
    if (this.lang === "python") {
      return new PyKernel({ lazySpawn: true, resetMode: "ns", idleMs: this.idleMs, onStderr: (l) => this.onStderr?.(this.lang, l) });
    }
    return new BashKernel({ lazySpawn: true, idleMs: this.idleMs, onStderr: (l) => this.onStderr?.(this.lang, l) });
  }

  private tryAcquireNow(): SandboxLease | null {
    const idle = this.entries.find((e) => e.state === "idle" && e.lease === null);
    if (idle) {
      const lease = this.makeLease();
      idle.lease = lease;
      idle.state = "active";
      idle.lastUsedAt = this.clock();
      return lease;
    }
    if (this.entries.length < this.max) {
      const entry: PoolEntry = {
        internalId: randomUUID(),
        kernel: this.createKernel(),
        lease: this.makeLease(),
        state: "active",
        lastUsedAt: this.clock(),
      };
      this.entries.push(entry);
      return entry.lease;
    }
    return null;
  }

  private wakeWaiterIfPossible(): void {
    while (this.waiters.length > 0) {
      const lease = this.tryAcquireNow();
      if (!lease) return;
      const waiter = this.waiters.shift()!;
      clearTimeout(waiter.timer);
      waiter.resolve(lease);
    }
  }

  /** 获取一个 kernel lease（空闲优先；容量内新建；满则 FIFO 排队——排队超时拒绝） */
  acquire(): Promise<SandboxLease> {
    const lease = this.tryAcquireNow();
    if (lease) return Promise.resolve(lease);
    return new Promise<SandboxLease>((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error(`kernel pool exhausted (${this.lang} ${this.max}/${this.max}) — acquire timeout`));
      }, this.acquireTimeoutMs);
      const waiter: Waiter = { resolve, reject, timer };
      this.waiters.push(waiter);
    });
  }

  private requireActive(lease: SandboxLease): PoolEntry {
    const entry = this.findByLease(lease.id);
    if (!entry) throw new Error("stale lease: unknown lease id");
    if (entry.state !== "active" || entry.lease?.generation !== lease.generation) {
      throw new Error("stale lease: generation mismatch or lease no longer active");
    }
    return entry;
  }

  /** 归还 kernel（唤醒 FIFO 排队者）。同一 lease 幂等；不同/旧 lease 拒绝。
   *  P2-3：只接受 active 归还；cancelling/disposed 一律拒绝——绝不把可能仍在执行的条目乐观标 idle。 */
  release(lease: SandboxLease): void {
    const entry = this.findByLease(lease.id);
    if (!entry || entry.lease?.generation !== lease.generation) {
      throw new Error("stale lease: unknown lease id");
    }
    if (entry.state === "idle") return; // 幂等：同 lease 重复 release 无副作用
    if (entry.state !== "active") {
      throw new Error("stale lease: lease no longer active（cancelling/disposed 不可乐观释放）");
    }
    entry.lease = null;
    entry.state = "idle";
    entry.lastUsedAt = this.clock();
    this.wakeWaiterIfPossible();
  }

  /** P2-3：取消在飞执行 → 等 kernel abort 落地（ack）→ 销毁条目移出池。
   *  取消请求不可达/abort 失败也保持 cancelling→disposed，绝不复用该条目。 */
  async cancel(lease: SandboxLease): Promise<void> {
    const entry = this.findByLease(lease.id);
    if (!entry || entry.lease?.generation !== lease.generation) {
      throw new Error("stale lease: unknown lease id");
    }
    if (entry.state === "cancelling") return; // 幂等：已在取消中
    if (entry.state !== "active") {
      throw new Error("stale lease: lease no longer active");
    }
    entry.state = "cancelling";
    try {
      if (entry.kernel.abort) await entry.kernel.abort();
    } finally {
      entry.state = "disposed";
      entry.lease = null;
      const i = this.entries.indexOf(entry);
      if (i >= 0) this.entries.splice(i, 1);
      this.wakeWaiterIfPossible();
    }
  }

  async execute(lease: SandboxLease, code: string, opts?: ExecuteOptions): Promise<InterpreterResult> {
    const entry = this.requireActive(lease);
    entry.lastUsedAt = this.clock();
    return entry.kernel.execute(code, opts);
  }

  async reset(lease: SandboxLease): Promise<void> {
    const entry = this.requireActive(lease);
    entry.lastUsedAt = this.clock();
    entry.kernel.reset();
  }

  async snapshot(lease: SandboxLease): Promise<InterpreterSnapshot> {
    const entry = this.requireActive(lease);
    entry.lastUsedAt = this.clock();
    return entry.kernel.snapshot();
  }

  status(): { lang: KernelLang; inFlight: number; idle: number; size: number; capacity: number } {
    return {
      lang: this.lang,
      inFlight: this.entries.filter((e) => e.state === "active").length,
      idle: this.entries.filter((e) => e.state === "idle").length,
      size: this.entries.length,
      capacity: this.max,
    };
  }

  /** 销毁全部 kernel（宿主关闭时） */
  async dispose(): Promise<void> {
    for (const e of this.entries) {
      try {
        e.kernel.dispose();
      } catch {
        /* 忽略单核销毁错误 */
      }
    }
    this.entries = [];
    this.waiters = [];
  }
}
