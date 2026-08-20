/**
 * operator-console/server.ts — loopback-only HTTP server（import-safe factory）
 *
 * 路由表显式，无 catch-all proxy。只服务六个冻结的静态资源文件名；
 * 未知 /api/* 一律 JSON 404；未知页面路径仅在认证后 302 到 /#/overview。
 * 不开启 CORS。浏览器侧拿不到 PTH/N30 token 或 Docker socket 路径。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isWorkMode, getConfigValue } from "@away_from/shared";
import {
  parseCookieHeader,
  readJsonBody,
  sendEmpty,
  sendJson,
  sendText,
  sendUpstreamFailure,
} from "./server-http.js";
import { loadOperatorConsoleAssets } from "./server-assets.js";
import { handleInspectionRoutes } from "./routes-inspection.js";
import {
  createOperatorSessionManager,
  OPERATOR_COOKIE_NAME,
  OPERATOR_SESSION_IDLE_TIMEOUT_MS,
  OPERATOR_TOKEN_PATTERN,
  type OperatorSessionClock,
  type OperatorSessionManager,
} from "./session.js";
import {
  createN30ReadOnlyProxy,
  isN30ReadOnlyProxyPath,
  type N30ReadOnlyProxy,
} from "./n30-proxy.js";
import {
  createOperatorWorkService,
  OperatorWorkError,
  type OperatorWorkService,
} from "./preview-store.js";
import { createInMemoryChannelAudit, createOperatorChannelAudit } from "./channel-audit.js";
import { createOperatorActionRegistry } from "./action-registry.js";
import { createPthOperatorClient, type PthOperatorClient } from "./pth-operator-client.js";
import {
  toBrowserDebugWorkers,
  toBrowserMemoryDetail,
  toBrowserMemoryPage,
  toBrowserMemoryRevisions,
  toBrowserPthConfig,
  toBrowserRoles,
} from "./browser-dto.js";
import { createRunTaskPublishAdapter } from "./actions/run-actions.js";
import {
  createIntakeRunTriggerAdapter,
  createIntakeSubscriptionCreateAdapter,
} from "./actions/intake-actions.js";
import { createOptimizeSuggestionApplyAdapter } from "./actions/optimize-actions.js";
import type { NativeWorkRef, OperatorContext } from "./contracts.js";

const NATIVE_WORK_KINDS = new Set(["task", "professional-job", "intake-run", "optimizer-work"]);

export interface OperatorConsolePthDeps {
  readonly baseUrl?: string;
  /** PTH admin token 只允许存在于服务端内存；任何响应/静态资源都不得包含它。 */
  readonly token?: string;
}

export interface OperatorConsoleN30Deps {
  readonly baseUrl?: string;
}

export interface OperatorConsoleWorkDeps {
  /** 测试/组合注入的 work service；缺省时由 pth.baseUrl+token 自动装配三个原生 adapter。 */
  readonly service?: OperatorWorkService;
  /** 通道审计 JSONL 落盘路径（0600/O_APPEND）；缺省内存审计（进程内）。 */
  readonly auditPath?: string;
}

export interface OperatorConsoleServerDeps {
  /** 只允许 127.0.0.1；省略默认 127.0.0.1，显式其他值立即抛错（fail-closed）。 */
  readonly host?: string;
  /** 预生成的一次性 bootstrap token（64 位小写 hex）；省略则由 startOperatorConsole 生成。 */
  readonly bootstrapToken?: string;
  readonly operatorPrincipalId?: string;
  readonly clock?: OperatorSessionClock;
  readonly idleTimeoutMs?: number;
  readonly port?: number;
  /** 服务端持有的 PTH/N30 端点；本 Task 不暴露给浏览器，只作为 API 壳依赖。 */
  readonly pth: OperatorConsolePthDeps;
  readonly n30: OperatorConsoleN30Deps;
  /** work 页操作上下文 tenant/space（应与 pth token 声明一致）；缺省 default/ts。 */
  readonly tenant?: string;
  readonly space?: string;
  /** N33 Task 5：work 页一次性预览/确认/提交通道。 */
  readonly work?: OperatorConsoleWorkDeps;
}

