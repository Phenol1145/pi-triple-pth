/**
 * tools/tool-registry.ts —— 宿主回环注册表 `~/.pi-triple/tool-containers.json`（T2）。
 *
 * pth CLI 维护：实际动态端口 + 本地生成的 token（0600，绝不随 manifest/镜像迁移）。
 * 结构 fail-closed：损坏/非法文件不产生半真半假事实。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { pthConfig } from "@away_from/pth-config";
import { TOOL_CONTAINER_DOMAINS, type ToolContainerDomain } from "./tool-manifest.js";

export interface ToolRegistryEntry {
  tool: string;
  domain: ToolContainerDomain;
  backendId: string;
  /** 宿主回环端点（http://127.0.0.1:<port>） */
  url: string;
  port: number;
  token: string;
  updatedAt: string;
}

export interface DomainTokens {
  hostToken: string;
  engineToken?: string;
}

export interface ToolRegistryFile {
  schemaVersion: 1;
  updatedAt: string;
  tools: Record<string, ToolRegistryEntry>;
  domainTokens: Partial<Record<ToolContainerDomain, DomainTokens>>;
}

export class ToolRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolRegistryError";
  }
}

export function defaultToolRegistryPath(): string {
  const configured = pthConfig().str("PTH_TOOL_REGISTRY_PATH");
  if (configured) return configured;
  return join(homedir(), ".pi-triple", "tool-containers.json");
}

function validEntry(value: unknown, tool: string): value is ToolRegistryEntry {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Record<string, unknown>;
  return e.tool === tool
    && (TOOL_CONTAINER_DOMAINS as readonly string[]).includes(String(e.domain))
    && typeof e.backendId === "string" && e.backendId.length > 0
    && typeof e.url === "string" && /^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(e.url)
    && typeof e.port === "number"
    && typeof e.token === "string" && e.token.length >= 16
    && typeof e.updatedAt === "string";
}

export function loadToolRegistry(path = defaultToolRegistryPath()): ToolRegistryFile {
  if (!existsSync(path)) return { schemaVersion: 1, updatedAt: "", tools: {}, domainTokens: {} };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new ToolRegistryError(`tool registry ${path} 不可解析: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof raw !== "object" || raw === null || (raw as { schemaVersion?: unknown }).schemaVersion !== 1) {
    throw new ToolRegistryError(`tool registry ${path} schemaVersion 非法`);
  }
  const file = raw as { updatedAt?: unknown; tools?: unknown; domainTokens?: unknown };
  const tools: Record<string, ToolRegistryEntry> = {};
  if (typeof file.tools === "object" && file.tools !== null) {
    for (const [tool, value] of Object.entries(file.tools as Record<string, unknown>)) {
      if (!validEntry(value, tool)) throw new ToolRegistryError(`tool registry 条目非法: ${tool}`);
      tools[tool] = value;
    }
  }
  const domainTokens: ToolRegistryFile["domainTokens"] = {};
  if (typeof file.domainTokens === "object" && file.domainTokens !== null) {
    for (const [domain, value] of Object.entries(file.domainTokens as Record<string, unknown>)) {
      if (!(TOOL_CONTAINER_DOMAINS as readonly string[]).includes(domain)) continue;
      if (typeof value !== "object" || value === null
        || typeof (value as { hostToken?: unknown }).hostToken !== "string"
        || ((value as { hostToken?: string }).hostToken?.length ?? 0) < 16) {
        throw new ToolRegistryError(`tool registry domainTokens 非法: ${domain}`);
      }
      const v = value as { hostToken: string; engineToken?: unknown };
      domainTokens[domain as ToolContainerDomain] = {
        hostToken: v.hostToken,
        ...(typeof v.engineToken === "string" ? { engineToken: v.engineToken } : {}),
      };
    }
  }
  return {
    schemaVersion: 1,
    updatedAt: typeof file.updatedAt === "string" ? file.updatedAt : "",
    tools,
    domainTokens,
  };
}

export function saveToolRegistry(file: ToolRegistryFile, path = defaultToolRegistryPath()): void {
  const next: ToolRegistryFile = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    tools: Object.fromEntries(Object.entries(file.tools).sort(([a], [b]) => a.localeCompare(b))),
    domainTokens: file.domainTokens ?? {},
  };
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
  try { chmodSync(path, 0o600); } catch { /* 平台不支持时保持写权限即可 */ }
}

export function generateToolToken(): string {
  return `tool-${randomBytes(24).toString("base64url")}`;
}

export function upsertToolRegistryEntry(
  file: ToolRegistryFile,
  entry: Omit<ToolRegistryEntry, "updatedAt">,
): ToolRegistryFile {
  const updatedAt = new Date().toISOString();
  return {
    ...file,
    updatedAt,
    tools: { ...file.tools, [entry.tool]: { ...entry, updatedAt } },
  };
}

export function removeToolRegistryEntry(file: ToolRegistryFile, tool: string): ToolRegistryFile {
  if (!file.tools[tool]) return file;
  const tools = { ...file.tools };
  delete tools[tool];
  return { ...file, updatedAt: new Date().toISOString(), tools };
}

/** 每域 token 只在本机生成/持久（0600）；up 后存活，绝不随 manifest/镜像迁移。 */
export function ensureDomainTokens(
  file: ToolRegistryFile,
  domains: readonly ToolContainerDomain[],
): ToolRegistryFile {
  const domainTokens = { ...(file.domainTokens ?? {}) };
  for (const domain of domains) {
    if (!domainTokens[domain] || domainTokens[domain]!.hostToken.length < 16) {
      domainTokens[domain] = {
        hostToken: generateToolToken(),
        ...(domain !== "secrets" ? { engineToken: generateToolToken() } : {}),
      };
    }
  }
  return { ...file, updatedAt: new Date().toISOString(), domainTokens };
}
