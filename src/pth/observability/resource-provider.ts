/**
 * resource-provider.ts — 跨 OS 资源计量抽象（性能计量 SPEC L0-T1）
 *
 * 不同 OS 具体实现不同（macOS 无 nvidia-smi、Linux 有 /proc、容器有 docker stats）——
 * 接口先定义，实现按环境选择。prom-client 只消费 collect() 返回。
 *
 * 实现矩阵：
 *   darwin          —— process.memoryUsage + os.cpus 差值（GPU N/A）
 *   linux           —— process.memoryUsage + os.cpus 差值（/proc 留 v2）
 *   linux-container —— 同 linux（docker stats 留 v2）
 *   nvidia          —— GPU 用 nvidia-smi（无则 N/A）
 */

import os from "node:os";
import { pthConfig } from "../config/index.js";

export interface CpuSnapshot {
  usagePercent: number;
  userSeconds: number;
  systemSeconds: number;
}

export interface MemorySnapshot {
  rssBytes: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
}

export interface GpuSnapshot {
  available: boolean;
  utilizationPercent?: number;
  memoryBytes?: number;
}

export interface NetworkSnapshot {
  connType: "pg" | "redis" | "llm" | "other";
  rxBytes: number;
  txBytes: number;
  active: number;
}

export interface ResourceSnapshot {
  cpu: CpuSnapshot;
  memory: MemorySnapshot;
  gpu: GpuSnapshot;
  network: NetworkSnapshot[];
}

export interface ResourceProvider {
  readonly platform: string;
  collect(): Promise<ResourceSnapshot>;
  start(intervalMs?: number): void;
  stop(): void;
}

export interface ResourceProviderOptions {
  platform?: string;        // 强制指定（测试）
  container?: boolean;      // docker stats 模式（v2）
  nvidia?: boolean;         // nvidia-smi 模式
}

function detectPlatform(): string {
  return pthConfig().str("PTH_PLATFORM") || os.platform();
}

function collectMemory(): MemorySnapshot {
  const m = process.memoryUsage();
  return {
    rssBytes: m.rss,
    heapUsed: m.heapUsed,
    heapTotal: m.heapTotal,
    external: m.external,
  };
}

/** CPU%：两次 os.cpus 采样差值（users+system 时间片增量 / 墙钟增量） */
class CpuSampler {
  private lastTimes: { user: number; system: number } | null = null;
  private lastWall = 0;

  sample(): CpuSnapshot {
    const cpus = os.cpus();
    let user = 0, system = 0;
    for (const c of cpus) { user += c.times.user; system += c.times.sys; }
    const wall = Date.now();
    const usagePercent = this.lastTimes && this.lastWall
      ? ((user - this.lastTimes.user + system - this.lastTimes.system) / (wall - this.lastWall)) * 100
      : 0;
    this.lastTimes = { user, system };
    this.lastWall = wall;
    return {
      usagePercent: Math.min(usagePercent, 100 * cpus.length),  // 上限：多核 100%×N
      userSeconds: user / 100,
      systemSeconds: system / 100,
    };
  }
}

class BaseProvider implements ResourceProvider {
  readonly platform: string;
  protected cpuSampler = new CpuSampler();
  private timer: ReturnType<typeof setInterval> | null = null;
  private onSample?: (snap: ResourceSnapshot) => void;

  constructor(platform: string, onSample?: (snap: ResourceSnapshot) => void) {
    this.platform = platform;
    this.onSample = onSample;
  }

  async collect(): Promise<ResourceSnapshot> {
    return {
      cpu: this.cpuSampler.sample(),
      memory: collectMemory(),
      gpu: await this.gpu(),
      network: await this.network(),
    };
  }

  protected async gpu(): Promise<GpuSnapshot> {
    return { available: false };   // 默认 N/A（darwin/linux 无 Node GPU API）
  }

  protected async network(): Promise<NetworkSnapshot[]> {
    // v1：连接数由各组件上报（pg/redis/llm）；此处返回空——连接计量在 metrics 层组装
    return [];
  }

  start(intervalMs = 5_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.collect().then((snap) => this.onSample?.(snap)).catch(() => {});
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}

class NvidiaProvider extends BaseProvider {
  protected async gpu(): Promise<GpuSnapshot> {
    // nvidia-smi 解析（无则 N/A）
    try {
      const { execSync } = await import("node:child_process");
      const out = execSync("nvidia-smi --query-gpu=utilization.gpu,memory.used --format=csv,noheader,nounits", {
        timeout: 2000,
        stdio: ["ignore", "pipe", "ignore"],
      }).toString().trim();
      const [util, mem] = out.split(",").map((s) => parseFloat(s.trim()));
      if (Number.isFinite(util)) {
        return { available: true, utilizationPercent: util, memoryBytes: mem * 1024 * 1024 };
      }
    } catch { /* nvidia-smi 不可用 */ }
    return { available: false };
  }
}

/** 按环境创建 provider（env 可覆盖；测试可强制 platform） */
export function createResourceProvider(opts: ResourceProviderOptions = {}): ResourceProvider {
  const platform = opts.platform ?? detectPlatform();
  const onSample = opts.container ? undefined : undefined;
  void onSample;
  if (opts.nvidia) return new NvidiaProvider(platform);
  return new BaseProvider(platform);
}
