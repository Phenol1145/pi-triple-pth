/**
 * runtime/runtime-doctor.ts —— P6-1 `pth doctor` 宿主机前置体检。
 *
 * 三态：pass（通过）/ warn（警告，不阻断）/ fail（阻断，给出修复命令）。
 * 所有外部命令经可注入 runner（默认 spawn），单测可完全离线。
 */
import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { constants } from "node:fs";
import { createConnection } from "node:net";
import { parseSecretsEnvFile } from "./runtime-secrets.js";
import { createSpawnRunner } from "./spawn-runner.js";
import { validatePthConfig } from "@away_from/pth-config";

export type DoctorStatus = "pass" | "warn" | "fail";

export interface DoctorItem {
  check: string;
  status: DoctorStatus;
  message: string;
  fix?: string;
}

export interface DoctorReport {
  ok: boolean;
  profile: string;
  items: DoctorItem[];
}

export interface DoctorRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type DoctorRunner = (
  cmd: string,
  argv: string[],
  opts?: { readonly input?: string },
) => Promise<DoctorRunResult>;

export interface DoctorOptions {
  repoRoot?: string;
  env?: NodeJS.ProcessEnv;
  runner?: DoctorRunner;
  fetchLike?: typeof fetch;
}

const CORE_SECRET_KEYS = [
  "SANDBOX_SHARED_SECRET",
  "PTH_EXECUTION_GRANT_SECRET",
  "PTH_MEMORY_BRIDGE_TOKEN",
  "POSTGRES_PASSWORD",
  "REDIS_PASSWORD",
] as const;

const OPTIONAL_SECRET_KEYS = ["LOCAL_EXEC_SHARED_SECRET", "JUPYTER_SERVICE_TOKEN"] as const;

export const DOCTOR_PROFILES = ["core", "tools", "lean4", "u8", "jupyter", "full"] as const;
export type DoctorProfile = (typeof DOCTOR_PROFILES)[number];

function defaultRunner(): DoctorRunner {
  return createSpawnRunner();
}

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

export function parseDoctorArgs(args: string[]): { profile: DoctorProfile; json: boolean } {
  const profileRaw = argValue(args, "--profile") ?? "core";
  if (!DOCTOR_PROFILES.includes(profileRaw as DoctorProfile)) {
    throw new Error(`unknown profile: ${profileRaw}（可选 ${DOCTOR_PROFILES.join("|")}）`);
  }
  return { profile: profileRaw as DoctorProfile, json: args.includes("--json") };
}

function wants(profile: DoctorProfile, kind: "tools" | "lean4" | "u8" | "jupyter"): boolean {
  return profile === kind || profile === "full";
}

/** C10（2026-08-22）：端口探测改「TCP 连接」而非「尝试 bind」——OrbStack/Docker
 *  端口代理下 bind 可能误报空闲；连上即占用，并对已知端口做 HTTP 指纹标注归属。 */
