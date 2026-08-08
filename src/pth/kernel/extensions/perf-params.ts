/**
 * perf-params.ts —— 配置中心（PTH 参数运行时可调——仿 PG SET 语义）。
 *
 * 设计（标准扩展包 SPEC Phase 2）：
 *   - 启动时从 env 快照加载参数表
 *   - 运行时 perf.set 改写内存值（SET——重启失效；ALTER SYSTEM 持久化 v2）
 *   - 组件读参数改走配置中心（get）——动态生效
 *   - 变更订阅（on）——需要响应式更新的组件注册监听
 *
 * 单例：主进程与 batch 各自实例化（env 初始化同源）；跨进程同步 v2（IPC）
 */

export interface ConfigCenter {
  /** 读参数（优先配置中心内存值，回退 env） */
  get(key: string): string | undefined;
  /** 运行时设置（SET 语义——通知监听者） */
  set(key: string, value: string): void;
  /** 全表快照（perf.params 数据源） */
  snapshot(): Record<string, string>;
  /** 变更订阅（返回取消函数） */
  on(key: string, cb: (value: string | undefined) => void): () => void;
}

class Center implements ConfigCenter {
  private values = new Map<string, string>();
  private listeners = new Map<string, Set<(v: string | undefined) => void>>();
  private env: NodeJS.ProcessEnv;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.env = env;
    // 启动快照：PTH_* 参数全部载入（env 变化不影响已载入值）
    for (const [k, v] of Object.entries(env)) {
      if (k.startsWith("PTH_") && v !== undefined) this.values.set(k, v);
    }
  }

  get(key: string): string | undefined {
    return this.values.get(key) ?? this.env[key];
  }

  set(key: string, value: string): void {
    this.values.set(key, value);
    this.listeners.get(key)?.forEach((cb) => cb(value));
  }

  snapshot(): Record<string, string> {
    return Object.fromEntries([...this.values.entries()].sort((a, b) => a[0].localeCompare(b[0])));
  }

  on(key: string, cb: (v: string | undefined) => void): () => void {
    let set = this.listeners.get(key);
    if (!set) {
      set = new Set();
      this.listeners.set(key, set);
    }
    set.add(cb);
    return () => set!.delete(cb);
  }
}

let singleton: ConfigCenter | null = null;

/** 获取配置中心单例（首次调用时以当前 env 初始化） */
export function config(): ConfigCenter {
  if (!singleton) singleton = new Center();
  return singleton;
}

/** 测试/重置用：重建单例（注入 env） */
export function resetConfig(env?: NodeJS.ProcessEnv): ConfigCenter {
  singleton = new Center(env ?? process.env);
  return singleton;
}

/** 数值参数读取（NaN 防御——仿 kernel-config 模式） */
export function configNumber(key: string, fallback: number): number {
  const v = config().get(key);
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
