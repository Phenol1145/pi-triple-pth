/**
 * bridge/debug.ts — pth debug 命令（F/WP4 Task 22）
 *
 * 交互式调试接入：stdin 每行 → {type:"input"} → pth /ws/debug → sandbox 调试区
 * （Task 14 容器内 PTL/pi 会话所在容器）执行 → 输出回显 stdout。
 *
 *   pth debug [sandbox|<sessionId>]      （缺省 sandbox；sessionId 经 ?sessionId= 透传）
 *
 * 依赖 Node ≥22 内置 WebSocket（undici）——零新增依赖。
 * 协议：见 src/pth/gateway/routes-debug.ts 头注释（input/output/error/closed）。
 */
import { requireClient } from "./client.js";
import type { Interface as ReadlineInterface } from "node:readline";

// ─── 可测试核心：WS 调试会话客户端 ────────────────────────────────

export interface DebugSessionEvents {
  onOpen?: () => void;
  onOutput?: (data: string) => void;
  onError?: (error: string) => void;
  onClosed?: (reason: string) => void;
}

export interface DebugSession {
  sendInput(data: string): void;
  close(): void;
}

/**
 * 连接 pth /ws/debug 并返回双向会话句柄。
 * 消息映射：{type:"output"}→onOutput；{type:"error"}→onError；
 * {type:"closed"}→onClosed（终态）；连接 close→onClosed（未收到终态时兜底）。
 */
export function connectDebugSession(url: string, token: string, events: DebugSessionEvents): DebugSession {
  // Node ≥22 内置 WebSocket（undici）支持 headers 握手头——运行时实证；TS DOM 类型缺该重载故 cast。
  const ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } } as any);
  let finished = false;

  ws.addEventListener("open", () => { if (!finished) events.onOpen?.(); });
  ws.addEventListener("message", (ev) => {
    if (finished) return;
    let msg: any;
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      events.onError?.("invalid message");
      return;
    }
    if (msg.type === "output") events.onOutput?.(msg.data);
    else if (msg.type === "error") events.onError?.(msg.error);
    else if (msg.type === "closed") {
      finished = true;
      events.onClosed?.(msg.reason);
    }
  });
  ws.addEventListener("error", () => { if (!finished) events.onError?.("websocket error"); });
  ws.addEventListener("close", () => {
    if (!finished) {
      finished = true;
      events.onClosed?.("connection closed");
    }
  });

  return {
    sendInput: (data: string) => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: "input", data }));
    },
    close: () => {
      try { ws.close(); } catch { /* ignore */ }
    },
  };
}

// ─── 交互式 CLI ────────────────────────────────────────────────────

export async function runInteractiveDebug(opts: { url: string; token: string; target: string }): Promise<void> {
  const readline = await import("node:readline");
  return new Promise<void>((resolve) => {
    let finished = false;
    const finish = (reason: string) => {
      if (finished) return;
      finished = true;
      console.log(`  \x1b[2m会话关闭: ${reason}\x1b[0m`);
      resolve();
    };

    const sess = connectDebugSession(opts.url, opts.token, {
      onOpen: () => {
        console.log(`  \x1b[36m已接入 sandbox 调试区（${opts.target}）。输入命令回车执行；Ctrl-D / Ctrl-C 退出。\x1b[0m`);
      },
      onOutput: (d) => process.stdout.write(`${d}\n`),
      onError: (e) => console.log(`  \x1b[31m${e}\x1b[0m`),
      onClosed: finish,
    });

    const rl: ReadlineInterface = readline.createInterface({ input: process.stdin });
    const onSIGINT = () => { sess.close(); rl.close(); finish("interrupted"); };
    process.once("SIGINT", onSIGINT);

    rl.on("line", (line) => {
      if (line.trim().length > 0) sess.sendInput(line);
    });
    rl.on("close", () => {
      process.removeListener("SIGINT", onSIGINT);
      sess.close();
      finish("stdin closed");
    });
  });
}

export async function cmdHubDebug(passthrough: string[], _flags: Record<string, string>): Promise<void> {
  const target = passthrough[0] ?? "sandbox";
  const client = requireClient();

  try {
    await runInteractiveDebug({ url: client.debugUrl(target), token: client.authToken, target });
  } catch (err: any) {
    console.log(`\x1b[31m❌ 调试会话失败: ${err.message}\x1b[0m`);
    process.exit(1);
  }
}
