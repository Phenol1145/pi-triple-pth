/**
 * config-center.ts —— PTH 配置中心（配置集中化 C1，2026-08-16）。
 *
 * ConfigCenter 成为权威运行时注册表：
 *   - 启动即合并 env + schema 默认值（组件读取不再各自带默认值）；
 *   - snapshot 默认打码 secret（worker 的 perf.params() 不再可见密钥）；
 *   - set/on 保持原 SET 语义（runtime 键动态生效；重启失效）。
 *
 * 兼容面：kernel/extensions/perf-params.ts 自此 re-export 本模块（旧 import 面不破坏）。
 */

import { PTH_CONFIG_SCHEMA, getConfigDef, secretConfigKeys } from "./schema.js";
import { CONFIG_INSPECTION_MASK, type ConfigSource } from "../contracts/system-inspection.js";

export interface ConfigExplanation {
  /** default=构造期 env 缺失；env=构造期 env 命中；runtime=构造后 set；file/unknown 仅由可证明适配器显式提供 */
  source: ConfigSource;
  /** secret 键恒为 `***`；非 secret 键为当前有效值。 */
  value: string;
}

export interface ConfigCenter {
  /** 读参数（配置中心有效值优先，回退 env） */
  get(key: string): string | undefined;
  /** 运行时设置（SET 语义——通知监听者） */
  set(key: string, value: string): void;
  /** 全表快照（默认密钥打码——perf.params 数据源） */
  snapshot(includeSecrets?: boolean): Record<string, string>;
  /** 变更订阅（返回取消函数） */
  on(key: string, cb: (value: string | undefined) => void): () => void;
  /** N33 Task 3：解释键的来源与当前值（secret 恒打码；不保留历史；绝不从等值推断 source） */
  explain(key: string): ConfigExplanation;
}

const MASK = "***";

function effectiveValue(env: NodeJS.ProcessEnv, key: string, def: string | number | boolean | null): string {
  const raw = env[key];
  if (raw !== undefined) return raw;
  return def === null ? "" : String(def);
}

