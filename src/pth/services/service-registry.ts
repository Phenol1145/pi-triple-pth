/**
 * services/service-registry.ts —— ~/.pi-triple/services.json（0600，host 服务运行时事实）。
 *
 * 与 tool-containers.json 同目录、同纪律：token 本地生成、pid/port/log 运行时更新。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { pthConfig } from "@away_from/pth-config";

export interface HostServiceRuntimeEntry {
  id: string;
  url: string;
  port: number;
  token: string;
  pid: number;
  startedAt: number;
  logFile: string;
  pathMapping?: { hostRoot: string; execRoot: string };
}

export interface ServiceRegistryFile {
  schemaVersion: 1;
  updatedAt: string;
  services: Record<string, HostServiceRuntimeEntry>;
}

export class ServiceRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceRegistryError";
  }
}

export function defaultServiceRegistryPath(): string {
  const configured = pthConfig().str("PTH_SERVICE_REGISTRY_PATH");
  if (configured) return configured;
  return join(homedir(), ".pi-triple", "services.json");
}

export function defaultServiceLogDir(): string {
  return join(homedir(), ".pi-triple", "logs", "services");
}

function validEntry(value: unknown, id: string): value is HostServiceRuntimeEntry {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Record<string, unknown>;
  return e.id === id
    && typeof e.url === "string" && /^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(e.url)
    && typeof e.port === "number"
    && typeof e.token === "string" && e.token.length >= 16
    && typeof e.pid === "number" && e.pid > 0
    && typeof e.startedAt === "number"
    && typeof e.logFile === "string";
}

export function loadServiceRegistry(path = defaultServiceRegistryPath()): ServiceRegistryFile {
  if (!existsSync(path)) return { schemaVersion: 1, updatedAt: "", services: {} };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new ServiceRegistryError(`service registry ${path} 不可解析: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof raw !== "object" || raw === null || (raw as { schemaVersion?: unknown }).schemaVersion !== 1) {
    throw new ServiceRegistryError(`service registry ${path} schemaVersion 非法`);
  }
  const services: Record<string, HostServiceRuntimeEntry> = {};
  const rawServices = (raw as { services?: unknown }).services;
  if (typeof rawServices === "object" && rawServices !== null) {
    for (const [id, value] of Object.entries(rawServices as Record<string, unknown>)) {
      if (!validEntry(value, id)) throw new ServiceRegistryError(`service registry 条目非法: ${id}`);
      services[id] = value;
    }
  }
  return {
    schemaVersion: 1,
    updatedAt: typeof (raw as { updatedAt?: unknown }).updatedAt === "string" ? (raw as { updatedAt: string }).updatedAt : "",
    services,
  };
}

export function saveServiceRegistry(file: ServiceRegistryFile, path = defaultServiceRegistryPath()): void {
  const next: ServiceRegistryFile = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    services: Object.fromEntries(Object.entries(file.services).sort(([a], [b]) => a.localeCompare(b))),
  };
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
  try { chmodSync(path, 0o600); } catch { /* 忽略平台差异 */ }
}

export function generateServiceToken(): string {
  return `svc-${randomBytes(24).toString("base64url")}`;
}
