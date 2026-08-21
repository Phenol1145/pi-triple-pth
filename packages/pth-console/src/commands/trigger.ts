/**
 * bridge/trigger.ts — pth trigger 命令族
 *
 * PTH trigger 组件（事件触发任务）的 PTL 交互层：经 PthClient HTTP 访问
 * gateway /api/v1/kernel/triggers 路由：
 *   GET    /api/v1/kernel/triggers            列表
 *   POST   /api/v1/kernel/triggers            创建
 *   POST   /api/v1/kernel/triggers/:id/toggle 启用/禁用
 *   DELETE /api/v1/kernel/triggers/:id        删除
 *   POST   /api/v1/kernel/triggers/reload     立即重载
 *
 *   pth trigger ls
 *   pth trigger add --name <n> --event <e> [--role <r>]
 *        [--task-title <t> --task-text <x> | --json '{...}'] [--once] [--max-fires <n>]
 *   pth trigger rm <id>
 *   pth trigger toggle <id> [--on|--off]
 *   pth trigger reload
 */
import { PthClient } from "../bridge/client.js";

/** 从 pi-triple.json 配置构造客户端；未配置时给出引导并退出。 */
function requireClient(): PthClient {
  const client = PthClient.fromConfig();
  if (!client) {
    console.log("  \x1b[31m❌ 未配置 PTH 连接\x1b[0m");
    console.log("  配置: export PTH_URL=<url> PTH_TOKEN=<token>");
    process.exit(1);
  }
  return client;
}

