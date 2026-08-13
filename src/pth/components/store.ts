/**
 * components/store.ts — ComponentStore（构件存储，ProgramStore 泛化，F/WP4 Task 17）
 *
 * 文件布局: DATA_DIR/components/<tenantId>/<type>/<name>/<version>/
 * Redis keys:
 *   components:<tenantId>:<type>                       Set of component names
 *   component:<tenantId>:<type>:<name>:latest          Integer (latest version)
 *   component:<tenantId>:<type>:<name>:updatedAt       Integer (ms epoch)
 *   component:<tenantId>:<type>:<name>:<N>             JSON manifest
 *   component:<tenantId>:<type>:<name>:<N>:bytes       Integer (archive size, for GC)
 *   component:<tenantId>:<type>:<name>:next            Integer (原子 INCR 版本分配)
 *
 * agent-program 与旧 programs 路径兼容（读侧双查，plan N4：v1 直接切换、不做自动迁移）：
 *   - 新写：components 卷 + component:* keys
 *   - 旧读：legacy programs 卷（DATA_DIR/programs/programs/<tenantId>/<name>/<version>）
 *     + program:* keys（旧 ProgramStore dataDir 参数为 DATA_DIR/programs，其内部再拼一层
 *     "programs"，故 legacy 根 = dataDir/programs/programs）
 *
 * Safety: hand-written ustar reader rejects path traversal, symlinks, absolute paths,
 * and enforces file count / single-file / total-byte limits.
 */

import fs from "node:fs";
import path from "node:path";
import type { Redis } from "ioredis";
import type { ProgramManifest, Result } from "../programs/types.js";
import type { AuditWriter } from "../observability/audit.js";
import { SlotBindingStore, validateSlotId } from "./slot-binding.js";

// ── component types ──────────────────────────────────────────────

// 组件类型抽出至 types.ts（2026-08-13 审计 P1——store↔slot-binding 类型对偶断环）
import { COMPONENT_TYPES, type ComponentType } from "./types.js";
export { COMPONENT_TYPES, type ComponentType };

/**
 * 构件 manifest：type 分派；agent-program 时携带原 ProgramManifest 全部字段
 * （与 PTH ProgramManifest 同构，全部可选——非 agent 类型不携带这些字段）。
 */
export interface ComponentManifest {
  type: ComponentType;
  name: string;
  version?: string; // version-pin
  description?: string;
  payload?: Record<string, unknown>;
  targetSlot?: string; // 空位绑定（§5.2）
  legalAuth?: string; // 治理授权引用（§5.3）
  // agent-program 分支字段（等价映射）
  model?: string;
  provider?: string;
  thinking?: string;
  systemPrompt?: string;
  skills?: string[];
  tools?: string[];
  excludeTools?: string[];
  input?: { schema?: Record<string, unknown> };
  timeoutSec?: number;
}

export interface ComponentInfo {
  type: ComponentType;
  name: string;
  latestVersion: number;
  updatedAt: number;
}

export interface ComponentVersion {
  type: ComponentType;
  name: string;
  version: number;
  root: string; // absolute path to component directory on disk
  manifest: ComponentManifest;
}

// ── tar extraction limits ──────────────────────────────────────

const MAX_FILES = 100;
const MAX_SINGLE_FILE_BYTES = 1_048_576;        // 1 MB
const MAX_TOTAL_BYTES = 20_971_520;              // 20 MB
const MAX_PATH_DEPTH = 8;
const MAX_VERSIONS = 10;

// ── ustar constants ────────────────────────────────────────────

const BLOCK_SIZE = 512;
const USTAR_MAGIC = "ustar\0";

function readOctal(buf: Buffer, offset: number, len: number): number {
  let s = "";
  for (let i = 0; i < len; i++) {
    const ch = buf[offset + i]!;
    if (ch === 0 || ch === 0x20) break; // null or space terminates
    s += String.fromCharCode(ch);
  }
  if (s.length === 0) return 0;
  return parseInt(s, 8);
}

function isZeroBlock(buf: Buffer): boolean {
  for (let i = 0; i < BLOCK_SIZE; i++) {
    if (buf[i] !== 0) return false;
  }
  return true;
}

interface TarEntry {
  name: string;
  size: number;
  typeflag: string;
  offset: number; // content offset in the buffer
}

