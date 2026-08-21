/**
 * commands/programs.ts — pth programs 命令
 *
 * 列出 PTH 上已提交的程序。
 */
import { PthClient } from "../bridge/client.js";
import { printPthBanner } from "./banner.js";

export async function cmdPrograms(_flags: Record<string, string>): Promise<void> {
  const client = PthClient.fromConfig();
  if (!client) {
    console.log("  \x1b[31m❌ 未配置 PTH 连接\x1b[0m");
    console.log("  配置: export PTH_URL=<url> PTH_TOKEN=<token>");
    process.exit(1);
  }

  try {
    const programs = await client.list();

    printPthBanner();
    console.log("  \x1b[1mPTH 程序列表\x1b[0m");

    if (programs.length === 0) {
      console.log("\n  暂无程序。提交: pth submit <dir>");
    } else {
      console.log("");
      console.log(`  \x1b[2m${"NAME".padEnd(24)}VERSION  UPDATED\x1b[0m`);
      for (const p of programs) {
        const name = p.name.padEnd(24);
        const ver = `v${p.latestVersion}`.padEnd(8);
        const date = p.updatedAt ? new Date(p.updatedAt).toISOString().slice(0, 16).replace("T", " ") : "-";
        console.log(`  \x1b[1m${name}\x1b[0m${ver}${date}`);
      }
      console.log("\n  运行: \x1b[36mpth run <name>\x1b[0m");
    }
    console.log("");
  } catch (err: any) {
    console.log(`\x1b[31m❌ 获取程序列表失败: ${err.message}\x1b[0m`);
    process.exit(1);
  }
}
