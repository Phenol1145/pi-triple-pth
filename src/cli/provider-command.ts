/**
 * provider-command.ts —— `pth config provider` 子命令实现
 *
 * 所有读写都走 `@away_from/pth-config` 的 provider-config 后端；
 * 本文件只做 CLI 解析、输出和权限守卫，不复制校验/写入逻辑。
 */

import { readFile } from "node:fs/promises";
import {
  providersPath,
  loadProvidersFile,
  ensureProvidersFile,
  saveProvidersFile,
  backupProvidersFile,
  restoreProvidersFile,
  addProviderToDoc,
  updateProviderInDoc,
  removeProviderFromDoc,
  getProvider,
  normalizeProviderInput,
  validateProvidersDoc,
  hashProvidersFile,
  type ProvidersFile,
  type ProviderDef,
} from "@away_from/pth-config";

type JsonMode = boolean;

let jsonMode = false;

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function fail(message: string, code = "PROVIDER_COMMAND_FAILED", details?: unknown, exitCode = 1): void {
  if (jsonMode || hasFlag(process.argv.slice(2), "--json")) {
    printJson({ ok: false, error: { code, message, ...(details ? { details } : {}) } });
  } else {
    console.error(`error: ${message}`);
  }
  process.exitCode = exitCode;
}

function usageError(message: string): void {
  fail(message, "USAGE_ERROR", undefined, 2);
}

function isWriteAction(action: string): boolean {
  return action === "add" || action === "update" || action === "remove" || action === "restore";
}

function checkWriteGuard(action: string): boolean {
  if (!isWriteAction(action)) return true;
  if (process.env.PTH_CONFIG_READONLY === "1") {
    fail("PTH_CONFIG_READONLY=1：禁止修改 authoritative config", "CONFIG_READONLY");
    return false;
  }
  if (process.env.PTH_PROVIDER_WRITE === "0") {
    fail("PTH_PROVIDER_WRITE=0：provider 写操作已禁用", "PROVIDER_WRITE_DISABLED");
    return false;
  }
  return true;
}

async function ensureDoc(file: string): Promise<ProvidersFile | null> {
  const ensured = await ensureProvidersFile(file);
  if (!ensured.ok) {
    fail(ensured.error.message, ensured.error.code);
    return null;
  }
  return ensured.value;
}

async function loadForRead(file: string): Promise<{ doc: ProvidersFile; hash: string | null } | null> {
  const loaded = loadProvidersFile(file);
  if (!loaded.ok) {
    if (loaded.error.code === "PROVIDERS_FILE_NOT_FOUND") {
      return { doc: { version: 1, providers: [] }, hash: null };
    }
    fail(loaded.error.message, loaded.error.code);
    return null;
  }
  const hash = await hashProvidersFile(file);
  return { doc: loaded.value, hash };
}

async function listProviders(args: string[], file: string, json: boolean): Promise<void> {
  const loaded = loadProvidersFile(file);
  const providers: ProviderDef[] = loaded.ok ? loaded.value.providers : [];
  if (!loaded.ok && loaded.error.code !== "PROVIDERS_FILE_NOT_FOUND") {
    fail(loaded.error.message, loaded.error.code);
    return;
  }
  if (json) {
    printJson({ ok: true, providers, count: providers.length });
    return;
  }
  console.log("ID\tNAME\tAPI\tMODELS\tMULTIKEY\tREFRESH");
  for (const p of providers) {
    console.log(`${p.id}\t${p.name}\t${p.api}\t${p.models.length}\t${p.multiKey ? "yes" : "no"}\t${p.refreshModels ? "yes" : "no"}`);
  }
}

async function getProviderCommand(args: string[], file: string, json: boolean): Promise<void> {
  const id = args.find((a) => !a.startsWith("-"));
  if (!id) {
    usageError("用法: pth config provider get <id> [--json]");
    return;
  }
  const loaded = loadProvidersFile(file);
  if (!loaded.ok) {
    if (loaded.error.code === "PROVIDERS_FILE_NOT_FOUND") {
      fail(`provider "${id}" 不存在`, "PROVIDER_NOT_FOUND");
      return;
    }
    fail(loaded.error.message, loaded.error.code);
    return;
  }
  const provider = getProvider(loaded.value, id);
  if (!provider) {
    fail(`provider "${id}" 不存在`, "PROVIDER_NOT_FOUND");
    return;
  }
  if (json) printJson({ ok: true, provider });
  else printJson({ ok: true, provider });
}

