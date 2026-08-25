/**
 * provider-config.ts —— providers.json 配置后端（PTH Provider 配置 CLI）
 *
 * 本模块是 providers.json 的 canonical writer/validator。
 * 与 pi-platform `pit-providers` 共享同一 contract：
 *   docs/pth/contract/provider-config-contract.md
 *
 * 安全模型：
 *   - 原子写（临时文件 + fsync + rename + 目录 fsync）
 *   - lock file + compare-and-swap 防并发 lost update
 *   - symlink / 非普通文件 fail closed
 *   - 备份 exclusive create
 *   - 新文件/备份权限 0o600
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

// ─── 类型 ──────────────────────────────────────────────────────────

export interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelDef {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: string[];
  cost?: ModelCost;
  contextWindow?: number;
  maxTokens?: number;
  compat?: Record<string, unknown>;
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
  [key: string]: unknown;
}

export interface InferRule {
  pattern: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  cost?: Partial<ModelCost>;
  input?: string[];
  compat?: Record<string, unknown>;
}

export interface ProviderDef {
  id: string;
  name: string;
  alias?: string[];
  baseUrl: string;
  api: string;
  apiKeyEnv?: string;
  multiKey: boolean;
  refreshModels: boolean;
  compat?: Record<string, unknown>;
  models: ModelDef[];
  inferRules?: InferRule[];
  inferDefaults?: Partial<Omit<ModelDef, "id" | "name">>;
  [key: string]: unknown;
}

export interface ProvidersFile {
  version: 1;
  providers: ProviderDef[];
  [key: string]: unknown;
}

export type ProviderErrorCode =
  | "PROVIDERS_FILE_NOT_FOUND"
  | "PROVIDERS_FILE_INVALID"
  | "PROVIDER_EXISTS"
  | "PROVIDER_NOT_FOUND"
  | "PROVIDER_ID_IMMUTABLE"
  | "PROVIDER_VALIDATION_FAILED"
  | "CONCURRENT_MODIFICATION"
  | "LOCK_TIMEOUT"
  | "FILE_NOT_REGULAR"
  | "BACKUP_FAILED"
  | "WRITE_FAILED";

export interface ProviderConfigError {
  code: ProviderErrorCode;
  message: string;
  details?: unknown;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: ProviderConfigError };

export interface ValidateResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

// ─── 路径 ──────────────────────────────────────────────────────────

export function providersPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.PI_TRIPLE_HOME ?? path.join(os.homedir(), ".pi-triple");
  return path.join(home, "providers.json");
}

// ─── 校验 ──────────────────────────────────────────────────────────

const PROVIDER_ID_RE = /^[a-z0-9-]+$/;
const REQUIRED_STR_KEYS = ["id", "name", "baseUrl", "api"] as const;
const REQUIRED_BOOL_KEYS = ["multiKey", "refreshModels"] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function validateProvider(raw: unknown): { ok: true; def: ProviderDef } | { ok: false; errors: string[] } {
  if (!isRecord(raw)) return { ok: false, errors: ["provider 必须是对象"] };
  const errors: string[] = [];

  for (const key of REQUIRED_STR_KEYS) {
    if (typeof raw[key] !== "string" || raw[key].trim() === "") {
      errors.push(`provider.${key} 是必填非空字符串字段`);
    }
  }
  for (const key of REQUIRED_BOOL_KEYS) {
    if (typeof raw[key] !== "boolean") errors.push(`provider.${key} 是必填 boolean 字段`);
  }
  if (typeof raw.id === "string" && !PROVIDER_ID_RE.test(raw.id)) {
    errors.push(`provider.id 必须匹配 ^[a-z0-9-]+$，收到: "${raw.id}"`);
  }
  if (typeof raw.baseUrl === "string" && !/^https?:\/\//i.test(raw.baseUrl)) {
    errors.push(`provider.baseUrl 必须 http(s)://，收到: "${raw.baseUrl}"`);
  }
  if (!Array.isArray(raw.models)) {
    errors.push("provider.models 必须是数组");
  } else {
    raw.models.forEach((m, i) => {
      if (!isRecord(m) || typeof m.id !== "string" || m.id.trim() === "") {
        errors.push(`provider.models[${i}].id 是必填非空字符串`);
      }
    });
  }
  if (raw.alias !== undefined) {
    if (!Array.isArray(raw.alias) || raw.alias.some((a) => typeof a !== "string" || a.trim() === "")) {
      errors.push("provider.alias 必须是非空字符串数组");
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  const def = raw as unknown as ProviderDef;
  return { ok: true, def };
}

export function validateProvidersDoc(raw: unknown): ValidateResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!isRecord(raw)) {
    return { ok: false, errors: ["providers.json 顶层必须是对象"], warnings };
  }
  if (raw.version !== 1) {
    errors.push(`version 字段必须为 1，收到: ${String(raw.version)}`);
  }
  if (!Array.isArray(raw.providers)) {
    errors.push("providers 字段必须是数组");
    return { ok: false, errors, warnings };
  }

  const names = new Map<string, string>();

  raw.providers.forEach((p, i) => {
    const result = validateProvider(p);
    if (!result.ok) {
      for (const e of result.errors) errors.push(`Providers[${i}]: ${e}`);
      return;
    }
    const def = result.def;
    const namesInProvider = [def.id, ...(def.alias ?? [])];
    for (const name of namesInProvider) {
      if (names.has(name)) {
        errors.push(`Providers[${i}]: id/alias "${name}" 与已有 id/alias 冲突`);
      } else {
        names.set(name, def.id);
      }
    }
  });

  return { ok: errors.length === 0, errors, warnings };
}

// ─── 读取 ──────────────────────────────────────────────────────────

function parseProvidersFile(text: string): ValidateResult & { doc?: ProvidersFile } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { ok: false, errors: [`JSON 解析失败: ${err instanceof Error ? err.message : String(err)}`], warnings: [] };
  }
  const result = validateProvidersDoc(raw);
  if (!result.ok) return result;
  return { ...result, doc: raw as ProvidersFile };
}

export function loadProvidersFile(file: string = providersPath()): Result<ProvidersFile> {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      return { ok: false, error: { code: "PROVIDERS_FILE_NOT_FOUND", message: `providers.json 不存在: ${file}` } };
    }
    return { ok: false, error: { code: "WRITE_FAILED", message: `读取 providers.json 失败: ${err?.message ?? String(err)}`, details: { file } } };
  }
  const parsed = parseProvidersFile(text);
  if (!parsed.ok || !parsed.doc) {
    return { ok: false, error: { code: "PROVIDERS_FILE_INVALID", message: parsed.errors.join("; "), details: { file } } };
  }
  return { ok: true, value: parsed.doc };
}

export async function ensureProvidersFile(file: string = providersPath()): Promise<Result<ProvidersFile>> {
  const loaded = loadProvidersFile(file);
  if (loaded.ok) return loaded;
  if (loaded.error.code === "PROVIDERS_FILE_NOT_FOUND") {
    const doc: ProvidersFile = { version: 1, providers: [] };
    const saved = await saveProvidersFile(doc, file, { backup: false, expectedHash: null });
    if (!saved.ok) return saved;
    return { ok: true, value: doc };
  }
  return loaded;
}

// ─── 文件安全工具 ──────────────────────────────────────────────────

async function isRegularFile(file: string): Promise<boolean> {
  try {
    const st = await fsp.lstat(file);
    return st.isFile();
  } catch {
    return false;
  }
}

export async function hashProvidersFile(file: string = providersPath()): Promise<string | null> {
  return fileHash(file);
}

async function fileHash(file: string): Promise<string | null> {
  try {
    const buf = await fsp.readFile(file);
    return crypto.createHash("sha256").update(buf).digest("hex");
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = `${file}.lock`;
  const deadline = Date.now() + 2000;
  let fd: fs.promises.FileHandle | null = null;
  for (;;) {
    try {
      fd = await fsp.open(lockPath, "wx", 0o600);
      break;
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;
      // 陈旧 lock：超过 10s 强制删除
      try {
        const st = await fsp.stat(lockPath);
        if (Date.now() - st.mtimeMs > 10_000) {
          await fsp.unlink(lockPath).catch(() => {});
          continue;
        }
      } catch {
        // lock 不存在了，重试
        continue;
      }
      if (Date.now() > deadline) {
        throw new ProviderConfigErrorImpl("LOCK_TIMEOUT", `无法获取 lock: ${lockPath}`);
      }
      await sleep(25);
    }
  }
  try {
    return await fn();
  } finally {
    if (fd) await fd.close().catch(() => {});
    await fsp.unlink(lockPath).catch(() => {});
  }
}

class ProviderConfigErrorImpl extends Error {
  code: ProviderErrorCode;
  details?: unknown;
  constructor(code: ProviderErrorCode, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function err(code: ProviderErrorCode, message: string, details?: unknown): { ok: false; error: ProviderConfigError } {
  return { ok: false, error: { code, message, details } };
}

// ─── 保存 / 备份 / 恢复 ────────────────────────────────────────────

export interface SaveOptions {
  backup?: boolean;
  /** undefined=不校验；string=期望文件 hash；null=期望文件尚不存在 */
  expectedHash?: string | null;
}

