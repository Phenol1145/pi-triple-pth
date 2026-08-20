/**
 * operator-console/routes-inspection.ts —— 只读巡检路由（config/roles/memory/debug）。
 *
 * 从 server.ts 拆出：这四组路由只依赖会话校验 + pthOperatorClient 只读面，
 * 不触碰 bootstrap/work 写通道。handle 返回 true 表示已消费请求。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { getConfigValue } from "@away_from/shared";
import {
  OPERATOR_COOKIE_NAME,
  type OperatorSessionManager,
} from "./session.js";
import {
  parseCookieHeader,
  sendEmpty,
  sendJson,
  sendUpstreamFailure,
} from "./server-http.js";
import {
  toBrowserDebugWorkers,
  toBrowserMemoryDetail,
  toBrowserMemoryPage,
  toBrowserMemoryRevisions,
  toBrowserPthConfig,
  toBrowserRoles,
} from "./browser-dto.js";
import type { PthOperatorClient } from "./pth-operator-client.js";
import type { OperatorWorkService } from "./preview-store.js";

export interface InspectionRouteDeps {
  readonly host?: string;
  readonly port?: number;
  readonly operatorPrincipalId: string;
  readonly sessions: OperatorSessionManager;
  readonly pthOperatorClient: PthOperatorClient | null;
  readonly workService: OperatorWorkService | null;
  readonly operatorTenant: string;
  readonly operatorSpace: string;
  readonly n30Configured: boolean;
}

function requireInspectionSession(req: IncomingMessage, res: ServerResponse, deps: InspectionRouteDeps): boolean {
  const sessionToken = parseCookieHeader(req.headers.cookie).get(OPERATOR_COOKIE_NAME);
  if (!sessionToken || !deps.sessions.authenticate(sessionToken)) {
    sendJson(res, 401, { error: { code: "UNAUTHORIZED", message: "missing or expired session" } });
    return false;
  }
  return true;
}

export async function handleInspectionRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  method: string,
  deps: InspectionRouteDeps,
): Promise<boolean> {
  // ── /api/config|roles：只读配置与角色目录（GET-only；无写路由） ──
  if (pathname === "/api/v1/config/ptl" || pathname === "/api/v1/config/pth" || pathname === "/api/v1/roles") {
    if (method !== "GET") {
      sendEmpty(res, 405, { allow: "GET" });
      return true;
    }
    if (!requireInspectionSession(req, res, deps)) return true;
    if (pathname === "/api/v1/config/ptl") {
      // 本机 shell 的 redacted 事实：只暴露 loopback/端口/能力布尔面与枚举 descriptor，
      // 绝不含 token/路径/连接串。tenant/space 只来自服务端配置，浏览器无法自报覆盖。
      const ptlDescriptor = (key: string, group: string, source: string, value: unknown, restartRequired = false) => ({
        key, group, type: "string", scope: "session", source, runtimeMutable: false,
        restartRequired, description: "", secret: false, defaultValue: null,
        effectiveValue: value === undefined || value === null ? null : String(value),
      });
      sendJson(res, 200, {
        items: [
          ptlDescriptor("host", "ptl.server", "default", deps.host ?? "127.0.0.1", true),
          ptlDescriptor("port", "ptl.server", "default", deps.port ?? "auto"),
          ptlDescriptor("operatorPrincipalId", "ptl.session", "default", deps.operatorPrincipalId),
          ptlDescriptor("operatorTenant", "ptl.session", "server-config", deps.operatorTenant),
          ptlDescriptor("operatorSpace", "ptl.session", "server-config", deps.operatorSpace),
          ptlDescriptor("template", "ptl.agent", "ptl-config", getConfigValue("template.alias") ?? getConfigValue("template")),
          ptlDescriptor("model", "ptl.agent", "ptl-config", getConfigValue("model")),
          ptlDescriptor("provider", "ptl.agent", "ptl-config", getConfigValue("provider")),
          ptlDescriptor("pthChannel", "ptl.channels", deps.pthOperatorClient ? "configured" : "unknown", deps.pthOperatorClient ? "enabled" : "disabled"),
          ptlDescriptor("n30Channel", "ptl.channels", deps.n30Configured ? "configured" : "unknown", deps.n30Configured ? "enabled" : "disabled"),
          ptlDescriptor("workChannel", "ptl.channels", deps.workService ? "configured" : "unknown", deps.workService ? "enabled" : "disabled"),
        ],
      });
      return true;
    }
    if (!deps.pthOperatorClient) {
      sendJson(res, 503, { error: { code: "CONFIG_UNAVAILABLE", message: "pth inspection channel not assembled" } });
      return true;
    }
    try {
      if (pathname === "/api/v1/config/pth") {
        sendJson(res, 200, toBrowserPthConfig(await deps.pthOperatorClient.getPthConfig()));
      } else {
        sendJson(res, 200, toBrowserRoles(await deps.pthOperatorClient.getPthRoles()));
      }
    } catch {
      sendUpstreamFailure(res, "PTH_UNAVAILABLE");
    }
    return true;
  }
  if (pathname.startsWith("/api/v1/config") || pathname.startsWith("/api/v1/roles")) {
    sendJson(res, 404, { error: { code: "NOT_FOUND", message: "unknown config/roles route" } });
    return true;
  }

  // ── /api/memory/*：只读记忆浏览器（GET-only；limit 101 拒绝；无写路由） ──
  if (pathname.startsWith("/api/v1/memory")) {
    if (method !== "GET") {
      sendEmpty(res, 405, { allow: "GET" });
      return true;
    }
    if (!requireInspectionSession(req, res, deps)) return true;
    if (!deps.pthOperatorClient) {
      sendJson(res, 503, { error: { code: "MEMORY_UNAVAILABLE", message: "pth inspection channel not assembled" } });
      return true;
    }
    const url = new URL(req.url ?? "/", "http://operator-console.internal");
    const limitRaw = url.searchParams.get("limit");
    if (limitRaw !== null) {
      const limit = Number(limitRaw);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        sendJson(res, 400, { error: { code: "BAD_REQUEST", message: "limit must be an integer in 1..100" } });
        return true;
      }
    }
    try {
      if (pathname === "/api/v1/memory/summary") {
        sendJson(res, 200, await deps.pthOperatorClient.getMemorySummary());
        return true;
      }
      if (pathname === "/api/v1/memory/entries") {
        const query = {
          type: url.searchParams.get("type") ?? undefined,
          kind: url.searchParams.get("kind") ?? undefined,
          status: url.searchParams.get("status") ?? undefined,
          anchor: url.searchParams.get("anchor") ?? undefined,
          cursor: url.searchParams.get("cursor") ?? undefined,
          ...(limitRaw !== null ? { limit: Number(limitRaw) } : {}),
        };
        sendJson(res, 200, toBrowserMemoryPage(await deps.pthOperatorClient.listMemoryEntries(query)));
        return true;
      }
      const entryMatch = /^\/api\/v1\/memory\/entries\/([^/]+)$/.exec(pathname);
      if (entryMatch) {
        const id = decodeURIComponent(entryMatch[1]!);
        sendJson(res, 200, toBrowserMemoryDetail(await deps.pthOperatorClient.getMemoryEntry(id)));
        return true;
      }
      const revisionMatch = /^\/api\/v1\/memory\/entries\/([^/]+)\/revisions$/.exec(pathname);
      if (revisionMatch) {
        const id = decodeURIComponent(revisionMatch[1]!);
        sendJson(res, 200, toBrowserMemoryRevisions(await deps.pthOperatorClient.getMemoryRevisions(id)));
        return true;
      }
      sendJson(res, 404, { error: { code: "NOT_FOUND", message: "unknown memory route" } });
      return true;
    } catch {
      sendUpstreamFailure(res, "PTH_UNAVAILABLE");
      return true;
    }
  }

  // ── /api/debug/*：只读调试页（GET-only；未知路径 404，POST 一律 405/404） ──
  if (pathname === "/api/v1/debug/workers") {
    if (method !== "GET") {
      sendEmpty(res, 405, { allow: "GET" });
      return true;
    }
    if (!requireInspectionSession(req, res, deps)) return true;
    if (!deps.pthOperatorClient) {
      sendJson(res, 503, { error: { code: "DEBUG_UNAVAILABLE", message: "pth inspection channel not assembled" } });
      return true;
    }
    try {
      const workers = toBrowserDebugWorkers(await deps.pthOperatorClient.listWorkers());
      sendJson(res, 200, { workers, tenant: deps.operatorTenant, space: deps.operatorSpace });
    } catch {
      sendUpstreamFailure(res, "PTH_UNAVAILABLE");
    }
    return true;
  }
  if (pathname.startsWith("/api/v1/debug")) {
    sendJson(res, 404, { error: { code: "NOT_FOUND", message: "unknown debug route" } });
    return true;
  }

  return false;
}
