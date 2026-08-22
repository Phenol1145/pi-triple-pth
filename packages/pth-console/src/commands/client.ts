/**
 * commands/client.ts — CLI 公共客户端构造。
 *
 * 收敛各命令重复的 `PthClient.fromConfig()` + 未配置引导退出逻辑。
 */
import { PthClient } from "../bridge/client.js";

/** 从配置构造客户端；未配置时给出引导并退出（保留原有文案与 exit code）。 */
export function requireClient(): PthClient {
  const client = PthClient.fromConfig();
  if (!client) {
    console.log("  \x1b[31m❌ 未配置 PTH 连接\x1b[0m");
    console.log("  配置: export PTH_URL=<url> PTH_TOKEN=<token>");
    process.exit(1);
  }
  return client;
}

/** 便捷封装：拿到客户端后执行 async 回调。 */
export async function withClient<T>(fn: (client: PthClient) => Promise<T>): Promise<T> {
  return fn(requireClient());
}
