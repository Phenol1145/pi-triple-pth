/**
 * commands/submit.ts — pth submit 命令
 *
 * 校验 agent.json → 打包 → 上传到 PTH。
 * --dry-run 只校验+打包，不上传。
 */
import fs from "node:fs";
import { packProgram } from "../bridge/pack.js";
import { PthClient } from "../bridge/client.js";

export async function cmdSubmit(passthrough: string[], flags: Record<string, string>): Promise<void> {
  const dryRun = flags["dry-run"] === "true";
  const dir = passthrough[0];

  if (!dir) {
    console.log("  用法: pth submit <dir> [--dry-run]");
    process.exit(1);
  }

  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    console.log(`  \x1b[31m❌ 目录不存在: ${dir}\x1b[0m`);
    process.exit(1);
  }

  const packed = packProgram(dir);
  if (!packed.ok) {
    console.log("  \x1b[31m❌ 打包失败:\x1b[0m");
    for (const err of packed.errors) {
      console.log(`    - ${err}`);
    }
    process.exit(1);
  }

  console.log(`  \x1b[1m程序: ${packed.manifest.name}\x1b[0m`);
  console.log(`  文件: ${packed.files.length} 个 (${(packed.bytes / 1024).toFixed(1)} KB)`);

  if (dryRun) {
    console.log("  \x1b[2m--dry-run 模式，跳过上传\x1b[0m");
    if (packed.files.length > 0) {
      console.log("  内容:");
      for (const f of packed.files) {
        console.log(`    ${f}`);
      }
    }
    return;
  }

  const client = PthClient.fromConfig();
  if (!client) {
    console.log("  \x1b[31m❌ 未配置 PTH 连接\x1b[0m");
    console.log("  配置: export PTH_URL=<url> PTH_TOKEN=<token>");
    process.exit(1);
  }

  console.log("  上传中…");
  try {
    const result = await client.submit(packed.manifest, packed.archive);
    console.log(`  \x1b[32m✅ 已提交为 v${result.version}\x1b[0m  (${(result.bytes / 1024).toFixed(1)} KB)`);
  } catch (err: any) {
    console.log(`  \x1b[31m❌ 提交失败: ${err.message}\x1b[0m`);
    process.exit(1);
  }
}