function parseTarEntries(buf: Buffer): Result<TarEntry[]> {
  const entries: TarEntry[] = [];
  let offset = 0;
  let totalBytes = 0;

  while (offset + BLOCK_SIZE <= buf.length) {
    const header = buf.subarray(offset, offset + BLOCK_SIZE);
    offset += BLOCK_SIZE;

    // Two consecutive zero blocks → end of archive
    if (isZeroBlock(header)) {
      const next = buf.subarray(offset, offset + BLOCK_SIZE);
      if (offset + BLOCK_SIZE <= buf.length && isZeroBlock(next)) {
        break;
      }
      // single zero block, could be padding — continue
      continue;
    }

    const magic = header.toString("utf-8", 257, 263);
    if (magic !== USTAR_MAGIC) {
      return { ok: false, error: `invalid tar magic at byte ${offset - BLOCK_SIZE}` };
    }

    const name = header.toString("utf-8", 0, 100).replace(/\0/g, "");
    const typeflag = header.toString("utf-8", 156, 157).replace(/\0/g, "");
    const size = readOctal(header, 124, 12);

    // ── safety checks ─────────────────────────────────────
    if (name.length === 0) {
      return { ok: false, error: "empty entry name in tar" };
    }
    if (path.isAbsolute(name) || name.startsWith("/")) {
      return { ok: false, error: `absolute path rejected: ${name}` };
    }
    if (name.includes("..")) {
      return { ok: false, error: `path traversal rejected: ${name}` };
    }
    if (typeflag === "2") {
      return { ok: false, error: `symlink rejected: ${name}` };
    }
    const depth = name.split("/").length - 1;
    if (depth > MAX_PATH_DEPTH) {
      return { ok: false, error: `path depth ${depth} exceeds max ${MAX_PATH_DEPTH}: ${name}` };
    }

    if (size > MAX_SINGLE_FILE_BYTES) {
      return { ok: false, error: `file too large (${size} > ${MAX_SINGLE_FILE_BYTES}): ${name}` };
    }

    if (entries.length >= MAX_FILES) {
      return { ok: false, error: `too many files (max ${MAX_FILES})` };
    }

    totalBytes += size;
    if (totalBytes > MAX_TOTAL_BYTES) {
      return { ok: false, error: `total decompressed bytes exceeds ${MAX_TOTAL_BYTES}` };
    }

    entries.push({ name, size, typeflag, offset });

    // Skip content (padded to 512-byte boundary)
    const contentBlocks = Math.ceil(size / BLOCK_SIZE);
    offset += contentBlocks * BLOCK_SIZE;
  }

  return { ok: true, value: entries };
}

// ── store ──────────────────────────────────────────────────────

export class ComponentStore {
  /** 空位绑定登记（§5.2——F/WP4 Task 18）；懒初始化：字段初始化器先于构造参数属性赋值执行 */
  private _slotBindings?: SlotBindingStore;
  private get slotBindings(): SlotBindingStore {
    this._slotBindings ??= new SlotBindingStore(this.redis);
    return this._slotBindings;
  }

  constructor(
    private redis: Redis,
    private dataDir: string,
    private audit?: AuditWriter,
  ) {}

  private componentsDir(): string {
    return path.join(this.dataDir, "components");
  }

  /** 旧 ProgramStore 落盘根：dataDir_arg=DATA_DIR/programs，内部再拼一层 programs */
  private legacyProgramsDir(): string {
    return path.join(this.dataDir, "programs", "programs");
  }

  private keySet(tenantId: string, type: ComponentType): string {
    return `components:${tenantId}:${type}`;
  }

  private keyLatest(tenantId: string, type: ComponentType, name: string): string {
    return `component:${tenantId}:${type}:${name}:latest`;
  }

  private keyUpdated(tenantId: string, type: ComponentType, name: string): string {
    return `component:${tenantId}:${type}:${name}:updatedAt`;
  }

  private keyVersion(tenantId: string, type: ComponentType, name: string, version: number): string {
    return `component:${tenantId}:${type}:${name}:${version}`;
  }

  private keyBytes(tenantId: string, type: ComponentType, name: string, version: number): string {
    return `component:${tenantId}:${type}:${name}:${version}:bytes`;
  }

  private keyNext(tenantId: string, type: ComponentType, name: string): string {
    return `component:${tenantId}:${type}:${name}:next`;
  }

  private rootDir(tenantId: string, type: ComponentType, name: string, version: number): string {
    return path.join(this.componentsDir(), tenantId, type, name, String(version));
  }

  private nameDir(tenantId: string, type: ComponentType, name: string): string {
    return path.join(this.componentsDir(), tenantId, type, name);
  }

  // ── legacy (agent-program) keys/dirs ─────────────────────

  private legacyKeySet(tenantId: string): string {
    return `programs:${tenantId}`;
  }

