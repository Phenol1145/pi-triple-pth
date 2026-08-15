#!/usr/bin/env node
/**
 * pth-cli —— PTH 任务派发 CLI（2026-08-12：消除裸 curl 派发摩擦）
 *
 * 用法（npm run pth -- <cmd> ...）：
 *   pth submit <任务描述> [--role <角色>] [--tags a,b] [--title <标题>] [--file <路径>]
 *   pth status <taskId>
 *   pth wait <taskId> [--timeout <秒>]        # 轮询到 completed + 打印 result
 *   pth roles                                   # 列出可派发角色（含 governance——显式 flow）
 *   pth tags                                    # 列出已注册标签
 *
 * 环境变量：PTH_API（缺省 http://localhost:3000）/ PTH_TOKEN（缺省 test-token-123）
 *   / PTH_CREATED_BY（缺省 cli）
 *
 * 示例：
 *   npm run pth -- submit "统计 memory 库 scorecard 数" --role memory-stats --tags stats
 *   npm run pth -- submit "写 README" --role writer --tags write --title "README"
 *   npm run pth -- wait <id>                    # 完成即返回（含 result）
 */
import { readFile } from "node:fs/promises";

const API = process.env.PTH_API ?? "http://localhost:3000";
const TOKEN = process.env.PTH_TOKEN ?? "test-token-123";
const CREATED_BY = process.env.PTH_CREATED_BY ?? "cli";

const [, , cmd, ...rest] = process.argv;

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
  const desc = rest.find((a) => !a.startsWith("-"));
  if (!desc) throw new Error("用法: pth submit <任务描述> [--concept] [--role r] [--tags a,b] [--title t] [--file p]");
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
    const { validateConceptDesign, CONCEPT_DESIGN_TEMPLATE } = await import("../src/pth/kernel/concept-design.js");
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
  const { CONCEPT_DESIGN_TEMPLATE } = await import("../src/pth/kernel/concept-design.js");
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
  const { allKnownRoles, setDefaultRoles } = await import("../src/pth/kernel/execution/worker-cluster.js");
  const { ORIGIN_ROLE, DEFAULT_ROLES, MID_ROLES, GOVERNANCE_ROLES } = await import("../src/pth/impls/roles/default-roles.js");
  setDefaultRoles(ORIGIN_ROLE, DEFAULT_ROLES, MID_ROLES, GOVERNANCE_ROLES);   // 2026-08-13 审计 P2：CLI 本地角色面同样走注入
  console.log("可派发角色（--role 指定；governance 需 PTH_WORKER_ROLES 显式启用进 batch）:");
  for (const r of allKnownRoles()) {
    console.log(`  ${r.id.padEnd(22)} tags=[${r.tags.join(",")}]  ${r.description ?? ""}`);
  }
}

async function tags(): Promise<void> {
  const { tagRegistry } = await import("../src/pth/kernel/execution/tag-registry.js");
  console.log("已注册标签:");
  for (const t of tagRegistry.list()) console.log(`  ${t.name} (${t.kind}${t.role ? ` → ${t.role}` : ""})`);
}

async function main(): Promise<void> {
  switch (cmd) {
    case "submit": return submit();
    case "handoff": return handoff();
    case "status": return status();
    case "wait": return wait();
    case "roles": return roles();
    case "tags": return tags();
    default:
      console.log(`用法: pth <submit|handoff|status|wait|roles|tags> ...\n  示例: npm run pth -- handoff\n        npm run pth -- submit "【目标】..." --concept\n        npm run pth -- submit "任务描述" --role developer --tags implement`);
  }
}

main().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1); });