class Center implements ConfigCenter {
  private values = new Map<string, string>();
  private sources = new Map<string, ConfigSource>();
  private listeners = new Map<string, Set<(v: string | undefined) => void>>();
  private env: NodeJS.ProcessEnv;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.env = env;
    // 启动合并：全部 schema 键（env 优先，schema 默认值兜底）——单一真相源。
    // source 只由「构造期 env 是否命中」决定，绝不与 default 值比较。
    for (const def of PTH_CONFIG_SCHEMA) {
      const hasEnv = env[def.key] !== undefined;
      this.values.set(def.key, effectiveValue(env, def.key, def.default));
      this.sources.set(def.key, hasEnv ? "env" : "default");
    }
  }

  get(key: string): string | undefined {
    return this.values.get(key) ?? this.env[key];
  }

  set(key: string, value: string): void {
    this.values.set(key, value);
    this.sources.set(key, "runtime");
    this.listeners.get(key)?.forEach((cb) => cb(value));
  }

  explain(key: string): ConfigExplanation {
    const def = getConfigDef(key);
    const source = this.sources.get(key)
      ?? (this.env[key] !== undefined ? "env" : def ? "default" : "unknown");
    const value = def?.secret === true
      ? CONFIG_INSPECTION_MASK
      : (this.values.get(key) ?? this.env[key] ?? "");
    return { source, value };
  }

  snapshot(includeSecrets = false): Record<string, string> {
    const secrets = new Set(secretConfigKeys());
    const out: Record<string, string> = {};
    for (const key of [...this.values.keys()].sort((a, b) => a.localeCompare(b))) {
      out[key] = !includeSecrets && secrets.has(key) ? MASK : (this.values.get(key) ?? "");
    }
    return out;
  }

  on(key: string, cb: (value: string | undefined) => void): () => void {
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

/** 配置中心单例（首次调用以当前 env 初始化——主进程 / batch 子进程各自一份） */
export function config(): ConfigCenter {
  if (!singleton) singleton = new Center();
  return singleton;
}

/** 测试/重置用：重建单例（注入 env） */
export function resetConfig(env?: NodeJS.ProcessEnv): ConfigCenter {
  singleton = new Center(env ?? process.env);
  return singleton;
}

/** 数值参数读取（NaN 防御——schema 默认值兜底；fallback 为 schema 缺失时的最后回退） */
export function configNumber(key: string, fallback: number): number {
  const v = config().get(key);
  if (v === undefined || v === "") {
    const def = getConfigDef(key)?.default;
    if (typeof def === "number") return def;
    return fallback;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : (typeof getConfigDef(key)?.default === "number" ? (getConfigDef(key)!.default as number) : fallback);
}

// ── typed accessors（组件唯一读入口——配置集中化 C2）────────────────

export class PthConfig {
  /** 可选固定 center（校验/导出用 env 临时注册表）；缺省每次访问动态取当前 center */
  constructor(private centerOverride?: ConfigCenter) {}

  private get center(): ConfigCenter {
    return this.centerOverride ?? config();
  }

  /** 字符串读取（schema 默认值兜底；未注册键回退 ""） */
  str(key: string): string {
    const v = this.center.get(key);
    if (v !== undefined && v !== "") return v;
    const def = getConfigDef(key)?.default;
    return def === null || def === undefined ? (v ?? "") : String(def);
  }

  /** 原始 env 值（不含 schema 默认——用于“未配置”即错误的 fail-closed 语义） */
  env(key: string): string | undefined {
    return process.env[key];
  }

  /** 数值读取（NaN → schema 默认 → fallback） */
  num(key: string, fallback?: number): number {
    const raw = this.str(key);
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
    const def = getConfigDef(key)?.default;
    if (typeof def === "number") return def;
    return fallback ?? Number(def ?? 0);
  }

  /** 布尔读取（"1"/"true"/"on"） */
  flag(key: string): boolean {
    const v = this.str(key).toLowerCase();
    return v === "1" || v === "true" || v === "on";
  }

  /** 开关读取：off/0/false 以外视为启用（与旧 `!== "off"` / `!== "0"` 语义兼容） */
  enabled(key: string): boolean {
    const v = this.str(key).trim().toLowerCase();
    return v !== "off" && v !== "0" && v !== "false" && v !== "";
  }

  /** 逗号列表读取 */
  list(key: string): string[] {
    return this.str(key).split(",").map((s) => s.trim()).filter(Boolean);
  }
}

let pthConfigSingleton: PthConfig | null = null;

/** typed 访问器单例（不绑定具体 center——resetConfig 后自动跟随新注册表） */
export function pthConfig(): PthConfig {
  if (!pthConfigSingleton) pthConfigSingleton = new PthConfig();
  return pthConfigSingleton;
}

export function resetPthConfig(env?: NodeJS.ProcessEnv): PthConfig {
  resetConfig(env);
  pthConfigSingleton = null;
  return pthConfig();
}

// ── 校验 / 迁移通道 ────────────────────────────────────────────────

export interface ConfigIssue {
  key: string;
  level: "error" | "warn";
  message: string;
}

/** 启动校验：生产严格模式（PTH_CONFIG_STRICT=1）下开发默认值/弱密钥 fail-fast */
export function validatePthConfig(env: NodeJS.ProcessEnv = process.env): ConfigIssue[] {
  const strict = env.PTH_CONFIG_STRICT === "1" || env.NODE_ENV === "production";
  const issues: ConfigIssue[] = [];
  const cfg = new PthConfig(new Center(env));

  // N29：知识摄入模式只允许 off|draft|full；非法值 fail-fast（与 strict 无关）。
  const intakeMode = cfg.str("PTH_KNOWLEDGE_INTAKE_MODE").trim().toLowerCase();
  if (!["off", "draft", "full"].includes(intakeMode)) {
    issues.push({
      key: "PTH_KNOWLEDGE_INTAKE_MODE",
      level: "error",
      message: `PTH_KNOWLEDGE_INTAKE_MODE 只能是 off|draft|full（当前: ${cfg.str("PTH_KNOWLEDGE_INTAKE_MODE")}）`,
    });
  }

  const secretLen = (key: string, min = 16) => {
    const v = cfg.str(key);
    if (strict && v !== "" && v.length < min) {
      issues.push({ key, level: "error", message: `${key} 长度 < ${min}（生产弱密钥拒绝）` });
    }
  };
  secretLen("PTH_EXECUTION_GRANT_SECRET", 32);
  secretLen("SANDBOX_SHARED_SECRET", 16);
  secretLen("PTH_MEMORY_BRIDGE_TOKEN", 16);

  if (strict) {
    // PTH_TOKEN 是客户端/CLI 凭据；仅当显式设成开发默认值时报错（server 端不消费该 env）
    if (env.PTH_TOKEN === "test-token-123") {
      issues.push({ key: "PTH_TOKEN", level: "error", message: "生产环境不得显式使用开发默认 token test-token-123" });
    }
    if (cfg.str("REDIS_PASSWORD") === "") {
      issues.push({ key: "REDIS_PASSWORD", level: "error", message: "生产环境 REDIS_PASSWORD 必填（redis AUTH）" });
    }
    if (cfg.str("POSTGRES_PASSWORD") === "") {
      issues.push({ key: "POSTGRES_PASSWORD", level: "error", message: "生产环境 POSTGRES_PASSWORD 必填" });
    }
  }
  return issues;
}

/** PTL 信息迁移通道：输出 ptl config set 命令（token 默认打码，includeToken 显式开启） */
export function exportPtlMigration(env: NodeJS.ProcessEnv = process.env, includeToken = false): string[] {
  const cfg = new PthConfig(new Center(env));
  const url = cfg.str("PTH_URL") || cfg.str("PTH_API");
  const token = cfg.str("PTH_TOKEN");
  const out = [
    `ptl config set pth.url ${url}`,
    includeToken && token ? `ptl config set pth.token ${token}` : `# ptl config set pth.token <PTH_TOKEN>（密钥未导出——手动填入）`,
  ];
  return out;
}
