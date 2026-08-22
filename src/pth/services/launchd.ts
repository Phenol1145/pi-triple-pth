/**
 * services/launchd.ts —— macOS LaunchAgent 托管（B4：宿主服务自恢复）。
 *
 * 与 service-supervisor 的「监督器模式」二选一：install 前要求服务已 down；
 * uninstall 后回到监督器模式。环境变量与 upHostService 完全同源（tokenEnv +
 * pathDirs PATH + pathMapping execRoot），保证 launchd 重启后进程面一致。
 */

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { HostServiceManifest } from "./service-manifest.js";

export function launchAgentDir(): string {
  return join(homedir(), "Library", "LaunchAgents");
}

export function launchdLabel(id: string): string {
  return `com.awayfrom.pth.${id}`;
}

export function launchdPlistPath(id: string): string {
  return join(launchAgentDir(), `${launchdLabel(id)}.plist`);
}

export function isLaunchdInstalled(id: string): boolean {
  return existsSync(launchdPlistPath(id));
}

export function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function resolvePthBinary(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.PTH_PTH_BIN;
  if (explicit) return explicit;
  const path = env.PATH ?? "";
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, "pth");
    if (existsSync(candidate)) return candidate;
  }
  return "/usr/local/bin/pth";
}

export interface LaunchdPlistOptions {
  env: NodeJS.ProcessEnv;
  logFile: string;
  workingDirectory?: string;
  pthBin?: string;
}

/** 纯函数：渲染 LaunchAgent plist（单测覆盖；不触碰 launchctl）。 */
export function renderLaunchdPlist(manifest: HostServiceManifest, options: LaunchdPlistOptions): string {
  const pthBin = options.pthBin ?? resolvePthBinary(options.env);
  const command = manifest.command.map((c) => (c === "pth" ? pthBin : c));
  const envEntries = Object.entries(options.env)
    .filter(([, v]) => typeof v === "string" && v.length > 0)
    .map(([k, v]) => `    <key>${xmlEscape(k)}</key>\n    <string>${xmlEscape(v as string)}</string>`)
    .join("\n");
  const args = command.map((c) => `    <string>${xmlEscape(c)}</string>`).join("\n");

  return [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
    "<plist version=\"1.0\">",
    "<dict>",
    `  <key>Label</key>\n  <string>${xmlEscape(launchdLabel(manifest.id))}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    args,
    "  </array>",
    "  <key>WorkingDirectory</key>",
    `  <string>${xmlEscape(options.workingDirectory ?? homedir())}</string>`,
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    envEntries,
    "  </dict>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <true/>",
    "  <key>StandardOutPath</key>",
    `  <string>${xmlEscape(options.logFile)}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${xmlEscape(options.logFile)}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

function currentUid(): number {
  if (typeof process.getuid === "function") return process.getuid()!;
  const res = spawnSync("id", ["-u"], { encoding: "utf8" });
  return Number((res.stdout ?? "").trim() || NaN);
}

function launchctl(args: string[]): { code: number; stdout: string; stderr: string } {
  const res = spawnSync("launchctl", args, { encoding: "utf8" });
  return { code: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function launchdLoadedInDomain(domain: "gui" | "user", uid: number, label: string): boolean {
  const print = launchctl(["print", `${domain}/${uid}/${label}`]);
  return print.code === 0;
}

function launchdLoadedAnywhere(uid: number, label: string): boolean {
  if (launchdLoadedInDomain("gui", uid, label)) return true;
  if (launchdLoadedInDomain("user", uid, label)) return true;
  // 兜底：当前会话 launchctl list 可见即视为已加载
  const list = launchctl(["list"]);
  return list.code === 0 && list.stdout.split("\n").some((line) => line.includes(label));
}

export interface LaunchdInstallResult {
  plistPath: string;
  loaded: boolean;
}

export async function installLaunchdService(
  manifest: HostServiceManifest,
  env: NodeJS.ProcessEnv,
  options: { logFile: string; workingDirectory?: string; pthBin?: string },
): Promise<LaunchdInstallResult> {
  const dir = launchAgentDir();
  mkdirSync(dir, { recursive: true });
  const plistPath = launchdPlistPath(manifest.id);
  writeFileSync(plistPath, renderLaunchdPlist(manifest, { env, logFile: options.logFile, workingDirectory: options.workingDirectory, pthBin: options.pthBin }), { mode: 0o600 });
  chmodSync(plistPath, 0o600);

  const uid = currentUid();
  const label = launchdLabel(manifest.id);
  const targetGui = `gui/${uid}`;
  const targetUser = `user/${uid}`;

  // 现代 macOS：bootstrap 到 gui（GUI 会话）→ 失败再试 user 域；必须真加载成功才算装好。
  const bootGui = launchctl(["bootstrap", targetGui, plistPath]);
  if (bootGui.code !== 0) {
    const bootUser = launchctl(["bootstrap", targetUser, plistPath]);
    if (bootUser.code !== 0) {
      const load = launchctl(["load", plistPath]);
      if (load.code !== 0 || !launchdLoadedAnywhere(uid, label)) {
        rmSync(plistPath, { force: true });
        throw new Error(
          `launchd 加载失败（当前会话可能无 GUI launchd 域）: bootstrap gui=${bootGui.stderr.trim() || bootGui.code}；` +
          `bootstrap user=${bootUser.stderr.trim() || bootUser.code}；load=${load.stderr.trim() || load.code}`,
        );
      }
    }
  }

  if (!launchdLoadedAnywhere(uid, label)) {
    rmSync(plistPath, { force: true });
    throw new Error(`launchd 加载失败：bootstrap 返回 0 但服务未注册（label=${label}）`);
  }
  return { plistPath, loaded: true };
}

export async function uninstallLaunchdService(id: string): Promise<{ plistPath: string; removed: boolean }> {
  const plistPath = launchdPlistPath(id);
  const removed = existsSync(plistPath);
  const uid = currentUid();
  const target = `gui/${uid}`;
  const boot = launchctl(["bootout", target, plistPath]);
  if (boot.code !== 0) {
    // 未加载/已卸载时可接受；仍继续删文件
    const unload = launchctl(["unload", plistPath]);
    void unload;
  }
  if (removed) rmSync(plistPath, { force: true });
  return { plistPath, removed };
}

export interface LaunchdStatus {
  installed: boolean;
  loaded: boolean;
}

export async function statusLaunchdService(id: string): Promise<LaunchdStatus> {
  const installed = isLaunchdInstalled(id);
  if (!installed) return { installed, loaded: false };
  const uid = currentUid();
  return { installed, loaded: launchdLoadedAnywhere(uid, launchdLabel(id)) };
}

/** 读取已生成 plist 的 env（供状态展示/调试；文件不存在返回 null）。 */
export function readLaunchdPlist(id: string): string | null {
  const p = launchdPlistPath(id);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}
