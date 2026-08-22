/**
 * execution/local-exec-cli.ts —— `pth local-exec` 命令入口（P2 纠偏后归 PTH）。
 *
 * 环境面（pthConfig）：
 *  - LOCAL_EXEC_SHARED_SECRET（必填，缺失拒绝启动）
 *  - LOCAL_EXEC_PORT（默认 8787）
 *  - LOCAL_EXEC_PATH_MAPPINGS（JSON：[{hostRoot,execRoot}]，可选）
 *  - LOCAL_EXEC_WORKSPACE_ROOT（快捷方式：登记 /data/workspaces → 该宿主根）
 */

import { startLocalExecServer } from "./local-exec-server.js";
import { pthConfig } from "@away_from/pth-config";
import type { ExecutionPathMapping } from "@away_from/shared/execution";

export async function cmdLocalExec(args: string[]): Promise<void> {
  const cfg = pthConfig();
  const token = cfg.str("LOCAL_EXEC_SHARED_SECRET");
  if (!token) {
    console.error("  \x1b[31m❌ LOCAL_EXEC_SHARED_SECRET 未设置——本地执行器拒绝启动（fail-closed）\x1b[0m");
    process.exit(1);
  }

  let mappings: ExecutionPathMapping[] = [];
  const rawMappings = cfg.json<unknown>("LOCAL_EXEC_PATH_MAPPINGS");
  if (rawMappings !== undefined) {
    if (!Array.isArray(rawMappings)) {
      console.error("  \x1b[31m❌ LOCAL_EXEC_PATH_MAPPINGS 必须是 [{hostRoot,execRoot}] 数组\x1b[0m");
      process.exit(1);
    }
    for (const item of rawMappings) {
      const m = item as Record<string, unknown>;
      if (typeof m?.hostRoot !== "string" || m.hostRoot.length === 0 ||
          typeof m?.execRoot !== "string" || m.execRoot.length === 0) {
        console.error("  \x1b[31m❌ LOCAL_EXEC_PATH_MAPPINGS 每项必须含非空 hostRoot/execRoot\x1b[0m");
        process.exit(1);
      }
      mappings.push({ hostRoot: m.hostRoot, execRoot: m.execRoot });
    }
  } else if (cfg.str("LOCAL_EXEC_WORKSPACE_ROOT")) {
    mappings = [{ hostRoot: "/data/workspaces", execRoot: cfg.str("LOCAL_EXEC_WORKSPACE_ROOT") }];
  }

  const portFlag = args.indexOf("--port");
  const rawPort = portFlag >= 0 && portFlag + 1 < args.length ? args[portFlag + 1] : cfg.str("LOCAL_EXEC_PORT") || "8787";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`  \x1b[31m❌ 非法端口: ${rawPort}\x1b[0m`);
    process.exit(1);
  }

  const running = await startLocalExecServer({
    token,
    port,
    mappings,
    defaultTimeoutMs: 120_000,
    maxStdoutBytes: 4 * 1024 * 1024,
    maxStderrBytes: 4 * 1024 * 1024,
  });
  console.log("");
  console.log("  \x1b[36m\x1b[1mPi-Triple 本地执行器\x1b[0m \x1b[2m(execution/v1.1 · profile=host)\x1b[0m");
  console.log(`  监听:     ${running.baseUrl}`);
  console.log(`  pathMap:  ${mappings.length > 0 ? mappings.map((m) => `${m.hostRoot} → ${m.execRoot}`).join("; ") : "（未登记——带 cwd 的请求将 CWD_NOT_ALLOWED）"}`);
  console.log(`  认证:     Bearer LOCAL_EXEC_SHARED_SECRET（/health 免认证）`);
  console.log("");

  const shutdown = async () => {
    console.log("  \x1b[2m正在关闭本地执行器…\x1b[0m");
    await running.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
