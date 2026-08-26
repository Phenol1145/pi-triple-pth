/**
 * pit-providers — ProviderManager
 *
 * Key 池 CRUD + auth.json 持久化 + 旧格式迁移 + 泄漏清理。
 *
 * 路径：process.env.PI_CODING_AGENT_DIR/auth.json
 * 格式：{type:"oauth", access, refresh: JSON.stringify(pool), expires: FAR_FUTURE}
 *      与 ustc-llm 字节级兼容。
 *
 * PI_CODING_AGENT_DIR 未设置时 fail-closed（不读写，getApiKey 仅 env 兜底）。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  makeKeyPool,
  generateId,
  getNextAvailableKey,
} from "./keypool.js";
import type { KeyPool, KeyEntry, ProviderDef } from "./types.js";
import type { KeyManager as UstcKeyManager } from "./types.js";

/** OAuth 凭据过期时间戳（永不过期，与 ustc-llm 一致） */
const FAR_FUTURE = 9999999999999;

/** OAuth 凭据在 auth.json 中的存储格式 */
interface OAuthCredential {
  type: "oauth" | "api_key";
  access?: string;
  key?: string;
  refresh?: string;
  expires?: number;
}

/** auth.json 整体结构：providerId → OAuthCredential */
interface AuthFile {
  [providerId: string]: OAuthCredential;
}

export class ProviderManager {
  readonly id: string;
  readonly alias: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly api: string;
  readonly apiKeyEnv?: string;
  readonly multiKey: boolean;
  readonly def: ProviderDef;

  private cachedPool: KeyPool | null = null;

  constructor(def: ProviderDef) {
    this.def = def;
    this.id = def.id;
    this.alias = def.alias?.[0] ?? def.id;
    this.name = def.name;
    this.baseUrl = def.baseUrl;
    this.api = def.api;
    this.apiKeyEnv = def.apiKeyEnv;
    this.multiKey = def.multiKey;
  }

  // ── 路径 ──────────────────────────────────────────────────

  /** auth.json 路径。PI_CODING_AGENT_DIR 未设置时返回 null（fail-closed）。 */
  authPath(): string | null {
    const dir = process.env.PI_CODING_AGENT_DIR;
    if (!dir) return null;
    return path.join(dir, "auth.json");
  }

  /** 旧共享宿主路径（ustc-llm 硬编码的 ~/.pi/agent/auth.json，迁移源） */
  private hostAuthPath(): string {
    return path.join(os.homedir(), ".pi", "agent", "auth.json");
  }

  // ── 读 ────────────────────────────────────────────────────

  /** 从 auth.json 加载 Key 池（带内存缓存）。失败回退空池。 */
  loadPool(): KeyPool {
    if (this.cachedPool) return this.cachedPool;
    const ap = this.authPath();
    if (!ap) {
      this.cachedPool = makeKeyPool();
      return this.cachedPool;
    }
    try {
      const raw = fs.readFileSync(ap, "utf-8");
      const auth = JSON.parse(raw) as AuthFile;
      const cred = auth[this.id];
      if (cred?.refresh) {
        this.cachedPool = JSON.parse(cred.refresh) as KeyPool;
        return this.cachedPool;
      }
    } catch {
      // auth.json 不存在或无凭据 → 空池
    }
    this.cachedPool = makeKeyPool();
    return this.cachedPool;
  }

  // ── 写 ────────────────────────────────────────────────────

  /** 持久化 Key 池到 auth.json。更新缓存。失败静默。 */
  savePool(pool: KeyPool): void {
    this.cachedPool = pool;
    const ap = this.authPath();
    if (!ap) return;  // fail-closed

    try {
      let auth: AuthFile = {};

      if (fs.existsSync(ap)) {
        const raw = fs.readFileSync(ap, "utf-8");
        auth = JSON.parse(raw) as AuthFile;
      }

      const activeKey = getNextAvailableKey(pool);
      auth[this.id] = {
        type: "oauth",
        access: activeKey?.key ?? "",
        refresh: JSON.stringify(pool),
        expires: FAR_FUTURE,
      };

      fs.writeFileSync(ap, JSON.stringify(auth, null, 2), { mode: 0o600 });
    } catch {
      // 静默失败，下次 login 会重建
    }
  }

