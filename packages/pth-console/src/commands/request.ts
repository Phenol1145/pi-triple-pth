/**
 * bridge/request.ts — pth request / pth requests 命令（F/WP4 Task 20）
 *
 * 手动建单（spec §5.4——自动触发判定[watchdog/T 参数]留 E 阶段）：模拟根回退节点
 * 的透传行为——人类/PTL 主动创建构件缺口请求。
 *
 *   pth request "<description>" --slot <slotHint> [--urgency low|medium|high]
 *   pth requests（列表——open 优先）
 */
import { PthClient } from "../bridge/client.js";
import { printPthBanner } from "./banner.js";

export async function cmdHubRequest(passthrough: string[], flags: Record<string, string>): Promise<void> {
  const description = passthrough[0];
  if (!description) {
    console.log('  用法: pth request "<description>" --slot <slotHint> [--urgency low|medium|high]');
    process.exit(1);
  }

  const client = PthClient.fromConfig();
  if (!client) {
    console.log("  \x1b[31m❌ 未配置 PTH 连接\x1b[0m");
    console.log("  配置: export PTH_URL=<url> PTH_TOKEN=<token>");
    process.exit(1);
  }

  try {
    const req = await client.createFallbackRequest({
      description,
      slotHint: flags.slot,
      urgency: flags.urgency,
    });
    console.log(`  \x1b[32m✅ 已创建回退请求\x1b[0m ${req.requestId}`);
    console.log(`  slot: ${req.slotHint ?? "-"}   urgency: ${req.urgency}   status: ${req.status}`);
    console.log(`  描述: ${req.description}`);
  } catch (err: any) {
    console.log(`  \x1b[31m❌ 建单失败: ${err.message}\x1b[0m`);
    process.exit(1);
  }
}

export async function cmdHubRequests(_flags: Record<string, string>): Promise<void> {
  const client = PthClient.fromConfig();
  if (!client) {
    console.log("  \x1b[31m❌ 未配置 PTH 连接\x1b[0m");
    console.log("  配置: export PTH_URL=<url> PTH_TOKEN=<token>");
    process.exit(1);
  }

  try {
    const reqs = await client.listFallbackRequests();

    printPthBanner();
    console.log("  \x1b[1m回退请求列表\x1b[0m");

    if (reqs.length === 0) {
      console.log("\n  暂无回退请求。建单: pth request \"<description>\" --slot <slotHint>");
    } else {
      console.log("");
      console.log(`  \x1b[2m${"REQUEST_ID".padEnd(40)}URGENCY STATUS  CREATED  DESCRIPTION\x1b[0m`);
      for (const r of reqs) {
        const id = r.requestId.padEnd(40);
        const urgency = r.urgency.padEnd(7);
        const status = (r.status === "open" ? "\x1b[32mopen\x1b[0m" : "\x1b[2mclosed\x1b[0m").padEnd(6 + 5);
        const date = r.createdAt.slice(0, 16).replace("T", " ");
        console.log(`  \x1b[1m${id}\x1b[0m${urgency}${status} ${date}  ${r.description}`);
        if (r.slotHint) console.log(`  ${"".padEnd(40)}slot: ${r.slotHint}`);
      }
      console.log("\n  补全: \x1b[36mpth respond <requestId> <dir>\x1b[0m");
    }
    console.log("");
  } catch (err: any) {
    console.log(`\x1b[31m❌ 获取回退请求失败: ${err.message}\x1b[0m`);
    process.exit(1);
  }
}