export interface OperatorConsoleServer {
  readonly server: Server;
  readonly origin: string;
  readonly hostHeader: string;
  readonly port: number;
  listen(): Promise<{ port: number; bootstrapUrl: string }>;
  close(): Promise<void>;
}

const BIND_HOST = "127.0.0.1";

export function createOperatorConsoleServer(deps: OperatorConsoleServerDeps): OperatorConsoleServer {
  const host = deps.host ?? BIND_HOST;
  if (host !== BIND_HOST) {
    throw new Error(`operator console only binds to 127.0.0.1 (refusing host: ${host})`);
  }

  const bootstrapToken = deps.bootstrapToken ?? "";
  if (!OPERATOR_TOKEN_PATTERN.test(bootstrapToken)) {
    throw new Error("operator console bootstrap token must be 64 lowercase hex characters");
  }
  const operatorPrincipalId = deps.operatorPrincipalId ?? "human-local-operator";

  const sessions: OperatorSessionManager = createOperatorSessionManager({
    clock: deps.clock,
    idleTimeoutMs: deps.idleTimeoutMs ?? OPERATOR_SESSION_IDLE_TIMEOUT_MS,
  });
  sessions.issueBootstrapToken(operatorPrincipalId, bootstrapToken);

  const assets = loadOperatorConsoleAssets();

  // N30 只读同源代理：只接受服务端配置的 loopback URL；未配置时 /observe/* 显式降级。
  const n30Proxy: N30ReadOnlyProxy | null = deps.n30.baseUrl
    ? createN30ReadOnlyProxy({ baseUrl: deps.n30.baseUrl })
    : null;
  // ── N33 Task 5：work 页通道装配（registry + 三个原生 adapter + 一次性预览服务）──
  const operatorTenant = deps.tenant ?? "default";
  const operatorSpace = deps.space ?? "ts";
  // PTH token 只闭包进 server 侧 client；任何响应/静态资源都不得包含它。
  const pthOperatorClient: PthOperatorClient | null =
    deps.pth.baseUrl && deps.pth.token
      ? createPthOperatorClient({ baseUrl: deps.pth.baseUrl, token: deps.pth.token })
      : null;
  const workService: OperatorWorkService | null = (() => {
    if (deps.work?.service) return deps.work.service;
    if (!pthOperatorClient) return null;
    const client = pthOperatorClient;
    const registry = createOperatorActionRegistry();
    registry.register(createRunTaskPublishAdapter({ client }));
    registry.register(createIntakeSubscriptionCreateAdapter({ client }));
    registry.register(createIntakeRunTriggerAdapter({ client }));
    registry.register(createOptimizeSuggestionApplyAdapter({ client }));
    const audit = deps.work?.auditPath
      ? createOperatorChannelAudit({ filePath: deps.work.auditPath })
      : createInMemoryChannelAudit();
    return createOperatorWorkService({ registry, audit });
  })();

  function operatorContext(): OperatorContext {
    return { tenant: operatorTenant, space: operatorSpace };
  }

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      sendJson(res, 500, { error: { code: "INTERNAL", message: "internal operator console error" } });
    });
  });

  let originValue: string | undefined;
  let hostHeaderValue: string | undefined;
  let portValue: number | undefined;

  const started = new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once("error", onError);
    server.listen(deps.port ?? 0, host, () => {
      server.off("error", onError);
      const address = server.address();
      if (address && typeof address === "object") {
        portValue = address.port;
        originValue = `http://${BIND_HOST}:${address.port}`;
        hostHeaderValue = `${BIND_HOST}:${address.port}`;
      }
      resolve();
    });
  });

  function requireBound(): number {
    if (portValue === undefined || originValue === undefined || hostHeaderValue === undefined) {
      throw new Error("operator console server is not listening yet; await listen() first");
    }
    return portValue;
  }

  function clearSessionCookie(res: ServerResponse): void {
    res.setHeader("set-cookie", `${OPERATOR_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
  }

  function sessionCookieHeader(res: ServerResponse, token: string, maxAgeSeconds: number): void {
    res.setHeader(
      "set-cookie",
      `${OPERATOR_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}`,
    );
  }

  function hostMatches(req: IncomingMessage): boolean {
    const expected = hostHeaderValue;
    return expected !== undefined && req.headers.host === expected;
  }

  function originMatches(req: IncomingMessage): boolean {
    return originValue !== undefined && req.headers.origin === originValue;
  }

  /** 已认证 POST 的统一守卫：方法已由路由保证，检查 Origin、Host、cookie、过期与 CSRF。 */
  function guardAuthenticatedPost(req: IncomingMessage, res: ServerResponse): boolean {
    if (!originMatches(req) || !hostMatches(req)) {
      sendJson(res, 403, { error: { code: "FORBIDDEN_ORIGIN_HOST", message: "forged origin or host" } });
      return false;
    }
    const sessionToken = parseCookieHeader(req.headers.cookie).get(OPERATOR_COOKIE_NAME);
    if (!sessionToken || !sessions.authenticate(sessionToken)) {
      sendJson(res, 401, { error: { code: "UNAUTHORIZED", message: "missing or expired session" } });
      return false;
    }
    const csrf = req.headers["x-ptl-csrf"];
    if (typeof csrf !== "string" || !sessions.verifyCsrf(sessionToken, csrf)) {
      sendJson(res, 401, { error: { code: "CSRF_MISMATCH", message: "missing or wrong X-PTL-CSRF" } });
      return false;
    }
    return true;
  }

  /** 已认证 GET 的统一守卫：Host + cookie 会话（GET 无 CSRF 要求）。 */
  function requireSessionGet(req: IncomingMessage, res: ServerResponse): boolean {
    if (!hostMatches(req)) {
      sendJson(res, 403, { error: { code: "FORBIDDEN_HOST", message: "forged host" } });
      return false;
    }
    const sessionToken = parseCookieHeader(req.headers.cookie).get(OPERATOR_COOKIE_NAME);
    if (!sessionToken || !sessions.authenticate(sessionToken)) {
      sendJson(res, 401, { error: { code: "UNAUTHORIZED", message: "missing or expired session" } });
      return false;
    }
    return true;
  }

  /** work 通道错误映射：归一化 code → 语义化 HTTP 状态；上游正文绝不透传。 */
  function sendWorkError(res: ServerResponse, err: unknown): void {
    if (err instanceof OperatorWorkError) {
      const status =
        err.code === "PREVIEW_EXPIRED" ? 410
          : err.code === "PREVIEW_CONSUMED" || err.code === "IDEMPOTENCY_CONFLICT" || err.code === "PREVIEW_IN_FLIGHT" ? 409
            : err.code === "UNKNOWN_ACTION" ? 404
              : err.code === "PENDING_LIMIT" ? 429
                : err.code === "NATIVE_SUBMIT_ERROR" ? 502
                  : 400;
      const message = err.code === "NATIVE_SUBMIT_ERROR"
        ? "native submit failed; retry with the same idempotency key"
        : err.message;
      sendJson(res, status, { error: { code: err.code, message } });
      return;
    }
    if (/unknown operator action/i.test(err instanceof Error ? err.message : String(err))) {
      sendJson(res, 404, { error: { code: "UNKNOWN_ACTION", message: "unknown operator action" } });
      return;
    }
    sendJson(res, 400, { error: { code: "WORK_REJECTED", message: "work channel rejected the request" } });
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestUrl = req.url ?? "/";
    let pathname: string;
    try {
      pathname = new URL(requestUrl, `http://${BIND_HOST}`).pathname;
    } catch {
      sendJson(res, 400, { error: { code: "BAD_REQUEST", message: "invalid request path" } });
      return;
    }
    const method = req.method ?? "GET";

    // 协议 v1：旧版未版本化路径（/api/…）过渡重写到 /api/v1/…；规范客户端直接使用 /api/v1。
    if (pathname.startsWith("/api/") && !pathname.startsWith("/api/v1/")) {
      pathname = `/api/v1${pathname.slice("/api".length)}`;
    }
    if (pathname === "/api/v1/version") {
      if (method !== "GET" && method !== "HEAD") {
        sendEmpty(res, 405, { allow: "GET, HEAD" });
        return;
      }
      sendJson(res, 200, { api: "v1", service: "ptl-operator-console", version: "1.4.0" });
      return;
    }

    // ── 静态资源（只服务已知文件名，fixed MIME，同源无 CORS） ──
    const assetName = pathname === "/" ? "index.html" : pathname.slice(1);
    const asset = assets.get(assetName);
    if (asset) {
      if (method !== "GET" && method !== "HEAD") {
        sendEmpty(res, 405, { allow: "GET, HEAD" });
        return;
      }
      sendText(res, 200, asset.buffer.toString("utf8"), asset.mime);
      return;
    }

    // ── /api/config|roles、/api/memory/*、/api/debug/*：只读巡检路由 ──
    if (await handleInspectionRoutes(req, res, pathname, method, {
      host: deps.host,
      port: deps.port,
      operatorPrincipalId,
      sessions,
      pthOperatorClient,
      workService,
      operatorTenant,
      operatorSpace,
      n30Configured: Boolean(deps.n30.baseUrl),
    })) {
      return;
    }

    // ── /observe/*：N30 只读同源代理（GET-only，显式白名单，无 catch-all） ──
    if (isN30ReadOnlyProxyPath(pathname)) {
      if (method !== "GET") {
        sendJson(res, 403, {
          error: { code: "READ_ONLY_PROXY", message: "N30 observability proxy is read-only; only GET is allowed" },
        });
        return;
      }
      if (!hostMatches(req)) {
        sendJson(res, 403, { error: { code: "FORBIDDEN_HOST", message: "forged host" } });
        return;
      }
      const sessionToken = parseCookieHeader(req.headers.cookie).get(OPERATOR_COOKIE_NAME);
      if (!sessionToken || !sessions.authenticate(sessionToken)) {
        sendJson(res, 401, { error: { code: "UNAUTHORIZED", message: "missing or expired session" } });
        return;
      }
      if (!n30Proxy) {
        sendJson(res, 502, {
          error: { code: "N30_NOT_CONFIGURED", message: "N30 observability source is not configured" },
        });
        return;
      }
      await n30Proxy.handle(req, res, pathname);
      return;
    }

    // /observe 前缀的非白名单路径 fail-closed 404（不落到未知页面 302）。
    if (pathname.startsWith("/observe")) {
      sendJson(res, 404, { error: { code: "NOT_FOUND", message: "unknown observe route" } });
      return;
    }

    // ── API（显式路由；未知 /api/* 一律 JSON 404） ──
    if (pathname === "/api/v1/session/bootstrap") {
      if (method !== "POST") {
        sendEmpty(res, 405, { allow: "POST" });
        return;
      }
      if (!originMatches(req) || !hostMatches(req)) {
        sendJson(res, 403, { error: { code: "FORBIDDEN_ORIGIN_HOST", message: "forged origin or host" } });
        return;
      }
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        sendJson(res, 400, { error: { code: "BAD_REQUEST", message: err instanceof Error ? err.message : String(err) } });
        return;
      }
      if (typeof body !== "object" || body === null || typeof (body as Record<string, unknown>).token !== "string") {
        sendJson(res, 400, { error: { code: "BAD_REQUEST", message: "body must be JSON with a token string" } });
        return;
      }
      const rawToken = (body as Record<string, unknown>).token as string;
      const bootstrapped = sessions.bootstrap(rawToken);
      if (!bootstrapped) {
        sendJson(res, 401, { error: { code: "BOOTSTRAP_REJECTED", message: "one-time bootstrap token rejected" } });
        return;
      }
      sessionCookieHeader(res, bootstrapped.sessionToken, Math.floor((deps.idleTimeoutMs ?? OPERATOR_SESSION_IDLE_TIMEOUT_MS) / 1000));
      sendJson(res, 200, {
        ok: true,
        csrfToken: bootstrapped.csrfToken,
        operatorPrincipalId: bootstrapped.principalId,
        expiresAt: bootstrapped.expiresAt,
      });
      return;
    }

    if (pathname === "/api/v1/session") {
      if (method !== "GET" && method !== "HEAD") {
        sendEmpty(res, 405, { allow: "GET, HEAD" });
        return;
      }
      if (!hostMatches(req)) {
        sendJson(res, 403, { error: { code: "FORBIDDEN_HOST", message: "forged host" } });
        return;
      }
      const sessionToken = parseCookieHeader(req.headers.cookie).get(OPERATOR_COOKIE_NAME);
      if (!sessionToken) {
        sendJson(res, 401, { error: { code: "UNAUTHORIZED", message: "missing session cookie" } });
        return;
      }
      const session = sessions.authenticate(sessionToken);
      if (!session) {
        sendJson(res, 401, { error: { code: "UNAUTHORIZED", message: "missing or expired session" } });
        return;
      }
      sendJson(res, 200, { ok: true, operatorPrincipalId: session.principalId, expiresAt: session.expiresAt });
      return;
    }

    // ── N33 Task 5：work 页一次性预览/确认/提交/原生状态路由 ──
    // 全部是显式路由；未登记动作在 registry.get 处 404；未装配 work service → 503。
    if (pathname === "/api/v1/work/actions") {
      if (method !== "GET" && method !== "HEAD") {
        sendEmpty(res, 405, { allow: "GET, HEAD" });
        return;
      }
      if (!requireSessionGet(req, res)) return;
      if (!workService) {
        sendJson(res, 503, { error: { code: "WORK_UNAVAILABLE", message: "work channel not assembled (missing pth baseUrl/token)" } });
        return;
      }
      sendJson(res, 200, {
        actions: workService.listActions(),
        tenant: operatorTenant,
        space: operatorSpace,
      });
      return;
    }

    if (pathname === "/api/v1/work/preview") {
      if (method !== "POST") {
        sendEmpty(res, 405, { allow: "POST" });
        return;
      }
      if (!guardAuthenticatedPost(req, res)) return;
      if (!workService) {
        sendJson(res, 503, { error: { code: "WORK_UNAVAILABLE", message: "work channel not assembled" } });
        return;
      }
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        sendJson(res, 400, { error: { code: "BAD_REQUEST", message: err instanceof Error ? err.message : String(err) } });
        return;
      }
      const b = (body ?? {}) as Record<string, unknown>;
      if (!isWorkMode(b.mode) || typeof b.action !== "string" || b.action.trim() === "") {
        sendJson(res, 400, { error: { code: "BAD_REQUEST", message: "mode/action required" } });
        return;
      }
      try {
        const preview = await workService.preview(b.mode, b.action, b.input ?? {}, operatorContext());
        sendJson(res, 200, { preview, tenant: operatorTenant, space: operatorSpace });
      } catch (err) {
        sendWorkError(res, err);
      }
      return;
    }

    if (pathname === "/api/v1/work/submit") {
      if (method !== "POST") {
        sendEmpty(res, 405, { allow: "POST" });
        return;
      }
      if (!guardAuthenticatedPost(req, res)) return;
      if (!workService) {
        sendJson(res, 503, { error: { code: "WORK_UNAVAILABLE", message: "work channel not assembled" } });
        return;
      }
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        sendJson(res, 400, { error: { code: "BAD_REQUEST", message: err instanceof Error ? err.message : String(err) } });
        return;
      }
      try {
        const ref = await workService.submit(body as never, operatorContext());
        sendJson(res, 200, { ref });
      } catch (err) {
        sendWorkError(res, err);
      }
      return;
    }

    if (pathname === "/api/v1/work/evaluate") {
      if (method !== "POST") {
        sendEmpty(res, 405, { allow: "POST" });
        return;
      }
      if (!guardAuthenticatedPost(req, res)) return;
      if (!workService) {
        sendJson(res, 503, { error: { code: "WORK_UNAVAILABLE", message: "work channel not assembled" } });
        return;
      }
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        sendJson(res, 400, { error: { code: "BAD_REQUEST", message: err instanceof Error ? err.message : String(err) } });
        return;
      }
      const b = (body ?? {}) as Record<string, unknown>;
      if (!isWorkMode(b.mode) || typeof b.kind !== "string" || !NATIVE_WORK_KINDS.has(b.kind) || typeof b.id !== "string" || b.id === "") {
        sendJson(res, 400, { error: { code: "BAD_REQUEST", message: "mode/kind/id required" } });
        return;
      }
      // tenant/space 由服务端盖章——body 永远不接受 tenantId（跨 tenant 引用在 service 层拒绝）。
      const ref: NativeWorkRef = {
        mode: b.mode,
        kind: b.kind as NativeWorkRef["kind"],
        id: b.id,
        tenantId: operatorTenant,
        submittedAt: typeof b.submittedAt === "string" ? b.submittedAt : "",
      };
      try {
        sendJson(res, 200, { acceptance: await workService.evaluate(ref, operatorContext()) });
      } catch (err) {
        sendWorkError(res, err);
      }
      return;
    }

    if (pathname.startsWith("/api/v1/work/native/")) {
      if (method !== "GET" && method !== "HEAD") {
        sendEmpty(res, 405, { allow: "GET, HEAD" });
        return;
      }
      if (!requireSessionGet(req, res)) return;
      if (!workService) {
        sendJson(res, 503, { error: { code: "WORK_UNAVAILABLE", message: "work channel not assembled" } });
        return;
      }
      const parts = pathname.slice("/api/v1/work/native/".length).split("/").filter((s) => s !== "");
      if (parts.length !== 2) {
        sendJson(res, 404, { error: { code: "NOT_FOUND", message: "unknown native ref path" } });
        return;
      }
      const [kindRaw, idRaw] = parts as [string, string];
      let modeParam: string | null = null;
      try {
        modeParam = new URL(requestUrl, `http://${BIND_HOST}`).searchParams.get("mode");
      } catch { /* pathname 已验证过 */ }
      const kind = decodeURIComponent(kindRaw);
      const id = decodeURIComponent(idRaw);
      if (!NATIVE_WORK_KINDS.has(kind) || !modeParam || !isWorkMode(modeParam) || id === "") {
        sendJson(res, 400, { error: { code: "BAD_REQUEST", message: "native ref requires kind/id and a valid ?mode=" } });
        return;
      }
      const ref: NativeWorkRef = {
        mode: modeParam,
        kind: kind as NativeWorkRef["kind"],
        id,
        tenantId: operatorTenant,
        submittedAt: "",
      };
      try {
        sendJson(res, 200, { projection: await workService.inspect(ref, operatorContext()) });
      } catch (err) {
        sendWorkError(res, err);
      }
      return;
    }

    if (pathname === "/api/v1/session/logout") {      if (method !== "POST") {
        sendEmpty(res, 405, { allow: "POST" });
        return;
      }
      const sessionToken = parseCookieHeader(req.headers.cookie).get(OPERATOR_COOKIE_NAME);
      if (!guardAuthenticatedPost(req, res)) return;
      sessions.destroy(sessionToken!);
      clearSessionCookie(res);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (pathname.startsWith("/api/v1/")) {
      sendJson(res, 404, { error: { code: "NOT_FOUND", message: "unknown api route" } });
      return;
    }

    // ── 未知页面路径：认证后 302 到 /#/overview；未认证 401 ──
    if (method !== "GET" && method !== "HEAD") {
      sendEmpty(res, 405, { allow: "GET, HEAD" });
      return;
    }
    const sessionToken = parseCookieHeader(req.headers.cookie).get(OPERATOR_COOKIE_NAME);
    if (!sessionToken || !sessions.authenticate(sessionToken)) {
      sendJson(res, 401, { error: { code: "UNAUTHORIZED", message: "missing or expired session" } });
      return;
    }
    sendEmpty(res, 302, { location: "/#/overview" });
  }

  async function listen(): Promise<{ port: number; bootstrapUrl: string }> {
    await started;
    const port = requireBound();
    return { port, bootstrapUrl: `${originValue}/#${bootstrapToken}` };
  }

  async function close(): Promise<void> {
    if (n30Proxy) await n30Proxy.close();
    if (!server.listening) return;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  return {
    server,
    get origin(): string {
      return originValue ?? `http://${BIND_HOST}:0`;
    },
    get hostHeader(): string {
      return hostHeaderValue ?? `${BIND_HOST}:0`;
    },
    get port(): number {
      return requireBound();
    },
    listen,
    close,
  };
}
