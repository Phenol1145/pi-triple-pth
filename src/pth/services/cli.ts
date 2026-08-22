/**
 * services/cli.ts —— `pth services` 命令实现（T2b：host 进程监督器 + compose 服务）。
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateServiceManifest, type HostServiceManifest, type ServiceManifest } from "./service-manifest.js";
import {
  defaultServiceRegistryPath,
  generateServiceToken,
  loadServiceRegistry,
  saveServiceRegistry,
  type HostServiceRuntimeEntry,
  type ServiceRegistryFile,
} from "./service-registry.js";
import {
  downHostService,
  statusHostService,
  tailServiceLog,
  upHostService,
} from "./service-supervisor.js";
import { realDockerRun } from "../tools/tool-compose.js";
import { pthConfig } from "../config/index.js";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SERVICES_DIR = resolve(pthConfig().str("PTH_SERVICES_DIR") || join(REPO_ROOT, "deploy", "services"));

export function discoverServiceManifests(dir = SERVICES_DIR): ServiceManifest[] {
  if (!existsSync(dir)) return [];
  const out: ServiceManifest[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(dir, entry.name, "service.json");
    if (existsSync(file)) out.push(validateServiceManifest(JSON.parse(readFileSync(file, "utf8"))));
  }
  return out;
}

function hostManifests(manifests: ServiceManifest[]): HostServiceManifest[] {
  return manifests.filter((m): m is HostServiceManifest => m.kind === "host");
}

function select(manifests: ServiceManifest[], ids: string[]): ServiceManifest[] {
  if (ids.length === 0) return manifests;
  const byId = new Map(manifests.map((m) => [m.id, m]));
  return ids.map((id) => {
    const found = byId.get(id);
    if (!found) throw new Error(`unknown service: ${id}`);
    return found;
  });
}

async function up(manifests: ServiceManifest[], ids: string[]): Promise<void> {
  let registry = loadServiceRegistry(defaultServiceRegistryPath());
  const selected = select(manifests, ids);
  for (const manifest of selected) {
    if (manifest.kind === "host") {
      let entry = registry.services[manifest.id];
      if (entry && (await statusHostService(entry)).running) {
        console.log(`${manifest.id}: already running（${entry.url}）`);
        continue;
      }
      const token = entry?.token ?? generateServiceToken();
      const result = await upHostService(manifest, { token });
      entry = result.entry;
      registry = { ...registry, updatedAt: new Date().toISOString(), services: { ...registry.services, [manifest.id]: entry } };
      saveServiceRegistry(registry, defaultServiceRegistryPath());
      console.log(`✅ ${manifest.id}: ${entry.url}（pid ${entry.pid}）`);
    } else {
      const composeFile = join(SERVICES_DIR, manifest.id, manifest.composeFile);
      if (!existsSync(composeFile)) {
        console.log(`${manifest.id}: compose 文件缺失（${composeFile}），跳过`);
        continue;
      }
      const result = await realDockerRun(["compose", "-p", manifest.projectName, "-f", composeFile, "up", "-d"]);
      if (result.code !== 0) {
        console.error(result.stderr || `${manifest.id} up failed`);
        process.exitCode = 1;
      } else console.log(`✅ ${manifest.id}: compose up`);
    }
  }
}

async function down(manifests: ServiceManifest[], ids: string[]): Promise<void> {
  let registry = loadServiceRegistry(defaultServiceRegistryPath());
  for (const manifest of select(manifests, ids)) {
    if (manifest.kind === "host") {
      const entry = registry.services[manifest.id];
      if (!entry) {
        console.log(`${manifest.id}: not running`);
        continue;
      }
      await downHostService(entry, manifest.stopGraceMs ?? 5_000);
      const services = { ...registry.services };
      delete services[manifest.id];
      registry = { ...registry, updatedAt: new Date().toISOString(), services };
      saveServiceRegistry(registry, defaultServiceRegistryPath());
      console.log(`✅ ${manifest.id}: stopped`);
    } else {
      const composeFile = join(SERVICES_DIR, manifest.id, manifest.composeFile);
      if (existsSync(composeFile)) {
        const result = await realDockerRun(["compose", "-p", manifest.projectName, "-f", composeFile, "down"]);
        if (result.code !== 0) process.exitCode = 1;
        else console.log(`✅ ${manifest.id}: compose down`);
      }
    }
  }
}

async function status(manifests: ServiceManifest[]): Promise<void> {
  const registry = loadServiceRegistry(defaultServiceRegistryPath());
  const rows = [["SERVICE", "KIND", "STATUS", "URL"]];
  for (const manifest of manifests) {
    if (manifest.kind === "host") {
      const entry = registry.services[manifest.id];
      const s = entry ? await statusHostService(entry) : { running: false, healthy: false, detail: "not-up" };
      rows.push([manifest.id, "host", s.running && s.healthy ? "healthy" : s.detail, entry?.url ?? "-"]);
    } else {
      rows.push([manifest.id, "compose", "compose", "-"]);
    }
  }
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  for (const row of rows) console.log(row.map((cell, i) => (cell ?? "").padEnd(widths[i]!)).join("  ").trimEnd());
}

async function logs(manifests: ServiceManifest[], ids: string[], tail: number): Promise<void> {
  const registry = loadServiceRegistry(defaultServiceRegistryPath());
  for (const manifest of select(manifests, ids.length ? ids : hostManifests(manifests).map((m) => m.id))) {
    if (manifest.kind !== "host") continue;
    const entry = registry.services[manifest.id];
    console.log(`── ${manifest.id}${entry ? `（${entry.logFile}）` : "（not-up）"} ──`);
    if (entry) process.stdout.write(tailServiceLog(entry, tail));
    console.log("");
  }
}

async function restart(manifests: ServiceManifest[], ids: string[]): Promise<void> {
  await down(manifests, ids);
  await up(manifests, ids);
}

function printUsage(): void {
  console.log([
    "pth services <list|up|down|status|logs|restart> [id…]",
    "  list            列出声明文件（host/compose）",
    "  up [id…]        启动 host 进程（健康轮询就绪）或 compose 服务",
    "  down [id…]      SIGTERM 宽限 → SIGKILL；compose down",
    "  status          pid 存活 + /health 探测",
    "  logs [id…]      宿主服务日志 tail（--tail n 可调）",
    "  restart [id…]   down + up",
  ].join("\n"));
}

export async function servicesCommand(args: string[]): Promise<void> {
  const sub = args[0] ?? "status";
  const rest = args.slice(1);
  const manifests = discoverServiceManifests();
  // 兼容：P5 jupyter compose 尚未写 service.json 时，维持“骨架待办”提示
  if (manifests.length === 0) {
    console.log("pth services：无 service.json 声明；jupyter 单容器双面部署物随 P5 落地");
    return;
  }
  const tailIdx = rest.indexOf("--tail");
  const tail = tailIdx >= 0 && tailIdx + 1 < rest.length ? Math.max(1, Number(rest[tailIdx + 1]) || 50) : 50;
  const ids = rest.filter((a, idx) => !a.startsWith("--") && idx !== tailIdx + 1);
  switch (sub) {
    case "list":
      for (const m of manifests) console.log(`${m.id}\t${m.kind}\t${m.description ?? ""}`);
      return;
    case "up": return up(manifests, ids);
    case "down": return down(manifests, ids);
    case "status": return status(manifests);
    case "logs": return logs(manifests, ids, tail);
    case "restart": return restart(manifests, ids);
    default: printUsage();
  }
}

export type { HostServiceRuntimeEntry, ServiceRegistryFile };
