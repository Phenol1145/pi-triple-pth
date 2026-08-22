#!/usr/bin/env node
/**
 * pth-cli —— PTH 任务派发 CLI（2026-08-12：消除裸 curl 派发摩擦）
 *
 * 用法（pth <cmd> ...）：
 *   pth init [--force]                          # 初始化 deploy/.env.pth.secrets
 *   pth up [--rebuild] [--no-seed-token]        # compose 拉起 PTH 全栈并验证
 *   pth up --profile core|tools|lean4|u8|jupyter|full [--with a,b] [--without a,b]  # P6 统一编排
 *   pth down [--volumes]                        # 停止 PTH 栈
 *   pth status [--port <n>]                     # 栈健康（带 taskId 仍查任务）
 *   pth status --all                             # 栈 + tools + services + runtime 聚合
 *   pth doctor [--profile X] [--json]            # 宿主机前置体检（P6-1）
 *   pth logs [service] [--tail n] [--follow]    # 查看容器日志
 *   pth submit <任务描述> [--role <角色>] [--tags a,b] [--title <标题>] [--file <路径>]
 *   pth submit --template <模板id> [--param key=value]... [--tags a,b]
 *   pth status <taskId>
 *   pth wait <taskId> [--timeout <秒>]        # 轮询到 completed + 打印 result
 *   pth roles                                   # 列出可派发角色（含 governance——显式 flow）
 *   pth config                                  # 配置分组表（secret 打码）
 *   pth config export [--include-token]         # PTL 信息迁移命令
 *
 * 环境变量：PTH_API（缺省 http://localhost:3000）/ PTH_TOKEN（缺省 test-token-123）
 *   / PTH_CREATED_BY（缺省 cli）
 *
 * 示例：
 *   pth init && pth up    # 一条命令起全栈
 *   pth submit "统计 memory 库 scorecard 数" --role memory-stats --tags stats
 *   pth submit "写 README" --role writer --tags write --title "README"
 *   pth submit --template recon-doc --param url=https://go.dev/ref/spec --param entryId=go-spec
 *   pth wait <id>                    # 完成即返回（含 result）
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const API = process.env.PTH_API ?? "http://localhost:3000";
const TOKEN = process.env.PTH_TOKEN ?? "test-token-123";
const CREATED_BY = process.env.PTH_CREATED_BY ?? "cli";
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

const [, , cmd, ...rest] = process.argv;

/** 是否存在位置参数（跳过 --flag value 的 value）。 */
function hasPositional(args: string[], valuedFlags: string[]): boolean {
  const flags = new Set(valuedFlags);
  for (let i = 0; i < args.length; i += 1) {
    if (args[i]!.startsWith("-")) {
      if (flags.has(args[i]!)) i += 1;
      continue;
    }
    return true;
  }
  return false;
}

async function http(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown;
  try { json = JSON.parse(text); } catch { json = text; }
  if (!res.ok) {
    const msg = (json as { message?: string })?.message ?? text;
    throw new Error(`HTTP ${res.status}: ${msg}`);
  }
  return json;
}

function arg(name: string): string | undefined {
  const i = rest.indexOf(name);
  return i >= 0 && i + 1 < rest.length ? rest[i + 1] : undefined;
}

