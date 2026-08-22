/**
 * services/cli.ts —— `pth services` 命令实现（T2b：host 进程监督器 + compose 服务）。
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateServiceManifest, type HostServiceManifest, type ServiceManifest } from "./service-manifest.js";
import {
  defaultServiceLogDir,
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
  buildHostServiceEnvironment,
} from "./service-supervisor.js";
import {
  installLaunchdService,
  isLaunchdInstalled,
  launchdPlistPath,
  statusLaunchdService,
  uninstallLaunchdService,
} from "./launchd.js";
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

/**
 * token 解析顺序（T2b 修正）：
 *  tokenEnv 指定的环境变量非空 → 用它（compose `--env-file` 与宿主服务同源，显式 backend 可用）；
 *  否则沿用 registry 既有 token（服务不重建时稳定）；都没有才生成新 token。
 */
export function resolveServiceToken(
  entry: HostServiceRuntimeEntry | undefined,
  tokenEnv: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (tokenEnv !== undefined) {
    const configured = env[tokenEnv];
    if (configured && configured.trim() !== "") return configured;
  }
  return entry?.token ?? generateServiceToken();
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
      const token = resolveServiceToken(entry, manifest.tokenEnv);
      const serviceDir = join(SERVICES_DIR, manifest.id);
      const pathDirs = manifest.pathDirs?.map((p) => resolve(serviceDir, p));
      const result = await upHostService(manifest, { token, ...(pathDirs?.length ? { pathDirs } : {}) });
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
        if (result.code !== 0) {
          console.error(`❌ ${manifest.id}: compose down 失败（exit ${result.code}）`);
          if (result.stderr.trim()) console.error(result.stderr.trim());
          else if (result.stdout.trim()) console.error(result.stdout.trim());
          process.exitCode = 1;
        } else console.log(`✅ ${manifest.id}: compose down`);
      }
    }
  }
}

async function composePsState(manifest: ServiceManifest & { kind: "compose" }): Promise<{ name?: string; state: string; health?: string }> {
  const composeFile = join(SERVICES_DIR, manifest.id, manifest.composeFile);
  const envFile = join(REPO_ROOT, "deploy", ".env.pth.secrets");
  const args = ["compose"];
  if (existsSync(envFile)) args.push("--env-file", envFile);
  args.push("-p", manifest.projectName, "-f", composeFile, "ps", "--format", "json");
  const result = await realDockerRun(args);
  if (result.code !== 0) return { state: "unknown" };
  for (const line of result.stdout.split("\n").map((s) => s.trim()).filter(Boolean)) {
    try {
      const e = JSON.parse(line) as { Service?: string; Name?: string; State?: string; Health?: string };
      if (!e.State) continue;
      return { name: e.Name, state: e.State, ...(e.Health ? { health: e.Health } : {}) };
    } catch { /* 忽略非 JSON 行 */ }
  }
  return { state: "not-running" };
}

async function status(manifests: ServiceManifest[]): Promise<void> {
  const registry = loadServiceRegistry(defaultServiceRegistryPath());
  const rows = [["SERVICE", "KIND", "STATUS", "URL", "LAUNCHD"]];
  for (const manifest of manifests) {
    if (manifest.kind === "host") {
      const entry = registry.services[manifest.id];
      const s = entry ? await statusHostService(entry) : { running: false, healthy: false, detail: "not-up" };
      const ld = await statusLaunchdService(manifest.id);
      rows.push([manifest.id, "host", s.running && s.healthy ? "healthy" : s.detail, entry?.url ?? "-", ld.installed ? (ld.loaded ? "installed/loaded" : "installed/unloaded") : "-"]);
    } else {
      const cs = await composePsState(manifest);
      const health = cs.health && cs.health !== "" ? `${cs.state}/${cs.health}` : cs.state;
      rows.push([manifest.id, "compose", health, "-", "-"]);
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

async function install(manifests: ServiceManifest[], ids: string[]): Promise<void> {
  const registry = loadServiceRegistry(defaultServiceRegistryPath());
  for (const manifest of select(manifests, ids)) {
    if (manifest.kind !== "host") {
      console.error(`❌ ${manifest.id}: 只有 host 服务可 launchd 托管（compose 服务由 Docker restart policy 负责）`);
      process.exitCode = 1;
      continue;
    }
    const entry = registry.services[manifest.id];
    if (entry && (await statusHostService(entry)).running) {
      console.error(`❌ ${manifest.id}: 正在由监督器运行——先 pth services down ${manifest.id} 再 install（二选一托管）`);
      process.exitCode = 1;
      continue;
    }
    if (isLaunchdInstalled(manifest.id)) {
      console.log(`${manifest.id}: 已存在 launchd plist，先卸载旧的再重装`);
      await uninstallLaunchdService(manifest.id);
    }
    const token = resolveServiceToken(entry, manifest.tokenEnv);
    const serviceDir = join(SERVICES_DIR, manifest.id);
    const pathDirs = manifest.pathDirs?.map((p) => resolve(serviceDir, p));
    const env = buildHostServiceEnvironment(manifest, token, pathDirs?.length ? { pathDirs } : {});
    const logFile = entry?.logFile ?? join(defaultServiceLogDir(), `${manifest.id}.log`);
    await installLaunchdService(manifest, env, { logFile });
    console.log(`✅ ${manifest.id}: launchd 已安装（${launchdPlistPath(manifest.id)}；日志 ${logFile}）`);
  }
}

async function uninstall(manifests: ServiceManifest[], ids: string[]): Promise<void> {
  for (const manifest of select(manifests, ids)) {
    if (manifest.kind !== "host") {
      console.error(`❌ ${manifest.id}: 只有 host 服务有 launchd 托管`);
      process.exitCode = 1;
      continue;
    }
    if (!isLaunchdInstalled(manifest.id)) {
      console.log(`${manifest.id}: launchd 未安装`);
      continue;
    }
    await uninstallLaunchdService(manifest.id);
    console.log(`✅ ${manifest.id}: launchd 已卸载`);
  }
}

function printUsage(): void {
  console.log([
    "pth services <list|up|down|status|logs|restart|install|uninstall> [id…]",
    "  list            列出声明文件（host/compose）",
    "  up [id…]        启动 host 进程（健康轮询就绪）或 compose 服务",
    "  down [id…]      SIGTERM 宽限 → SIGKILL；compose down",
    "  status          pid 存活 + /health 探测 + launchd 托管状态",
    "  logs [id…]      宿主服务日志 tail（--tail n 可调）",
    "  restart [id…]   down + up",
    "  install [id…]   生成 LaunchAgent plist 并 launchctl bootstrap（仅 host；需先 down）",
    "  uninstall [id…] launchctl bootout + 删除 plist（回到监督器模式）",
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
  const ids = rest.filter((a, idx) => !a.startsWith("--") && !(tailIdx >= 0 && idx === tailIdx + 1));
  switch (sub) {
    case "list":
      for (const m of manifests) console.log(`${m.id}\t${m.kind}\t${m.description ?? ""}`);
      return;
    case "up": return up(manifests, ids);
    case "down": return down(manifests, ids);
    case "status": return status(manifests);
    case "logs": return logs(manifests, ids, tail);
    case "restart": return restart(manifests, ids);
    case "install": return install(manifests, ids);
    case "uninstall": return uninstall(manifests, ids);
    default: printUsage();
  }
}

export type { HostServiceRuntimeEntry, ServiceRegistryFile };
