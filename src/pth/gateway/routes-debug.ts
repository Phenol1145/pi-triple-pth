/**
 * gateway/routes-debug.ts — hub debug WebSocket 交互调试通道（F/WP4 Task 22）
 *
 * 复用既有 @fastify/websocket 注册（server.ts 已 `await app.register(websocket)`），
 * 新增独立子路径 `/ws/debug`（不与 `/ws` 的 engine prompt/abort 通道冲突——评审 N3）。
 *
 * 接入 sandbox 调试会话（Task 14 的 sandbox-debug-entry.sh 容器内 PTL/pi 会话）：
 * 默认网关把每条 input 按行转发 sandbox /exec（同一 sandbox 容器，含 pi+PTL），
 * 输出回传 WS——双向输入输出（vs hub run 的 SSE 单向）。持久 tmux 交互流
 * 需 sandbox 侧流式端点（后续演进——见设计注）。
 *
 * 消息协议（实现时定并文档化）：
 *   client → server: {type:"input", data: string}   一行命令/输入
 *   client → server: {type:"close"}                 主动关闭
 *   server → client: {type:"output", data: string}  执行输出（含 stderr；非零退出码附 [exit N]）
 *   server → client: {type:"error", error: string}  传输层错误（sandbox 不可达/超时/协议非法）
 *   server → client: {type:"closed", reason: string}会话关闭（正常结束或权限拒绝）
 *
 * 接入控制：复用 createAuthHook 的 Bearer 校验（WS 握手走同一 onRequest 链——
 * /ws 已有实证）；额外角色校验：要求 platform-admin（交互 shell 触及共享
 * workspaces 卷，跨租户风险高——tenant-agent 拒绝）。会话审计写 audit:log。
 */

import type { FastifyInstance } from "fastify";
import type { AuditWriter } from "../observability/index.js";
import { SandboxExecClient, SandboxForwardError } from "../impls/kernels/index.js";
import type { AuthContext } from "./auth.js";

// ─── 网关抽象 ──────────────────────────────────────────────────────
export type DebugGatewayResult = { kind: "output"; data: string } | { kind: "error"; data: string };

export interface DebugGateway {
  /** 打开调试会话（可选——默认行式网关无需前置） */
  open?(sessionId: string): Promise<void>;
  /** 转发一条输入，返回输出/错误（单向往返） */
  send(input: string): Promise<DebugGatewayResult>;
  /** 关闭会话（可选） */
  close?(): Promise<void>;
}

export type DebugGatewayFactory = (sessionId: string) => DebugGateway;

/**
 * 默认网关工厂：sandbox /exec 行式通道（Task 14 调试入口所在容器）。
 * 每条 input 在 sandbox 内执行（cwd 白名单内：默认 /data/workspaces），stdout+stderr 聚合回传。
 * 设计注：持久 tmux 交互（attach 既有 pi/PTL 会话）需要 sandbox 侧流式/会话端点——
 * 超出本任务范围（测试 mock sandbox）；行式通道已提供双向输入输出的完整闭环。
 */
export function createSandboxDebugGatewayFactory(
  client: SandboxExecClient,
  cwd = "/data/workspaces",
): DebugGatewayFactory {
  return (_sessionId: string): DebugGateway => {
    return {
      async send(input): Promise<DebugGatewayResult> {
        try {
          const r = await client.exec({ cmd: input, cwd, timeout: 60 });
          const out = [r.stdout, r.stderr].filter((s) => s.length > 0).join("\n") || "(no output)";
          const data = r.exitCode === 0 || r.exitCode === null ? out : `${out}\n[exit ${r.exitCode}]`;
          return { kind: "output", data };
        } catch (err) {
          if (err instanceof SandboxForwardError) {
            return { kind: "error", data: `${err.code}: ${err.message}` };
          }
          return { kind: "error", data: `sandbox-unavailable: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    };
  };
}

// ─── WS 路由 ───────────────────────────────────────────────────────
export function registerDebugRoutes(
  app: FastifyInstance,
  opts: { gatewayFactory: DebugGatewayFactory; audit?: AuditWriter; requireRole?: string },
) {
  const requireRole = opts.requireRole ?? "platform-admin";

  app.get("/ws/debug", { websocket: true }, (socket, req) => {
    const auth = (req as any).auth as AuthContext | undefined;
    const tenantId = auth?.tenantId ?? "unknown";

    // 角色校验：platform-admin（交互 shell 触及共享 workspaces 卷——跨租户风险）
    if (!auth || auth.role !== requireRole) {
      socket.send(JSON.stringify({ type: "closed", reason: `forbidden: role "${requireRole}" required` }));
      socket.close();
      return;
    }

    const q = (req.query ?? {}) as Record<string, unknown>;
    const sessionId = typeof q.sessionId === "string" && q.sessionId.length > 0 ? q.sessionId : "sandbox";
    const gateway = opts.gatewayFactory(sessionId);
    const audit = opts.audit;
    let closed = false;

    const send = (obj: unknown) => {
      if (!closed && socket.readyState === 1) socket.send(JSON.stringify(obj));
    };
    const markClosed = () => {
      if (!closed) {
        closed = true;
        gateway.close?.().catch(() => {});
      }
    };

    Promise.resolve(gateway.open?.(sessionId)).catch(() => {});
    audit?.write({ tenantId, actor: auth.role, action: "debug_session_open", details: { sessionId } }).catch(() => {});

    socket.on("message", async (raw: Buffer) => {
      if (closed) return;
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        send({ type: "error", error: "invalid JSON" });
        return;
      }
      if (msg.type === "input") {
        const data = typeof msg.data === "string" ? msg.data : String(msg.data ?? "");
        const r = await gateway.send(data);
        if (closed) return;
        if (r.kind === "output") send({ type: "output", data: r.data });
        else send({ type: "error", error: r.data });
      } else if (msg.type === "close") {
        // 先回送 closed（send 以 closed 标志为终态护栏——先发后置位）
        send({ type: "closed", reason: "closed by client" });
        closed = true;
        await gateway.close?.();
        audit?.write({ tenantId, actor: auth.role, action: "debug_session_closed", details: { sessionId } }).catch(() => {});
        socket.close();
      } else {
        send({ type: "error", error: `unknown message type: ${String(msg.type)}` });
      }
    });
    socket.on("close", markClosed);
    socket.on("error", markClosed);
  });
}