async function submit(): Promise<void> {
  // 模板发布（任务模板统一收口 A+）：--template <id> [--param k=v]... —— 与直接发布共用同一 HTTP 模板通道
  const template = arg("--template");
  if (template) {
    const tagsRaw = arg("--tags");
    const tags = tagsRaw ? tagsRaw.split(",").map((s) => s.trim()).filter(Boolean) : [];
    const params: Record<string, unknown> = {};
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] !== "--param") continue;
      const raw = rest[i + 1];
      if (!raw) throw new Error("--param 用法: --param key=value");
      const eq = raw.indexOf("=");
      if (eq <= 0) throw new Error(`--param 需 key=value 形式（收到: ${raw}）`);
      params[raw.slice(0, eq)] = raw.slice(eq + 1);
      i++;
    }
    const t = await http("POST", "/api/v1/kernel/tasks", {
      template,
      params,
      createdBy: CREATED_BY,
      ...(tags.length > 0 ? { tags } : {}),
    });
    const d = t as { id?: string; status?: string; assigned_role?: string };
    console.log(`task: ${d.id} | status: ${d.status ?? "?"} | role: ${d.assigned_role ?? (tags.length > 0 ? tags.join(",") : `[template:${template}]`)}`);
    return;
  }

  const desc = rest.find((a) => !a.startsWith("-"));
  if (!desc) throw new Error("用法: pth submit <任务描述> [--concept] [--role r] [--tags a,b] [--title t] [--file p] 或 pth submit --template <id> [--param k=v]...");
  let role = arg("--role");
  const tagsRaw = arg("--tags");
  const title = arg("--title") ?? (desc.length > 60 ? `${desc.slice(0, 57)}…` : desc);
  const file = arg("--file");
  const concept = rest.includes("--concept");
  let text = desc;
  if (file) {
    const extra = await readFile(file, "utf8");
    text = concept ? extra : `${desc}\n\n【任务详情】\n${extra}`;
  }
  const tags = tagsRaw ? tagsRaw.split(",").map((s) => s.trim()).filter(Boolean) : [];
  if (concept) {
    // D3 / T9：概念设计交接——PTL 侧完整理解需求 → PTH 生成实施方案
    const { validateConceptDesign, CONCEPT_DESIGN_TEMPLATE } = await import("../pth/kernel/concept-design.js");
    const check = validateConceptDesign(text);
    if (!check.ok) {
      throw new Error(`概念设计不完整，缺少段落: ${check.missing.join(", ")}\n\n模板:\n${CONCEPT_DESIGN_TEMPLATE}`);
    }
    if (!role) role = "planner";                 // 概念设计缺省路由 planner（PTH 生成实施方案）
    if (!tags.includes("concept-design")) tags.push("concept-design");
  }
  if (!role && tags.length === 0) throw new Error("需 --role 或 --tags 至少其一（路由依据）");
  const payload: Record<string, unknown> = {};
  if (role) payload.flow = { stages: [{ task: { role } }] };
  const t = await http("POST", "/api/v1/kernel/tasks", { title, text, createdBy: CREATED_BY, tags, payload });
  const d = t as { id?: string; status?: string; assigned_role?: string };
  console.log(`task: ${d.id} | status: ${d.status ?? "?"} | role: ${d.assigned_role ?? role ?? tags.join(",")}`);
}

async function handoff(): Promise<void> {
  const { CONCEPT_DESIGN_TEMPLATE } = await import("../pth/kernel/concept-design.js");
  console.log(CONCEPT_DESIGN_TEMPLATE);
}

async function status(): Promise<void> {
  const id = rest.find((a) => !a.startsWith("-"));
  if (!id) throw new Error("用法: pth status <taskId>");
  const t = (await http("GET", `/api/v1/kernel/tasks/${id}`)) as { status?: string; assigned_role?: string };
  console.log(`task: ${id} | status: ${t.status} | role: ${t.assigned_role ?? "?"}`);
}

async function wait(): Promise<void> {
  const id = rest.find((a) => !a.startsWith("-"));
  const timeoutSec = Number(arg("--timeout") ?? "900");
  if (!id) throw new Error("用法: pth wait <taskId> [--timeout 秒]");
  const deadline = Date.now() + timeoutSec * 1000;
  for (;;) {
    const t = (await http("GET", `/api/v1/kernel/tasks/${id}`)) as {
      status?: string; payload?: { outputRef?: { ref?: unknown } };
    };
    if (t.status === "completed" || t.status === "failed" || t.status === "rejected") {
      console.log(`task: ${id} | status: ${t.status}`);
      const ref = t.payload?.outputRef?.ref;
      if (ref !== undefined) console.log(JSON.stringify(ref, null, 2));
      process.exit(t.status === "completed" ? 0 : 1);
    }
    if (Date.now() > deadline) throw new Error(`超时（${timeoutSec}s）——任务仍在 ${t.status}`);
    await new Promise((r) => setTimeout(r, 10_000));
  }
}