  // ── 迁移 ──────────────────────────────────────────────────

  /**
   * 一次性迁移：从宿主 ~/.pi/agent/auth.json 快照拷贝 Key 池到租户 auth.json，
   * 然后删除源文件中的该 provider 条目（泄漏清理）。
   *
   * 返回值：true = 执行了迁移（或至少尝试），false = 无需迁移。
   */
  migrateLegacy(): boolean {
    if (!this.multiKey) return false;

    const ap = this.authPath();
    if (!ap) return false;  // fail-closed

    // 租户 auth.json 已有凭据 → 不覆盖
    try {
      const existing = JSON.parse(fs.readFileSync(ap, "utf-8")) as AuthFile;
      if (existing[this.id]?.refresh) return false;
    } catch {
      // 租户 auth.json 不存在 → 继续迁移
    }

    const hostPath = this.hostAuthPath();
    if (!fs.existsSync(hostPath)) return false;

    let hostAuth: AuthFile;
    try {
      hostAuth = JSON.parse(fs.readFileSync(hostPath, "utf-8")) as AuthFile;
    } catch {
      return false;
    }

    const cred = hostAuth[this.id];
    if (!cred) return false;  // 宿主也无该 provider

    // 解析 Key 池（与 loadPool 同一逻辑）
    let pool: KeyPool = makeKeyPool();
    if (cred.refresh) {
      pool = JSON.parse(cred.refresh) as KeyPool;
    } else if (cred.access && cred.access.length > 10) {
      // 有 access 无 refresh（旧格式 /login）
      const entry: KeyEntry = {
        id: generateId(),
        alias: "默认",
        key: cred.access,
        failed: false,
      };
      pool.keys.push(entry);
      pool.activeId = entry.id;
    } else if (cred.key && cred.key.length > 10) {
      // type: "api_key" 格式（Pi 默认 /login 存储）
      const entry: KeyEntry = {
        id: generateId(),
        alias: "默认",
        key: cred.key,
        failed: false,
      };
      pool.keys.push(entry);
      pool.activeId = entry.id;
    }

    if (pool.keys.length === 0) return false;  // 无效凭据

    // 快照写入租户 auth.json
    this.savePool(pool);

    // 泄漏清理：从宿主 auth.json 删除该 provider 条目
    try {
      delete hostAuth[this.id];
      if (Object.keys(hostAuth).length > 0) {
        fs.writeFileSync(hostPath, JSON.stringify(hostAuth, null, 2), { mode: 0o600 });
      } else {
        // 空文件 → 删除（避免遗留空 JSON）
        fs.unlinkSync(hostPath);
      }
    } catch {
      // 清理失败不阻塞（Key 已经在租户侧）
    }

    return true;
  }

  /**
   * 在现有池中填充旧格式 Key（不依赖宿主文件）。
   * 用于 loadPool 后增强：如果池为空但 access 直接来自 credential。
   */
  ingestLegacyCredential(cred: OAuthCredential): boolean {
    const pool = this.loadPool();
    if (pool.keys.length > 0) return false;

    if (cred.refresh) {
      // 已有 refresh → loadPool 已经处理，不重复
      return false;
    }

    let entry: KeyEntry | null = null;
    if (cred.access && cred.access.length > 10) {
      entry = {
        id: generateId(),
        alias: "默认",
        key: cred.access,
        failed: false,
      };
    } else if (cred.key && cred.key.length > 10) {
      entry = {
        id: generateId(),
        alias: "默认",
        key: cred.key,
        failed: false,
      };
    }

    if (!entry) return false;

    pool.keys.push(entry);
    pool.activeId = entry.id;
    this.savePool(pool);
    return true;
  }

  // ── API Key 获取 ──────────────────────────────────────────

  /**
   * 获取当前可用 API Key：
   *   multiKey: getNextAvailableKey → 空池回退 env
   *   单 Key:   process.env[apiKeyEnv]
   */
  getApiKey(): string {
    if (this.multiKey) {
      const pool = this.loadPool();
      const key = getNextAvailableKey(pool);
      if (key) return key.key;
    }
    // 空池兜底：环境变量
    if (this.apiKeyEnv) {
      return process.env[this.apiKeyEnv] ?? "";
    }
    return "";
  }
}