async function addProviderCommand(args: string[], file: string, json: boolean): Promise<void> {
  const jsonRaw = argValue(args, "--data");
  const filePath = argValue(args, "--file");
  if ((jsonRaw === undefined) === (filePath === undefined)) {
    usageError("用法: pth config provider add --data <json> | --file <path>");
    return;
  }

  let raw: unknown;
  if (jsonRaw !== undefined) {
    try {
      raw = JSON.parse(jsonRaw);
    } catch (e: any) {
      fail(`--data 不是合法 JSON: ${e?.message ?? String(e)}`, "PROVIDER_VALIDATION_FAILED");
      return;
    }
  } else {
    try {
      raw = JSON.parse(await readFile(filePath!, "utf8"));
    } catch (e: any) {
      fail(`读取 --file 失败: ${e?.message ?? String(e)}`, "PROVIDER_VALIDATION_FAILED");
      return;
    }
  }

  const normalized = normalizeProviderInput(raw);
  if (!normalized.ok) {
    fail(normalized.errors.join("; "), "PROVIDER_VALIDATION_FAILED");
    return;
  }

  const current = await loadForRead(file);
  if (!current) return;
  const added = addProviderToDoc(current.doc, normalized.def);
  if (!added.ok) {
    fail(added.error.message, added.error.code);
    return;
  }
  const saved = await saveProvidersFile(added.value.doc, file, { backup: true, expectedHash: current.hash });
  if (!saved.ok) {
    fail(saved.error.message, saved.error.code);
    return;
  }
  if (json) printJson({ ok: true, provider: normalized.def, ...(saved.value.backupPath ? { backupPath: saved.value.backupPath } : {}) });
  else console.log(`added provider ${normalized.def.id}`);
}

async function updateProviderCommand(args: string[], file: string, json: boolean): Promise<void> {
  const id = args.find((a) => !a.startsWith("-"));
  const jsonRaw = argValue(args, "--data");
  const filePath = argValue(args, "--file");
  if (!id) {
    usageError("用法: pth config provider update <id> --data <json> | --file <path>");
    return;
  }
  if ((jsonRaw === undefined) === (filePath === undefined)) {
    usageError("用法: pth config provider update <id> --data <json> | --file <path>");
    return;
  }

  let raw: unknown;
  if (jsonRaw !== undefined) {
    try {
      raw = JSON.parse(jsonRaw);
    } catch (e: any) {
      fail(`--data 不是合法 JSON: ${e?.message ?? String(e)}`, "PROVIDER_VALIDATION_FAILED");
      return;
    }
  } else {
    try {
      raw = JSON.parse(await readFile(filePath!, "utf8"));
    } catch (e: any) {
      fail(`读取 --file 失败: ${e?.message ?? String(e)}`, "PROVIDER_VALIDATION_FAILED");
      return;
    }
  }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail("patch 必须是对象", "PROVIDER_VALIDATION_FAILED");
    return;
  }

  const current = await loadForRead(file);
  if (!current) return;
  const updated = updateProviderInDoc(current.doc, id, raw as Partial<ProviderDef>);
  if (!updated.ok) {
    fail(updated.error.message, updated.error.code);
    return;
  }
  const saved = await saveProvidersFile(updated.value.doc, file, { backup: true, expectedHash: current.hash });
  if (!saved.ok) {
    fail(saved.error.message, saved.error.code);
    return;
  }
  const provider = getProvider(updated.value.doc, id);
  if (json) printJson({ ok: true, provider, ...(saved.value.backupPath ? { backupPath: saved.value.backupPath } : {}) });
  else console.log(`updated provider ${id}`);
}

