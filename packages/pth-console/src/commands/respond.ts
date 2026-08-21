/**
 * bridge/respond.ts — pth respond <requestId> <dir>（F/WP4 Task 20）
 *
 * 构建构件（复用 submit 的打包链路 packProgram——agent-program 目录）→ 走 §5.1
 * 构件上传 API（POST /api/v1/components）+ requestId 关联 → pth 保存成功后自动闭合
 * 回退请求。**通道复用**：非新协议（spec §5.4）。
 *
 * 人类补全流程闭环：建单 → pth requests 可见 → 本地构建 → respond 上传填槽 → 请求闭合。
 */
import fs from "node:fs";
import { packProgram } from "../bridge/pack.js";
import { PthClient } from "../bridge/client.js";

export async function cmdHubRespond(passthrough: string[], _flags: Record<string, string>): Promise<void> {
  const requestId = passthrough[0];
  const dir = passthrough[1];

  if (!requestId || !dir) {
    console.log("  用法: pth respond <requestId> <dir>");
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

  console.log(`  \x1b[1m构件: ${packed.manifest.name}\x1b[0m  请求: ${requestId}`);
  console.log(`  文件: ${packed.files.length} 个 (${(packed.bytes / 1024).toFixed(1)} KB)`);

  const client = PthClient.fromConfig();
  if (!client) {
    console.log("  \x1b[31m❌ 未配置 PTH 连接\x1b[0m");
    console.log("  配置: export PTH_URL=<url> PTH_TOKEN=<token>");
    process.exit(1);
  }

  console.log("  上传中…");
  try {
    const result = await client.submitComponent(
      "agent-program",
      { type: "agent-program", ...packed.manifest },
      packed.archive,
      requestId,
    );
    console.log(`  \x1b[32m✅ 已提交为 v${result.version}\x1b[0m  (${(result.bytes / 1024).toFixed(1)} KB)`);
    if (result.closeWarning) {
      // 评审 WP4-R1 I-2 修复：闭合失败不再无条件宣称成功
      console.log(`  \x1b[33m⚠️ 构件已保存，但回退请求闭合失败: ${result.closeWarning}\x1b[0m`);
    } else if (result.closedRequest) {
      console.log(`  \x1b[32m✅ 回退请求 ${result.closedRequest} 已闭合\x1b[0m`);
    }
  } catch (err: any) {
    console.log(`  \x1b[31m❌ 提交失败: ${err.message}\x1b[0m`);
    process.exit(1);
  }
}