  private legacyKeyLatest(tenantId: string, name: string): string {
    return `program:${tenantId}:${name}:latest`;
  }

  private legacyKeyUpdated(tenantId: string, name: string): string {
    return `program:${tenantId}:${name}:updatedAt`;
  }

  private legacyKeyVersion(tenantId: string, name: string, version: number): string {
    return `program:${tenantId}:${name}:${version}`;
  }

  private legacyKeyBytes(tenantId: string, name: string, version: number): string {
    return `program:${tenantId}:${name}:${version}:bytes`;
  }

  private legacyKeyNext(tenantId: string, name: string): string {
    return `program:${tenantId}:${name}:next`;
  }

  private legacyRootDir(tenantId: string, name: string, version: number): string {
    return path.join(this.legacyProgramsDir(), tenantId, name, String(version));
  }

  private legacyNameDir(tenantId: string, name: string): string {
    return path.join(this.legacyProgramsDir(), tenantId, name);
  }

  /** 归档身份文件：agent-program=agent.json；其余类型=definition.json（最小骨架契约） */
  private entryFile(type: ComponentType): string {
    return type === "agent-program" ? "agent.json" : "definition.json";
  }

  /**
   * Save a component. Accepts raw tar buffer (already decompressed from gzip by caller).
   * type 取自 manifest.type（缺省=agent-program）。Assigns an incremental version
   * atomically via Redis INCR.
   */
  async save(
    tenantId: string,
    manifest: ComponentManifest,
    archive: Buffer,
  ): Promise<Result<ComponentVersion>> {
    const type: ComponentType = manifest.type ?? "agent-program";
    if (!COMPONENT_TYPES.includes(type)) {
      return { ok: false, error: `invalid component type: "${type}"` };
    }

    // 空位绑定 O(1) 登记校验（§5.2：字段良构即可，不做深度语义校验）——
    // 提前校验，避免 malformed targetSlot 写入部分状态
    if (manifest.targetSlot !== undefined) {
      const verr = validateSlotId(manifest.targetSlot);
      if (verr) return { ok: false, error: `invalid targetSlot: ${verr}` };
    }

    const parseResult = parseTarEntries(archive);
    if (!parseResult.ok) return parseResult;

    const entries = parseResult.value;

    // Extract entry file content to validate manifest match
    const entryName = this.entryFile(type);
    const entry = entries.find((e) => e.name === entryName);
    if (!entry) {
      return { ok: false, error: `missing ${entryName} in archive` };
    }
    const entryContent = archive.subarray(entry.offset, entry.offset + entry.size).toString("utf-8");
    let archiveManifest: { name?: unknown };
    try {
      archiveManifest = JSON.parse(entryContent);
    } catch {
      return { ok: false, error: `${entryName} is not valid JSON` };
    }
    if (archiveManifest.name !== manifest.name) {
      return { ok: false, error: `archive ${entryName} name does not match manifest` };
    }

    // Atomic version assignment
    const version = await this.redis.incr(this.keyNext(tenantId, type, manifest.name));

    // Write files to disk
    const root = this.rootDir(tenantId, type, manifest.name, version);
    fs.mkdirSync(root, { recursive: true });

    try {
      for (const entry of entries) {
        const filePath = path.join(root, entry.name);
        const dir = path.dirname(filePath);

        // Extra defense: after join, verify we're still under root
        if (!filePath.startsWith(root + path.sep) && filePath !== root) {
          return { ok: false, error: `path escape after join: ${entry.name}` };
        }

        fs.mkdirSync(dir, { recursive: true });
        const content = archive.subarray(entry.offset, entry.offset + entry.size);
        fs.writeFileSync(filePath, content);
      }
    } catch (err: any) {
      // Clean up partial extraction
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ok */ }
      return { ok: false, error: `extraction failed: ${err.message}` };
    }

    // Update Redis
    await this.redis.sadd(this.keySet(tenantId, type), manifest.name);
    await this.redis.set(this.keyLatest(tenantId, type, manifest.name), String(version));
    await this.redis.set(this.keyVersion(tenantId, type, manifest.name, version), JSON.stringify(manifest));
    await this.redis.set(this.keyBytes(tenantId, type, manifest.name, version), String(archive.length));
    await this.redis.set(this.keyUpdated(tenantId, type, manifest.name), String(Date.now()));

    // Garbage-collect old versions
    await this.prune(tenantId, type, manifest.name);