async function roles(): Promise<void> {
  const { allKnownRoles, setDefaultRoles } = await import("../pth/kernel/execution/worker-cluster.js");
  const { ORIGIN_ROLE, DEFAULT_ROLES, MID_ROLES, GOVERNANCE_ROLES } = await import("../pth/impls/roles/default-roles.js");
  setDefaultRoles(ORIGIN_ROLE, DEFAULT_ROLES, MID_ROLES, GOVERNANCE_ROLES);   // 2026-08-13 审计 P2：CLI 本地角色面同样走注入
  console.log("可派发角色（--role 指定；governance 需 PTH_WORKER_ROLES 显式启用进 batch）:");
  for (const r of allKnownRoles()) {
    console.log(`  ${r.id.padEnd(22)} tags=[${r.tags.join(",")}]  ${r.description ?? ""}`);
  }
}

async function configList(): Promise<void> {
  // 配置集中化 C4：schema 是唯一真相源——分组打印当前有效值（secret 打码）
  const { PTH_CONFIG_SCHEMA, pthConfig } = await import("../pth/config/index.js");
  const cfg = pthConfig();
  const groups = new Map<string, typeof PTH_CONFIG_SCHEMA>();
  for (const def of PTH_CONFIG_SCHEMA) {
    const arr = groups.get(def.group) ?? [];
    arr.push(def);
    groups.set(def.group, arr);
  }
  console.log("PTH 配置（schema 唯一真相源 · secret 打码 · runtime=可运行时调整）:\n");
  for (const [group, defs] of [...groups.entries()].sort()) {
    console.log(`[${group}]`);
    for (const def of defs) {
      const value = def.secret ? "***" : cfg.str(def.key);
      console.log(`  ${def.key.padEnd(36)} = ${value.padEnd(24)} default=${String(def.default).padEnd(16)} ${def.runtime ? "runtime" : ""}  ${def.description}`);
    }
    console.log("");
  }
}

async function configExport(): Promise<void> {
  // PTL 信息迁移通道：输出 ptl config set 命令（token 默认不打；--include-token 显式导出）
  const { exportPtlMigration } = await import("../pth/config/index.js");
  const lines = exportPtlMigration(process.env, rest.includes("--include-token"));
  console.log("PTL 迁移命令（复制执行）:");
  for (const l of lines) console.log(`  ${l}`);
}

async function bridgeArgs() {
  const { parseCommandArgs } = await import("@away_from/pth-console");
  return parseCommandArgs(rest);
}

/** pth program submit|run|list —— 原 ptl hub submit/run/programs 的 PTH 交互面。 */
async function programCommand(): Promise<void> {
  const { flags, passthrough } = await bridgeArgs();
  const sub = passthrough[0];
  const args = passthrough.slice(1);
  if (sub === "submit") {
    const { cmdSubmit } = await import("@away_from/pth-console");
    await cmdSubmit(args, flags);
    return;
  }
  if (sub === "run") {
    const { cmdRun } = await import("@away_from/pth-console");
    await cmdRun(args[0] ?? "", args.slice(1), flags);
    return;
  }
  if (sub === "list") {
    const { cmdPrograms } = await import("@away_from/pth-console");
    await cmdPrograms(flags);
    return;
  }
  console.log("  用法: pth program <submit|run|list> …");
}

/** pth job submit|status|fetch —— 原 ptl hub job。 */
async function jobCommand(): Promise<void> {
  const { flags, passthrough } = await bridgeArgs();
  const { cmdHubJobSubmit, cmdHubJobStatus, cmdHubJobFetch } = await import("@away_from/pth-console");
  const [sub, ...args] = passthrough;
  if (sub === "submit") return cmdHubJobSubmit(args, flags);
  if (sub === "status") return cmdHubJobStatus(args, flags);
  if (sub === "fetch") return cmdHubJobFetch(args, flags);
  console.log("  用法: pth job submit <计划> [--tasks n] | status [id] | fetch <id>");
}