async function fsyncDir(dir: string): Promise<void> {
  try {
    const dh = await fsp.open(dir, "r");
    try {
      await dh.sync();
    } finally {
      await dh.close();
    }
  } catch {
    // 部分平台不支持目录 fsync，忽略
  }
}

export async function saveProvidersFile(
  doc: ProvidersFile,
  file: string = providersPath(),
  opts: SaveOptions = {},
): Promise<Result<{ backupPath?: string }>> {
  const validation = validateProvidersDoc(doc);
  if (!validation.ok) {
    return err("PROVIDER_VALIDATION_FAILED", validation.errors.join("; "));
  }

  try {
    return await withLock(file, async () => {
      const dir = path.dirname(file);
      await fsp.mkdir(dir, { recursive: true });

      const exists = fs.existsSync(file);
      if (exists && !(await isRegularFile(file))) {
        return err("FILE_NOT_REGULAR", `目标不是普通文件，拒绝写入: ${file}`);
      }

      if (opts.expectedHash === null) {
        if (exists) {
          return err("CONCURRENT_MODIFICATION", "文件已被其他进程创建，拒绝覆盖（compare-and-swap 失败）");
        }
      } else if (opts.expectedHash !== undefined) {
        const current = await fileHash(file);
        if (current !== opts.expectedHash) {
          return err("CONCURRENT_MODIFICATION", "文件已被其他进程修改，拒绝覆盖（compare-and-swap 失败）");
        }
      }

      let backupPath: string | undefined;
      const doBackup = opts.backup !== false && process.env.PTH_PROVIDER_BACKUP !== "0";
      if (doBackup && exists) {
        const backupResult = await createBackup(file, dir);
        if (!backupResult.ok) return backupResult;
        backupPath = backupResult.value.path;
      }

      const tmp = path.join(dir, `.providers.json.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);
      const data = JSON.stringify(doc, null, 2) + "\n";
      try {
        const fh = await fsp.open(tmp, "wx", exists ? 0o600 : 0o600);
        try {
          await fh.writeFile(data, "utf8");
          await fh.sync();
        } finally {
          await fh.close();
        }
        await fsp.rename(tmp, file);
        await fsyncDir(dir);
      } catch (writeErr: any) {
        await fsp.unlink(tmp).catch(() => {});
        return err("WRITE_FAILED", `写入 providers.json 失败: ${writeErr?.message ?? String(writeErr)}`);
      }

      return { ok: true, value: { ...(backupPath ? { backupPath } : {}) } };
    });
  } catch (e: any) {
    if (e instanceof ProviderConfigErrorImpl) return err(e.code, e.message, e.details);
    return err("WRITE_FAILED", `写入 providers.json 失败: ${e?.message ?? String(e)}`);
  }
}

async function createBackup(file: string, dir: string): Promise<Result<{ path: string }>> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const rand = crypto.randomBytes(3).toString("hex");
  const backupPath = path.join(dir, `${path.basename(file)}.bak-${stamp}-${rand}`);
  try {
    const fh = await fsp.open(backupPath, "wx", 0o600);
    try {
      const data = await fsp.readFile(file);
      await fh.writeFile(data);
      await fh.sync();
    } finally {
      await fh.close();
    }
    return { ok: true, value: { path: backupPath } };
  } catch (e: any) {
    return err("BACKUP_FAILED", `创建备份失败: ${e?.message ?? String(e)}`);
  }
}

export async function backupProvidersFile(file: string = providersPath(), output?: string): Promise<Result<{ path: string }>> {
  try {
    return await withLock(file, async () => {
      if (!fs.existsSync(file)) return err("PROVIDERS_FILE_NOT_FOUND", `providers.json 不存在: ${file}`);
      if (!(await isRegularFile(file))) return err("FILE_NOT_REGULAR", `目标不是普通文件，拒绝备份: ${file}`);
      if (output) {
        const dir = path.dirname(output);
        await fsp.mkdir(dir, { recursive: true });
        try {
          const data = await fsp.readFile(file);
          await fsp.writeFile(output, data, { mode: 0o600, flag: "wx" });
          return { ok: true, value: { path: output } };
        } catch (e: any) {
          return err("BACKUP_FAILED", `创建备份失败: ${e?.message ?? String(e)}`);
        }
      }
      return createBackup(file, path.dirname(file));
    });
  } catch (e: any) {
    if (e instanceof ProviderConfigErrorImpl) return err(e.code, e.message, e.details);
    return err("BACKUP_FAILED", `备份失败: ${e?.message ?? String(e)}`);
  }
}

export async function restoreProvidersFile(backupFile: string, file: string = providersPath(), opts: { backup?: boolean } = {}): Promise<Result<{ backupPath?: string }>> {
  if (!fs.existsSync(backupFile)) return err("PROVIDERS_FILE_NOT_FOUND", `备份文件不存在: ${backupFile}`);
  if (!(await isRegularFile(backupFile))) return err("FILE_NOT_REGULAR", `备份不是普通文件，拒绝恢复: ${backupFile}`);

  const text = await fsp.readFile(backupFile, "utf8").catch((e: any) => {
    throw new ProviderConfigErrorImpl("WRITE_FAILED", `读取备份失败: ${e?.message ?? String(e)}`);
  });
  const parsed = parseProvidersFile(text);
  if (!parsed.ok || !parsed.doc) {
    return err("PROVIDERS_FILE_INVALID", parsed.errors.join("; "));
  }
  return saveProvidersFile(parsed.doc, file, { backup: opts.backup !== false });
}

// ─── 纯文档操作 ────────────────────────────────────────────────────

export function getProvider(doc: ProvidersFile, id: string): ProviderDef | undefined {
  return doc.providers.find((p) => p.id === id || (p.alias ?? []).includes(id));
}

export function addProviderToDoc(doc: ProvidersFile, def: ProviderDef): Result<{ doc: ProvidersFile }> {
  if (getProvider(doc, def.id)) {
    return err("PROVIDER_EXISTS", `provider id/alias "${def.id}" 已存在`);
  }
  const next: ProvidersFile = { ...doc, providers: [...doc.providers, def] };
  const validation = validateProvidersDoc(next);
  if (!validation.ok) return err("PROVIDER_VALIDATION_FAILED", validation.errors.join("; "));
  return { ok: true, value: { doc: next } };
}

export function updateProviderInDoc(doc: ProvidersFile, id: string, patch: Partial<ProviderDef>): Result<{ doc: ProvidersFile }> {
  if (patch.id !== undefined && patch.id !== id) {
    return err("PROVIDER_ID_IMMUTABLE", "provider.id 不可更新");
  }
  const idx = doc.providers.findIndex((p) => p.id === id || (p.alias ?? []).includes(id));
  if (idx < 0) return err("PROVIDER_NOT_FOUND", `provider "${id}" 不存在`);

  const current = doc.providers[idx]!;
  const merged: ProviderDef = { ...current, ...patch, id: current.id };
  const next: ProvidersFile = { ...doc, providers: [...doc.providers.slice(0, idx), merged, ...doc.providers.slice(idx + 1)] };
  const validation = validateProvidersDoc(next);
  if (!validation.ok) return err("PROVIDER_VALIDATION_FAILED", validation.errors.join("; "));
  return { ok: true, value: { doc: next } };
}

export function removeProviderFromDoc(doc: ProvidersFile, id: string): Result<{ doc: ProvidersFile }> {
  const idx = doc.providers.findIndex((p) => p.id === id || (p.alias ?? []).includes(id));
  if (idx < 0) return err("PROVIDER_NOT_FOUND", `provider "${id}" 不存在`);
  const next: ProvidersFile = { ...doc, providers: [...doc.providers.slice(0, idx), ...doc.providers.slice(idx + 1)] };
  return { ok: true, value: { doc: next } };
}

// ─── 默认补全 ──────────────────────────────────────────────────────

export function normalizeProviderInput(raw: unknown): { ok: true; def: ProviderDef } | { ok: false; errors: string[] } {
  if (!isRecord(raw)) return { ok: false, errors: ["provider 必须是对象"] };
  const withDefaults: Record<string, unknown> = {
    api: "openai-completions",
    multiKey: false,
    refreshModels: false,
    models: [],
    ...raw,
  };
  return validateProvider(withDefaults);
}