async function removeProviderCommand(args: string[], file: string, json: boolean): Promise<void> {
  const id = args.find((a) => !a.startsWith("-"));
  if (!id) {
    usageError("用法: pth config provider remove <id> [--yes]");
    return;
  }
  if (!hasFlag(args, "--yes")) {
    // 非交互：没有 --yes 时拒绝（CLI 不在这里做交互输入，避免阻塞自动化）
    fail("remove 需要 --yes 确认", "CONFIRM_REQUIRED");
    return;
  }
  const current = await loadForRead(file);
  if (!current) return;
  const removed = removeProviderFromDoc(current.doc, id);
  if (!removed.ok) {
    fail(removed.error.message, removed.error.code);
    return;
  }
  const saved = await saveProvidersFile(removed.value.doc, file, { backup: true, expectedHash: current.hash });
  if (!saved.ok) {
    fail(saved.error.message, saved.error.code);
    return;
  }
  if (json) printJson({ ok: true, ...(saved.value.backupPath ? { backupPath: saved.value.backupPath } : {}) });
  else console.log(`removed provider ${id}`);
}

async function validateCommand(args: string[], file: string, json: boolean): Promise<void> {
  const filePath = argValue(args, "--file");
  const target = filePath ?? file;
  let text: string;
  try {
    text = await readFile(target, "utf8");
  } catch (e: any) {
    fail(`读取 ${target} 失败: ${e?.message ?? String(e)}`, "PROVIDERS_FILE_NOT_FOUND");
    return;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e: any) {
    fail(`JSON 解析失败: ${e?.message ?? String(e)}`, "PROVIDERS_FILE_INVALID");
    return;
  }
  const result = validateProvidersDoc(raw);
  if (json) {
    printJson({ ok: result.ok, valid: result.ok, errors: result.errors, warnings: result.warnings });
  } else {
    if (result.ok) console.log("valid");
    else {
      for (const e of result.errors) console.error(`  - ${e}`);
      console.error(`invalid (${result.errors.length} errors)`);
    }
  }
  if (!result.ok) process.exitCode = 1;
}

async function backupCommand(args: string[], file: string, json: boolean): Promise<void> {
  const output = argValue(args, "--output");
  const result = await backupProvidersFile(file, output);
  if (!result.ok) {
    fail(result.error.message, result.error.code);
    return;
  }
  if (json) printJson({ ok: true, path: result.value.path });
  else console.log(result.value.path);
}

async function restoreCommand(args: string[], file: string, json: boolean): Promise<void> {
  const backupFile = args.find((a) => !a.startsWith("-"));
  if (!backupFile) {
    usageError("用法: pth config provider restore <file> [--yes]");
    return;
  }
  if (!hasFlag(args, "--yes")) {
    fail("restore 需要 --yes 确认", "CONFIRM_REQUIRED");
    return;
  }
  const result = await restoreProvidersFile(backupFile, file, { backup: true });
  if (!result.ok) {
    fail(result.error.message, result.error.code);
    return;
  }
  if (json) printJson({ ok: true, ...(result.value.backupPath ? { backupPath: result.value.backupPath } : {}) });
  else console.log("restored");
}

export async function configProviderCommand(rest: string[]): Promise<void> {
  jsonMode = hasFlag(rest, "--json");
  const json = jsonMode;
  const action = rest[0];
  if (!action) {
    usageError("用法: pth config provider <list|get|add|update|remove|validate|backup|restore> ...");
    return;
  }
  if (action === "test") {
    fail("pth config provider test 未实现（V1 不支持）", "NOT_IMPLEMENTED");
    return;
  }
  if (!checkWriteGuard(action)) return;

  const file = providersPath();

  switch (action) {
    case "list": return listProviders(rest.slice(1), file, json);
    case "get": return getProviderCommand(rest.slice(1), file, json);
    case "add": return addProviderCommand(rest.slice(1), file, json);
    case "update": return updateProviderCommand(rest.slice(1), file, json);
    case "remove": return removeProviderCommand(rest.slice(1), file, json);
    case "validate": return validateCommand(rest.slice(1), file, json);
    case "backup": return backupCommand(rest.slice(1), file, json);
    case "restore": return restoreCommand(rest.slice(1), file, json);
    default:
      usageError(`未知子命令: ${action}`);
  }
}