    // ── 空位绑定生效（§5.2）：上传携带 targetSlot → slot:{slotId}:binding + 审计 ──
    if (manifest.targetSlot !== undefined) {
      const b = await this.slotBindings.bind(
        tenantId,
        manifest.targetSlot,
        type,
        manifest.name,
        version,
        manifest.legalAuth,
      );
      if (!b.ok) return b;
      await this.audit?.write({
        tenantId,
        actor: "tenant",
        action: "slot_binding",
        details: {
          slotId: manifest.targetSlot,
          type,
          name: manifest.name,
          version,
          boundAt: b.value.boundAt,
          ...(manifest.legalAuth !== undefined ? { legalAuth: manifest.legalAuth } : {}),
        },
      });
    }

    // ── legalAuth 声明式登记（§5.3，F/WP4 Task 19）：不拦截不校验，仅登记+审计 ──
    // 原样落盘：manifest 全量已写 components 卷（definition.json/agent.json）与 Redis；
    // 此处补审计事件（含 legalAuth 字段）供“谁在何授权下上传了何构件”追溯。
    if (manifest.legalAuth !== undefined) {
      await this.audit?.write({
        tenantId,
        actor: "tenant",
        action: "component_upload",
        details: {
          type,
          name: manifest.name,
          version,
          legalAuth: manifest.legalAuth,
          ...(manifest.targetSlot !== undefined ? { targetSlot: manifest.targetSlot } : {}),
        },
      });
    }