async function portProbe(port: number): Promise<{ occupied: boolean; owner?: string }> {
  const connected = await new Promise<boolean>((resolvePromise) => {
    const socket = createConnection({ host: "127.0.0.1", port, timeout: 800 });
    socket.once("connect", () => { socket.destroy(); resolvePromise(true); });
    socket.once("timeout", () => { socket.destroy(); resolvePromise(false); });
    socket.once("error", () => resolvePromise(false));
  });
  if (!connected) return { occupied: false };

  let owner: string | undefined;
  if (port === 3000) {
    try {
      const res = await fetch("http://127.0.0.1:3000/health", { signal: AbortSignal.timeout(1_000) });
      if (res.ok) owner = "pi-platform";
    } catch { /* 非 HTTP 或探测失败——仍视为占用 */ }
  } else if (port === 8888) {
    owner = "jupyter/jupyterlab";
  }
  return { occupied: true, ...(owner ? { owner } : {}) };
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function runDoctor(args: string[], options: DoctorOptions = {}): Promise<DoctorReport> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log([
      "用法: pth doctor [--profile core|tools|lean4|u8|jupyter|full] [--json]",
      "  --profile X   体检剖面（默认 core）",
      "  --json        输出 JSON 报告",
      "退出码：0=通过/仅警告，1=有阻断项",
    ].join("\n"));
    return { ok: true, profile: "core", items: [] };
  }
  const { profile, json } = parseDoctorArgs(args);
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const env = options.env ?? process.env;
  const runner = options.runner ?? defaultRunner();
  const items: DoctorItem[] = [];

  const add = (check: string, status: DoctorStatus, message: string, fix?: string) => {
    items.push(fix === undefined ? { check, status, message } : { check, status, message, fix });
  };

  // 1) docker / compose
  const docker = await runner("docker", ["version"]);
  if (docker.code !== 0) {
    add("docker", "fail", "docker 不可用", "安装/启动 Docker 后再试");
  } else {
    add("docker", "pass", "docker 可用");
  }
  const compose = await runner("docker", ["compose", "version"]);
  if (compose.code !== 0) {
    add("docker-compose", "fail", "docker compose 插件不可用", "安装 Docker Compose v2");
  } else {
    add("docker-compose", "pass", "docker compose 可用");
  }

  // 2) secrets
  const secretsPath = join(repoRoot, "deploy", ".env.pth.secrets");
  const secrets: Record<string, string> = {};
  try {
    Object.assign(secrets, parseSecretsEnvFile(await readFile(secretsPath, "utf8")));
  } catch {
    add("secrets", "fail", `secrets 文件缺失: ${secretsPath}`, "pth init（或 cp deploy/.env.pth.secrets.example deploy/.env.pth.secrets 后替换全部示例值）");
  }
  if (Object.keys(secrets).length > 0 || !items.some((i) => i.check === "secrets")) {
    const missing = CORE_SECRET_KEYS.filter((k) => !secrets[k]?.trim());
    if (missing.length > 0) {
      add("secrets", "fail", `核心密钥缺失: ${missing.join(", ")}`, `编辑 ${secretsPath} 补全后重试（或 pth init --force 重建模板）`);
    } else {
      const absentOptional = OPTIONAL_SECRET_KEYS.filter((k) => !secrets[k]?.trim());
      if (absentOptional.length > 0) {
        add("secrets", "warn", `可选后端密钥缺失: ${absentOptional.join(", ")}（不影响 core 栈启动）`, `编辑 ${secretsPath} 补全（起对应后端前必须 export）`);
      } else {
        add("secrets", "pass", "secrets 核心键完整");
      }
    }
  }

  // 3) PTH_WORKSPACES_HOST（env 优先，secrets 文件回退——W0 收口）
  const workspacesHost = env.PTH_WORKSPACES_HOST || secrets.PTH_WORKSPACES_HOST;
  if (!workspacesHost) {
    add("workspaces", "fail", "PTH_WORKSPACES_HOST 未设置（compose :? 必填）", "pth init --workspaces /abs/path/to/workspaces");
  } else {
    try {
      await access(workspacesHost, constants.W_OK);
      add("workspaces", "pass", `workspaces 可写: ${workspacesHost}`);
    } catch {
      add("workspaces", "fail", `workspaces 不可写: ${workspacesHost}`, "mkdir -p <路径> 并确认宿主目录属主（容器 node uid=1000）");
    }
  }

  // 3.5) C11 配置参量护栏（越界 warn 展示）
  const configIssues = validatePthConfig(env);
  const rangeIssues = configIssues.filter((i) => i.level === "warn" && i.message.includes("护栏范围"));
  if (rangeIssues.length > 0) {
    add("config-guardrails", "warn", `配置越界: ${rangeIssues.map((i) => i.key).join(", ")}`, "按护栏范围修正 env（资源型参数会自动 clamp/回退默认）");
  } else {
    add("config-guardrails", "pass", "配置护栏范围内");
  }

  // 4) 端口
  const ports: Array<[string, number]> = [["port-3000", 3000]];
  if (wants(profile, "jupyter")) ports.push(["port-8888", 8888]);
  for (const [check, port] of ports) {
    const probe = await portProbe(port);
    if (!probe.occupied) add(check, "pass", `端口 ${port} 空闲`);
    else add(check, "warn", `端口 ${port} 被占用${probe.owner ? `（${probe.owner}）` : ""}`, `lsof -i :${port} 查看占用进程`);
  }

  // 5) 镜像
  const images: Array<[string, string, string]> = [["image-engine", "pi-triple-pth:latest", "docker compose --env-file deploy/.env.pth.secrets -f deploy/docker-compose.yaml build"]];
  if (wants(profile, "jupyter")) images.push(["image-jupyter", "pi-triple-jupyter:dev", "docker compose -p pi-triple-jupyter -f deploy/services/jupyter/docker-compose.yaml build"]);
  for (const [check, image, fix] of images) {
    const inspected = await runner("docker", ["image", "inspect", image]);
    if (inspected.code !== 0) add(check, "warn", `镜像缺失: ${image}`, fix);
    else add(check, "pass", `镜像存在: ${image}`);
  }

  // 6) lean4
  if (wants(profile, "lean4")) {
    const lean = await runner("lean", ["--version"]);
    if (lean.code !== 0) {
      add("lean4-toolchain", "warn", "lean 不在 PATH（lean4 profile 需要 elan）", "安装 elan 并 export PATH=\"$HOME/.elan/bin:$PATH\"");
    } else {
      add("lean4-toolchain", "pass", (lean.stdout.trim() || "lean available").split("\n")[0] ?? "lean available");
    }
  }

  // 7) u8
  if (wants(profile, "u8")) {
    const u8Candidates = [
      join(repoRoot, "deploy", "local-exec", "u8", "u8"),
      join(repoRoot, "deploy", "local-exec", "u8", "U8final_C", "u8"),
    ];
    let built = false;
    for (const candidate of u8Candidates) {
      if (await isExecutable(candidate)) {
        built = true;
        add("u8-toolchain", "pass", `u8 已构建: ${candidate}`);
        break;
      }
    }
    if (!built) add("u8-toolchain", "warn", "u8 二进制未构建", `bash ${join("deploy", "local-exec", "u8", "build-u8.sh")}`);
  }

  // 8) tools manifest
  if (wants(profile, "tools")) {
    const manifestPath = join(repoRoot, "deploy", "tool-containers", "tool-manifest.json");
    try {
      const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as { domains?: unknown };
      if (parsed && typeof parsed === "object" && "domains" in parsed) add("tools-manifest", "pass", "tool-manifest.json 可解析");
      else add("tools-manifest", "fail", "tool-manifest.json 缺 domains", "核对 deploy/tool-containers/tool-manifest.json");
    } catch {
      add("tools-manifest", "fail", `tool-manifest.json 不可解析: ${manifestPath}`, "核对 deploy/tool-containers/tool-manifest.json");
    }
  }

  // 9) 数据层可达性（仅观察态；未启动不阻断）
  const envFile = join(repoRoot, "deploy", ".env.pth.secrets");
  const composeFile = join(repoRoot, "deploy", "docker-compose.yaml");
  const ps = await runner("docker", ["compose", "--env-file", envFile, "-f", composeFile, "ps", "--format", "json"]);
  const running = new Set<string>();
  for (const line of ps.stdout.split("\n").map((s) => s.trim()).filter(Boolean)) {
    try {
      const entry = JSON.parse(line) as { Service?: string; Name?: string; State?: string };
      const name = entry.Service ?? entry.Name ?? "";
      if (name && (entry.State === "running" || entry.State === "Up")) running.add(name);
    } catch {
      // 忽略无法解析的行
    }
  }
  if (running.size === 0) {
    add("data-layer", "warn", "数据层未运行（doctor 只体检；拉起由 pth up 编排）", "pth up --profile core");
  } else {
    const probes: Array<[string, string[]]> = [];
    if (running.has("postgres")) probes.push(["postgres", ["compose", "--env-file", envFile, "-f", composeFile, "exec", "-T", "postgres", "pg_isready", "-U", "pth", "-d", "pth"]]);
    if (running.has("redis")) probes.push(["redis", ["compose", "--env-file", envFile, "-f", composeFile, "exec", "-T", "redis", "sh", "-c", "redis-cli -a \"$REDIS_PASSWORD\" ping"]]);
    if (running.has("sandbox")) probes.push(["sandbox", ["compose", "--env-file", envFile, "-f", composeFile, "exec", "-T", "sandbox", "sh", "-c", "curl -sf http://localhost:8080/health"]]);
    if (probes.length === 0) {
      add("data-layer", "warn", "数据层无 postgres/redis/sandbox 运行项", "pth up --profile core");
    } else {
      let allOk = true;
      for (const [name, argv] of probes) {
        const result = await runner("docker", argv);
        if (result.code === 0) add(`data-${name}`, "pass", `${name} 探活通过`);
        else {
          allOk = false;
          add(`data-${name}`, "warn", `${name} 探活失败`, "docker compose logs <service> 排查");
        }
      }
      if (allOk) add("data-layer", "pass", "已运行的数据层服务探活通过");
    }
  }

  const ok = items.every((i) => i.status !== "fail");
  const report: DoctorReport = { ok, profile, items };

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const item of items) {
      const mark = item.status === "pass" ? "✅" : item.status === "warn" ? "⚠️ " : "❌";
      console.log(`${mark} ${item.check.padEnd(18)} ${item.message}`);
      if (item.fix) console.log(`   ↳ ${item.fix}`);
    }
    console.log("");
    console.log(ok
      ? `doctor ok（profile=${profile}${items.some((i) => i.status === "warn") ? "；有警告，按需修复" : ""}）`
      : `doctor 有阻断项（profile=${profile}）——修复上述 ❌ 后重试`);
  }
  return report;
}
