/**
 * pth-console/src/cli.ts —— PTH Web Console 启动命令。
 *
 * 用法：node packages/pth-console/src/cli.ts web [--port <n>] [--no-open]
 * 产品规则：仅监听 127.0.0.1；PTH/N30 凭据只存在服务端内存。
 */

import { getConfigValue } from "@away_from/shared";
import { startOperatorConsole } from "./operator-console/launch.js";

function arg(name: string, args: string[]): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined;
}

export async function runPthWeb(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log([
      "用法: npm run pth -- web [--port <n>] [--no-open]",
      "  --port <n>   监听端口（默认随机空闲端口）",
      "  --no-open    启动后不自动打开浏览器",
      "  仅监听 127.0.0.1；PTH/N30 凭据只保存在服务端内存。",
    ].join("\n"));
    return;
  }
  const host = arg("--host", args) ?? "127.0.0.1";
  if (host !== "127.0.0.1") {
    throw new Error("pth web only binds to 127.0.0.1");
  }
  const rawPort = arg("--port", args);
  const port = rawPort === undefined ? undefined : Number(rawPort);
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error("--port must be an integer in 1..65535");
  }
  const noOpen = args.includes("--no-open");
  await startOperatorConsole({
    host,
    port,
    noOpen,
    operatorPrincipalId: process.env.USER ?? "human-local-operator",
    tenant: process.env.PTH_OPERATOR_TENANT ?? getConfigValue("operator.tenant"),
    space: process.env.PTH_OPERATOR_SPACE ?? getConfigValue("operator.space"),
    pth: {
      baseUrl: process.env.PTH_URL ?? getConfigValue("pth.url"),
      token: process.env.PTH_TOKEN ?? getConfigValue("pth.token"),
    },
    n30: {
      baseUrl: process.env.N30_URL ?? getConfigValue("n30.url"),
    },
  });
}