    return {
      ok: true,
      value: { type, name: manifest.name, version, root, manifest },
    };
  }

  /** Delete all versions of a component（agent-program 同时清理 legacy 数据）。 */
  async delete(
    tenantId: string,
    name: string,
    type: ComponentType = "agent-program",
  ): Promise<Result<void>> {
    const latest = await this.redis.get(this.keyLatest(tenantId, type, name));
    const legacyLatest = type === "agent-program" ? await this.redis.get(this.legacyKeyLatest(tenantId, name)) : null;
    if (latest === null && legacyLatest === null) {
      return { ok: false, error: `component "${name}" (${type}) not found` };
    }
    const maxVer = Math.max(parseInt(latest ?? "0", 10), parseInt(legacyLatest ?? "0", 10));

    // Delete Redis keys
    await this.redis.del(this.keyLatest(tenantId, type, name));
    await this.redis.del(this.keyUpdated(tenantId, type, name));
    for (let v = 1; v <= maxVer; v++) {
      await this.redis.del(this.keyVersion(tenantId, type, name, v));
      await this.redis.del(this.keyBytes(tenantId, type, name, v));
      if (type === "agent-program") {
        await this.redis.del(this.legacyKeyVersion(tenantId, name, v));
        await this.redis.del(this.legacyKeyBytes(tenantId, name, v));
      }
    }
    await this.redis.del(this.keyNext(tenantId, type, name));
    await this.redis.srem(this.keySet(tenantId, type), name);
    if (type === "agent-program") {
      await this.redis.del(this.legacyKeyLatest(tenantId, name));
      await this.redis.del(this.legacyKeyUpdated(tenantId, name));
      await this.redis.del(this.legacyKeyNext(tenantId, name));
      await this.redis.srem(this.legacyKeySet(tenantId), name);
    }

    // Delete on-disk directories
    try { fs.rmSync(this.nameDir(tenantId, type, name), { recursive: true, force: true }); } catch { /* ok */ }
    if (type === "agent-program") {
      try { fs.rmSync(this.legacyNameDir(tenantId, name), { recursive: true, force: true }); } catch { /* ok */ }
    }

    return { ok: true, value: undefined };
  }

  /** List components for a tenant（agent-program 时并入 legacy 名称）。 */
  async list(
    tenantId: string,
    type: ComponentType = "agent-program",
  ): Promise<ComponentInfo[]> {
    const names = await this.redis.smembers(this.keySet(tenantId, type));
    if (type === "agent-program") {
      const legacyNames = await this.redis.smembers(this.legacyKeySet(tenantId));
      for (const n of legacyNames) {
        if (!names.includes(n)) names.push(n);
      }
    }

    const result: ComponentInfo[] = [];
    for (const name of names) {
      let latest = await this.redis.get(this.keyLatest(tenantId, type, name));
      let updatedAt = parseInt((await this.redis.get(this.keyUpdated(tenantId, type, name))) ?? "0", 10);
      if (latest === null && type === "agent-program") {
        latest = await this.redis.get(this.legacyKeyLatest(tenantId, name));
        if (latest === null) continue;
        updatedAt = parseInt((await this.redis.get(this.legacyKeyUpdated(tenantId, name))) ?? "0", 10);
      }
      if (latest === null) continue;
      result.push({
        type,
        name,
        latestVersion: parseInt(latest, 10),
        updatedAt,
      });
    }

    result.sort((a, b) => a.name.localeCompare(b.name));
    return result;
  }

  /**
   * Get a specific version (or latest) of a component.
   * type 缺省=agent-program；agent-program 读侧双查 legacy programs 路径。
   */
  async get(
    tenantId: string,
    name: string,
    version?: number,
    type: ComponentType = "agent-program",
  ): Promise<Result<ComponentVersion>> {
    return this.getVersion(tenantId, type, name, version);
  }

  /** 类型优先便捷读（任意类型构件） */
  getByType(
    tenantId: string,
    type: ComponentType,
    name: string,
    version?: number,
  ): Promise<Result<ComponentVersion>> {
    return this.get(tenantId, name, version, type);
  }

  /** 类型优先便捷列表 */
  listByType(tenantId: string, type: ComponentType): Promise<ComponentInfo[]> {
    return this.list(tenantId, type);
  }

  /** 类型优先便捷删除 */
  deleteByType(tenantId: string, type: ComponentType, name: string): Promise<Result<void>> {
    return this.delete(tenantId, name, type);
  }

  /** 非虚 get 逻辑（materialize 复用，避免被子类覆写方法劫持） */
  private async getVersion(
    tenantId: string,
    type: ComponentType,
    name: string,
    version?: number,
  ): Promise<Result<ComponentVersion>> {
    let ver: number | undefined = version;
    let legacy = false;

    if (ver === undefined) {
      const latest = await this.redis.get(this.keyLatest(tenantId, type, name));
      if (latest === null && type === "agent-program") {
        const legacyLatest = await this.redis.get(this.legacyKeyLatest(tenantId, name));
        if (legacyLatest === null) {
          return { ok: false, error: `component "${name}" (${type}) not found` };
        }
        ver = parseInt(legacyLatest, 10);
        legacy = true;
      } else if (latest === null) {
        return { ok: false, error: `component "${name}" (${type}) not found` };
      } else {
        ver = parseInt(latest, 10);
      }
    } else {
      const raw = await this.redis.get(this.keyVersion(tenantId, type, name, ver));
      if (raw === null && type === "agent-program") {
        const legacyRaw = await this.redis.get(this.legacyKeyVersion(tenantId, name, ver));
        if (legacyRaw !== null) legacy = true;
      }
    }

    if (ver === undefined) {
      return { ok: false, error: `component "${name}" (${type}) not found` };
    }

    const raw = legacy
      ? await this.redis.get(this.legacyKeyVersion(tenantId, name, ver))
      : await this.redis.get(this.keyVersion(tenantId, type, name, ver));
    if (!raw) {
      return { ok: false, error: `component "${name}" v${ver} not found` };
    }
    const parsed = JSON.parse(raw) as ComponentManifest;
    const manifest: ComponentManifest = legacy && parsed.type === undefined
      ? { ...parsed, type: "agent-program" }
      : parsed;
    const root = legacy
      ? this.legacyRootDir(tenantId, name, ver)
      : this.rootDir(tenantId, type, name, ver);
    if (!fs.existsSync(root)) {
      return { ok: false, error: `component "${name}" v${ver} files missing on disk` };
    }

    return { ok: true, value: { type, name, version: ver, root, manifest } };
  }

  /** Copy component files to a destination directory (for run materialization). */
  async materialize(
    tenantId: string,
    name: string,
    version: number,
    destDir: string,
    type: ComponentType = "agent-program",
  ): Promise<Result<void>> {
    const result = await this.getVersion(tenantId, type, name, version);
    if (!result.ok) return result;

    const root = result.value.root;
    if (!fs.existsSync(root)) {
      return { ok: false, error: "component directory missing" };
    }

    fs.mkdirSync(destDir, { recursive: true });
    fs.cpSync(root, destDir, { recursive: true });
    return { ok: true, value: undefined };
  }

  // ── internal ─────────────────────────────────────────────

  /** Remove versions beyond MAX_VERSIONS. */
  private async prune(tenantId: string, type: ComponentType, name: string): Promise<void> {
    const latest = await this.redis.get(this.keyLatest(tenantId, type, name));
    if (!latest) return;
    const maxVer = parseInt(latest, 10);
    const oldest = maxVer - MAX_VERSIONS;

    for (let v = 1; v <= oldest; v++) {
      // Delete Redis keys
      await this.redis.del(this.keyVersion(tenantId, type, name, v));
      await this.redis.del(this.keyBytes(tenantId, type, name, v));
      // Delete on-disk
      const dir = this.rootDir(tenantId, type, name, v);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
    }
  }
}

export type { ProgramManifest, Result };
