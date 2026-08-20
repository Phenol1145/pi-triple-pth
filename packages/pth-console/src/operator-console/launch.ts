/**
 * operator-console/launch.ts — `ptl operator` 启动器
 *
 * 默认 loopback-only；bootstrap token 本地生成（64 位小写 hex），
 * URL 只含 fragment token，不含任何 PTH/N30 token 或 Docker socket 路径。
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  createOperatorConsoleServer,
  type OperatorConsoleServer,
  type OperatorConsoleServerDeps,
} from "./server.js";

export interface StartOperatorConsoleOptions extends OperatorConsoleServerDeps {
  readonly noOpen?: boolean;
}

const BIND_HOST = "127.0.0.1";

/** 未来若开放非 loopback，必须在此处要求显式 fail-closed 配置 + 认证。 */
export function assertOperatorConsoleHost(host: string | undefined): void {
  if (host !== undefined && host !== BIND_HOST) {
    throw new Error(`operator console only binds to 127.0.0.1 (refusing host: ${host})`);
  }
}

function openUrl(url: string): void {
  const platform = process.platform;
  const command = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {
      // 打开浏览器失败不阻断启动；URL 已打印供手动访问
    });
    child.unref();
  } catch {
    // 同上：不阻断
  }
}

export async function startOperatorConsole(
  opts: StartOperatorConsoleOptions,
): Promise<OperatorConsoleServer & { bootstrapUrl: string }> {
  assertOperatorConsoleHost(opts.host);

  const bootstrapToken = opts.bootstrapToken ?? randomBytes(32).toString("hex");
  const app = createOperatorConsoleServer({ ...opts, host: opts.host ?? BIND_HOST, bootstrapToken });

  const { port, bootstrapUrl } = await app.listen();
  console.log("");
  console.log("  \x1b[36m\x1b[1mPTL Operator Console\x1b[0m");
  console.log(`  \x1b[2m仅监听本机回环地址 ${BIND_HOST}:${port}\x1b[0m`);
  console.log(`  \x1b[2m请在浏览器打开（一次性链接，关闭浏览器后需重新运行）:\x1b[0m`);
  console.log("");
  console.log(`  \x1b[36m${bootstrapUrl}\x1b[0m`);
  console.log("");

  if (!opts.noOpen) {
    openUrl(bootstrapUrl);
  }

  return Object.assign(app, { bootstrapUrl });
}