/** pth kernel … —— 原 ptl hub kernel 命令族。 */
async function kernelCommand(): Promise<void> {
  const { flags, passthrough } = await bridgeArgs();
  const mod = await import("@away_from/pth-console");
  const [sub, ...args] = passthrough;
  switch (sub) {
    case "tasks":
      if (args[0] === "add") return mod.cmdKernelTasksAdd(args.slice(1), flags);
      if (args[0] === "ls") return mod.cmdKernelTasksLs(flags);
      if (args[0] === "cancel") return mod.cmdKernelTasksCancel(args.slice(1), flags);
      console.log("  用法: pth kernel tasks add \"<描述>\" [--tags a,b] | ls [--limit n] | cancel <id> [--recursive]");
      return;
    case "wait":
      return mod.cmdKernelWait(args, flags);
    case "templates":
      if (args[0] === "ls" || args.length === 0) return mod.cmdKernelTemplatesLs(args, flags);
      console.log("  用法: pth kernel templates ls");
      return;
    case "batch":
      if (args[0] === "add") return mod.cmdKernelBatchAdd(args.slice(1), flags);
      if (args[0] === "remove") return mod.cmdKernelBatchRemove(args.slice(1), flags);
      if (args[0] === "worker") return mod.cmdKernelBatchWorker(args.slice(1), flags);
      console.log("  用法: pth kernel batch add [n] | remove [n] | worker <pause|resume|remove|add> <batchId> <role> [copies]");
      return;
    case "status":
      return mod.cmdKernelStatus(args, flags);
    default:
      console.log([
        "  pth kernel tasks add \"<描述>\" [--tags a,b]   发布 PTH 任务",
        "  pth kernel tasks add --template <id> --key v… 模板发布",
        "  pth kernel templates ls                       模板列表",
        "  pth kernel tasks ls [--limit n]              任务列表",
        "  pth kernel wait <taskId> [--follow]          等待任务终态",
        "  pth kernel tasks cancel <id> [--recursive]   取消任务",
        "  pth kernel batch add [n]                     启动 batch",
        "  pth kernel batch remove [n]                  停止 batch",
        "  pth kernel batch worker …                    批量 worker 控制",
        "  pth kernel status                            运行状态全景",
      ].join("\n"));
  }
}