/** 解析整数 flag（--max-fires n）；缺省/非法返回 undefined */
function parseIntFlag(flags: Record<string, string>, key: string): number | undefined {
  const v = flags[key];
  if (v === undefined || v === "true") return undefined;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

/** trigger 缺省用法打印（无子命令 / 未知子命令时） */
function printUsage(): void {
  console.log([
    "  pth trigger ls                                     触发器列表（id/name/event/match/enabled）",
    "  pth trigger add --name <n> --event <e>             创建触发器",
    "        [--role <role>] [--task-title <t> --task-text <x> | --json '{...}']",
    "        [--once] [--max-fires <n>]",
    "  pth trigger rm <id>                                删除触发器",
    "  pth trigger toggle <id> [--on|--off]               启用/禁用（缺省翻转当前状态）",
    "  pth trigger reload                                 立即重载触发器",
  ].join("\n"));
}

/** trigger 列表行（gateway 返回字段：id/name/event/match/task/enabled/once/maxFires） */
interface TriggerRow {
  id?: string;
  name?: string;
  event?: string;
  match?: string;
  enabled?: boolean;
  once?: boolean;
  maxFires?: number;
  task?: unknown;
  [k: string]: unknown;
}

export async function cmdHubTrigger(passthrough: string[], flags: Record<string, string>): Promise<void> {
  const [sub, ...rest] = passthrough;
  switch (sub) {
    case "ls":
      await triggerLs(flags);
      return;
    case "add":
      await triggerAdd(rest, flags);
      return;
    case "rm":
      await triggerRm(rest[0]);
      return;
    case "toggle":
      await triggerToggle(rest[0], flags);
      return;
    case "reload":
      await triggerReload();
      return;
    default:
      printUsage();
  }
}

async function triggerLs(flags: Record<string, string>): Promise<void> {
  const client = requireClient();
  try {
    const data = await client.requestJson("/api/v1/kernel/triggers", { method: "GET" });
    const raw = Array.isArray(data)
      ? data
      : (data as { triggers?: unknown; list?: unknown } | null)?.triggers
        ?? (data as { triggers?: unknown; list?: unknown } | null)?.list
        ?? [];
    const triggers = (Array.isArray(raw) ? raw : []) as TriggerRow[];
    if (flags.json === "true") {
      console.log(JSON.stringify(triggers, null, 2));
      return;
    }
    console.log("═══ 触发器（event → task）═══");
    if (triggers.length === 0) {
      console.log("\n  暂无触发器。创建: pth trigger add --name x --event task.done");
      return;
    }
    console.log(`  ${"ID".padEnd(26)} ${"NAME".padEnd(20)} ${"EVENT".padEnd(18)} ${"MATCH".padEnd(16)} ENABLED`);
    for (const t of triggers) {
      const enabled = t.enabled ? "\x1b[32mon\x1b[0m" : "\x1b[31moff\x1b[0m";
      const match = t.match
        ? (typeof t.match === "string" ? t.match : JSON.stringify(t.match))
        : "-";
      console.log(
        `  ${String(t.id ?? "-").padEnd(26)} ${String(t.name ?? "-").padEnd(20)} ` +
          `${String(t.event ?? "-").padEnd(18)} ${String(match).padEnd(16)} ${enabled}`,
      );
    }
  } catch (err: any) {
    console.log(`\x1b[31m❌ 触发器列表获取失败: ${err.message}\x1b[0m`);
    process.exit(1);
  }
}

async function triggerAdd(passthrough: string[], flags: Record<string, string>): Promise<void> {
  // --json '{...}'：args 层将 --json 解析为布尔，JSON 字面量进入 passthrough。
  // JSON 可携带完整载荷（name/event/match/task/enabled/once/maxFires）；
  // 显式 flag（--name/--event/--role/--task-*）优先覆盖 JSON 同名字段。
  let jsonExtra: Record<string, unknown> | undefined;
  if (flags.json === "true") {
    const jsonStr = passthrough.find((p) => p.trim().startsWith("{"));
    if (jsonStr) {
      try {
        const extra = JSON.parse(jsonStr) as Record<string, unknown>;
        if (extra && typeof extra === "object" && !Array.isArray(extra)) {
          jsonExtra = extra;
        }
      } catch {
        console.log(`\x1b[31m❌ --json 参数不是合法 JSON: ${jsonStr}\x1b[0m`);
        process.exit(1);
      }
    }
  }

  const name = flags.name ?? jsonExtra?.name;
  const event = flags.event ?? jsonExtra?.event;
  if (!name || !event) {
    console.log(
      "  用法: pth trigger add --name <n> --event <e> [--role <r>] " +
        "[--task-title <t> --task-text <x> | --json '{...}'] [--once] [--max-fires <n>]",
    );
    process.exit(1);
  }

  let body: Record<string, unknown> = {
    name,
    event,
    ...(flags.match ? { match: flags.match } : {}),
    ...(flags.once === "true" ? { once: true } : {}),
  };
  const maxFires = parseIntFlag(flags, "max-fires");
  if (maxFires !== undefined) body.maxFires = maxFires;

  if (jsonExtra) {
    body = { ...jsonExtra, ...body }; // 显式 flag 优先于 --json
  }

  // task 规格：--role / --task-title / --task-text 组装的触发任务描述
  const task: Record<string, string> = {};
  if (flags.role) task.role = flags.role;
  if (flags["task-title"]) task.title = flags["task-title"];
  if (flags["task-text"]) task.text = flags["task-text"];
  if (Object.keys(task).length > 0) body.task = task;

  const client = requireClient();
  try {
    const created = await client.requestJson("/api/v1/kernel/triggers", {
      method: "POST",
      body: JSON.stringify(body),
    }) as Record<string, unknown>;
    console.log("✅ 触发器已创建");
    console.log(`    id:      ${String(created?.id ?? (created?.trigger as Record<string, unknown> | undefined)?.id ?? "(见列表)")}`);
    console.log(`    name:    ${name}`);
    console.log(`    event:   ${event}`);
    console.log(`    enabled: ${String(created?.enabled ?? true)}`);
    console.log("  查看: \x1b[36mpth trigger ls\x1b[0m   禁用: \x1b[36mpth trigger toggle <id> --off\x1b[0m");
  } catch (err: any) {
    console.log(`\x1b[31m❌ 创建触发器失败: ${err.message}\x1b[0m`);
    process.exit(1);
  }
}

async function triggerRm(id: string | undefined): Promise<void> {
  if (!id) {
    console.log("  用法: pth trigger rm <id>");
    process.exit(1);
  }
  const client = requireClient();
  try {
    // Fastify 拒绝空 body + JSON Content-Type——DELETE 显式传空 JSON 对象
    await client.requestJson(`/api/v1/kernel/triggers/${encodeURIComponent(id)}`, { method: "DELETE", body: "{}" });
    console.log(`  \x1b[32m✔\x1b[0m 触发器已删除: ${id}`);
  } catch (err: any) {
    console.log(`\x1b[31m❌ 删除触发器失败: ${err.message}\x1b[0m`);
    process.exit(1);
  }
}

async function triggerToggle(id: string | undefined, flags: Record<string, string>): Promise<void> {
  if (!id) {
    console.log("  用法: pth trigger toggle <id> [--on|--off]");
    process.exit(1);
  }
  const client = requireClient();
  const body =
    flags.on === "true" ? { enabled: true } : flags.off === "true" ? { enabled: false } : undefined;
  try {
    const res = await client.requestJson(
      `/api/v1/kernel/triggers/${encodeURIComponent(id)}/toggle`,
      body === undefined ? { method: "POST" } : { method: "POST", body: JSON.stringify(body) },
    ) as { enabled?: boolean } | null;
    const enabled = res?.enabled ?? body?.enabled;
    console.log(
      `  \x1b[32m✔\x1b[0m 触发器 ${id} → ${enabled === undefined ? "已切换" : enabled ? "启用 (on)" : "禁用 (off)"}`,
    );
  } catch (err: any) {
    console.log(`\x1b[31m❌ 切换触发器失败: ${err.message}\x1b[0m`);
    process.exit(1);
  }
}

async function triggerReload(): Promise<void> {
  const client = requireClient();
  try {
    const res = await client.requestJson(
      "/api/v1/kernel/triggers/reload",
      { method: "POST" },
    ) as { reloaded?: number; count?: number; loaded?: number } | null;
    const n = res?.reloaded ?? res?.count ?? res?.loaded;
    console.log(`  \x1b[32m✔\x1b[0m 触发器已重载${n !== undefined ? `（${n} 条生效）` : ""}`);
  } catch (err: any) {
    console.log(`\x1b[31m❌ 重载触发器失败: ${err.message}\x1b[0m`);
    process.exit(1);
  }
}