async function main(): Promise<void> {
  switch (cmd) {
    case "submit": return submit();
    case "handoff": return handoff();
    case "doctor": {
      const { runDoctor } = await import("./runtime/runtime-doctor.js");
      const report = await runDoctor(rest, { repoRoot: REPO_ROOT });
      if (!report.ok) process.exitCode = 1;
      return;
    }
    case "status": {
      // 无位置 taskId → 栈状态；有 taskId → 任务状态（保持旧行为）
      if (hasPositional(rest, ["--env-file", "--port"])) return status();
      const { runPthStatus } = await import("@away_from/pth-console");
      await runPthStatus(rest, { repoRoot: REPO_ROOT });
      return;
    }
    case "wait": return wait();
    case "roles": return roles();
    case "program": return programCommand();
    case "job": return jobCommand();
    case "kernel": return kernelCommand();
    case "request": {
      const { flags, passthrough } = await bridgeArgs();
      const { cmdHubRequest } = await import("@away_from/pth-console");
      await cmdHubRequest(passthrough, flags);
      return;
    }
    case "requests": {
      const { flags } = await bridgeArgs();
      const { cmdHubRequests } = await import("@away_from/pth-console");
      await cmdHubRequests(flags);
      return;
    }
    case "respond": {
      const { flags, passthrough } = await bridgeArgs();
      const { cmdHubRespond } = await import("@away_from/pth-console");
      await cmdHubRespond(passthrough, flags);
      return;
    }
    case "observe": {
      const { flags, passthrough } = await bridgeArgs();
      const { cmdHubObserve } = await import("@away_from/pth-console");
      await cmdHubObserve(passthrough, flags);
      return;
    }
    case "debug": {
      const { flags, passthrough } = await bridgeArgs();
      const { cmdHubDebug } = await import("@away_from/pth-console");
      await cmdHubDebug(passthrough, flags);
      return;
    }
    case "bench": {
      const { flags, passthrough } = await bridgeArgs();
      const { cmdHubBench } = await import("@away_from/pth-console");
      await cmdHubBench(passthrough, flags);
      return;
    }
    case "console": {
      const { flags, passthrough } = await bridgeArgs();
      const { cmdHubConsole } = await import("@away_from/pth-console");
      await cmdHubConsole(passthrough, flags);
      return;
    }
    case "lineage": {
      const { flags, passthrough } = await bridgeArgs();
      const { cmdHubLineage } = await import("@away_from/pth-console");
      await cmdHubLineage(passthrough, flags);
      return;
    }
    case "trigger": {
      const { flags, passthrough } = await bridgeArgs();
      const { cmdHubTrigger } = await import("@away_from/pth-console");
      await cmdHubTrigger(passthrough, flags);
      return;
    }
    case "local-exec": {
      const { cmdLocalExec } = await import("../pth/execution/local-exec-cli.js");
      await cmdLocalExec(rest);
      return;
    }
    case "tools": {
      const { toolsCommand } = await import("../pth/tools/cli.js");
      await toolsCommand(rest);
      return;
    }
    case "services": {
      const { servicesCommand } = await import("../pth/services/cli.js");
      await servicesCommand(rest);
      return;
    }
    case "config":
      if (rest[0] === "export") return configExport();
      return configList();
    case "web": {
      const { runPthWeb } = await import("@away_from/pth-console");
      await runPthWeb(rest);
      return;
    }
    case "init": {
      const { runPthInit } = await import("@away_from/pth-console");
      await runPthInit(rest, { repoRoot: REPO_ROOT });
      return;
    }
    case "up": {
      const { runPthUp } = await import("@away_from/pth-console");
      await runPthUp(rest, { repoRoot: REPO_ROOT });
      return;
    }
    case "down": {
      const { runPthDown } = await import("@away_from/pth-console");
      await runPthDown(rest, { repoRoot: REPO_ROOT });
      return;
    }
    case "logs": {
      const { runPthLogs } = await import("@away_from/pth-console");
      await runPthLogs(rest, { repoRoot: REPO_ROOT });
      return;
    }
    default:
      console.log(`用法: pth <init|up|down|status|logs|doctor|submit|program|request|requests|respond|observe|debug|bench|job|console|lineage|trigger|kernel|handoff|wait|roles|config|web|tools|services|local-exec> ...\n  生命周期: pth init / doctor / up / status / logs / down\n  P6 编排: pth doctor [--profile X] [--json]\n            pth up --profile core|tools|lean4|u8|jupyter|full [--with a,b] [--without a,b]\n            pth status --all\n  工具容器: pth tools list|up|down|status|logs|run|verify|debug|build|pull · pth services status|logs\n  本地执行器: pth local-exec [--port p]（profile=host · execution/v1.1）\n  任务派发: pth submit "任务描述" --role developer --tags implement\n            pth submit --template recon-doc --param url=https://x --param entryId=y\n            pth wait <taskId>\n  程序面:   pth program submit <dir> | run <name> | list\n  回退请求: pth request "<描述>" --slot <s> · requests · respond <id> <dir>\n  观测运维: pth observe <sessions|session|trace|events>\n            pth debug [sandbox|<sessionId>] · bench · console · lineage · trigger\n            pth job submit|status|fetch · kernel tasks|batch|templates|status\n  其他:     pth roles · config · web [--port <n>]`);
  }
}

main().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1); });
