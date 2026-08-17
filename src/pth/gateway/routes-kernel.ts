/**
 * gateway/routes-kernel.ts — PTH kernel 任务发布 + 运行状态路由（任务工具 Task 2）
 *
 * 数据源：PthGatewayFacade（模块化 v2 P0-3——gateway 不再直连 KernelRuntime.pool/dataWorld）。
 * 生产形态：PTL（交互层）经 PthClient HTTP 访问；监控面板后续消费 /kernel/status 全景。
 *
 *   POST /api/v1/kernel/tasks         发布任务 → 201 {id, status, ...}
 *   POST /api/v1/kernel/exec          kernel 直连执行（任务池纯化 D2——调试通道：stateless/repl 双模式）
 *   GET  /api/v1/kernel/tasks         任务列表（?status=&limit=）
 *   GET  /api/v1/kernel/tasks/:id     任务详情
 *   POST /api/v1/kernel/batch/add     启动 n 个 batch（默认 1）
 *   POST /api/v1/kernel/batch/remove  停止 n 个 batch（默认 1）
 *   GET  /api/v1/kernel/batch         batch 列表（含 alive 判定）
 *   GET  /api/v1/kernel/status        运行状态全景（kernel/batches/tasks/watchdog——监控面板铺垫）
 *
 * facade 未装配（pg 不可达/null）→ 全部 503 + reason（fail-open 约定）。
 */

import type { FastifyInstance } from "fastify";
import type { PthGatewayFacade } from "../application/gateway/pth-gateway-facade.js";
import type { KnowledgeBroker } from "../execution/index.js";
import type { TenantScope } from "../contracts/index.js";
import { listPublicTemplates, resolveTemplateTask } from "../kernel/templates.js";
import { pthConfig } from "../config/index.js";

const KERNEL_UNAVAILABLE = { error: "kernel unavailable", reason: "DATABASE_URL 未配置或 pg 不可达" };

/** K2 Phase 2：顶层 domains 可选——若提供必须是字符串数组且元素非空；返回 null 表示非法。 */
function parseDomains(v: unknown): string[] | null | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== "string" || item.trim() === "") return null;
    out.push(item.trim());
  }
  return out;
}

export interface KernelRoutesDeps {
  facade: PthGatewayFacade | null;
  /** 性能自持（v0.8）：autopilot 状态（/kernel/status 暴露） */
  autopilot?: { status: () => unknown } | null;
}

export function registerKernelRoutes(app: FastifyInstance, facade: PthGatewayFacade | null, autopilot?: KernelRoutesDeps["autopilot"], knowledgeBroker?: KnowledgeBroker | null): void {
  const unavailable = (reply: { status: (code: number) => { send: (body: unknown) => unknown } }) =>
    reply.status(503).send(KERNEL_UNAVAILABLE);

  // ── ASP-5 记忆桥（2026-08-11）：sandbox python 空间访问记忆的 PTH 侧端点
  //  P0-1（2026-08-15）：不再使用 SANDBOX_SHARED_SECRET 互信，也不再豁免全局 Bearer 鉴权。
  //  tenant 与 space 一律取自 Redis auth token 的声明（服务器端身份）；body 自报 space 一律拒绝。
  //  只读桥：query（queryReadOnly 白名单）/ retrieve / get；写仍留 ts 空间（含可见性盖章）
  app.post("/api/v1/kernel/memory-bridge", async (req, reply) => {
    if (!facade) return unavailable(reply);
    const auth = (req as unknown as { auth?: { tenantId?: string; role?: string; space?: string } }).auth;
    if (!auth?.tenantId || !auth.space) {
      return reply.status(401).send({ error: "memory-bridge requires authenticated tenant + space claim" });
    }
    const body = (req.body ?? {}) as { op?: string; sql?: string; anchors?: string[]; kinds?: string[]; id?: string; space?: string };
    if (body.space !== undefined) {
      return reply.status(400).send({ error: "space must be provided by the auth token, not the request body" });
    }
    const { isVisible } = await import("@away_from/pth-memory");
    const space = auth.space;
    const visible = (meta: Record<string, unknown> | undefined) => isVisible(meta, space);
    try {
      if (body.op === "query") {
        // F2（AB-01）raw query 门禁：memory-bridge 的 query 仅 platform-admin 可用。
        if (auth.role !== "platform-admin") {
          return reply.status(403).send({ error: "memory-bridge query requires platform-admin" });
        }
        const rows = await facade.bridgeQuery(String(body.sql ?? ""));
        // 2026-08-15 筛查 H3：缺 meta 列的行无法判定可见性——fail-closed（不再默认公开）
        if (rows.some((r) => !r || typeof r !== "object" || !("meta" in r))) {
          return reply.status(400).send({ error: "bridge query: 会话空间下查询必须包含 meta 列（可见性过滤依据）" });
        }
        return rows.filter((r) => visible(r!["meta"] as Record<string, unknown>));
      }
      if (body.op === "retrieve") {
        const entries = await facade.bridgeRetrieve(body.anchors ?? [], body.kinds, auth.tenantId);
        return entries.filter((e) => visible(e.meta));
      }
      if (body.op === "get") {
        const e = await facade.bridgeGet(String(body.id ?? ""), auth.tenantId);
        if (!e) return reply.status(404).send({ error: "entry not found" });
        if (!visible(e.meta)) return reply.status(404).send({ error: "entry not visible from space" });
        return e;
      }
      return reply.status(400).send({ error: "op required: query|retrieve|get" });
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── P2-5：grant-bound 执行期知识访问（与 token 化 memory-bridge 并存为兼容通道）──
  // 空间只能来自签名 grant.scope.space；body 自报 space 被 broker 忽略；未授权 401/403。
  app.post("/api/v1/kernel/knowledge", async (req, reply) => {
    if (!knowledgeBroker) return unavailable(reply);
    const body = (req.body ?? {}) as { grant?: unknown; op?: string; sql?: string; anchors?: string[]; kinds?: string[]; id?: string; space?: string };
    const result = await knowledgeBroker.query({
      grant: body.grant as never,
      op: (body.op ?? "") as never,
      sql: body.sql,
      anchors: body.anchors,
      kinds: body.kinds,
      id: body.id,
      space: body.space,
    });
    if (!result.ok) return reply.status(result.status).send({ error: result.error });
    if (result.rows !== undefined) return result.rows;
    if (result.entries !== undefined) return result.entries;
    return result.entry;
  });

  // ── kernel 直连执行通道（任务池纯化 D2——调试/运维代码执行，不占任务池）──────
  app.post("/api/v1/kernel/exec", async (req, reply) => {
    if (!facade) return unavailable(reply);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const code = typeof body.code === "string" ? body.code : "";
    if (!code.trim()) return reply.status(400).send({ error: "code required（TS 程序——能力：llm/memory/python/bash/fs/state/web）" });
    const mode = body.mode === "repl" ? "repl" as const : "stateless" as const;
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : undefined;
    const timeoutMs = typeof body.timeoutMs === "number" && body.timeoutMs > 0 ? Math.min(body.timeoutMs, 600_000) : undefined;
    const result = await facade.execKernel({ code, mode, sessionId, timeoutMs }) as { ok: boolean };
    return reply.status(result.ok ? 200 : 422).send(result);
  });

  // ── 运行过程保留（2026-08-09）：任务轨迹查询 ──────────────────
  app.get("/api/v1/kernel/tasks/:id/transcript", async (req, reply) => {
    if (!facade) return unavailable(reply);
    const { id } = req.params as { id: string };
    const list = await facade.listTranscripts(id);
    const { buildScorecard } = await import("../kernel/execution/worker-scorecard.js");
    return { taskId: id, transcripts: list.map((t: any) => ({
      id: t.id,
      agentId: t.agent_id,
      summary: t.summary,
      events: t.body,        // 轨迹事件数组（llm-call/tool-call/tool-result/finish）
      scorecard: buildScorecard(t.body ?? []),   // worker 性能记分卡（事件流轻聚合——评估层）
      createdAt: t.created_at,
    })) };
  });

  // ── 任务发布 ─────────────────────────────────────────────
  app.post("/api/v1/kernel/tasks", async (req, reply) => {
    if (!facade) return unavailable(reply);
    const body = (req.body ?? {}) as Record<string, unknown>;
    // P0-3/P1-3：tenant 与 createdBy 只能来自服务器端认证身份；body 不允许覆盖
    const auth = (req as unknown as { auth?: { tenantId?: string; role?: string; principalId?: string } }).auth;
    const scope: TenantScope | undefined = auth?.tenantId
      ? { tenantId: auth.tenantId, principalId: auth.principalId ?? `tenant:${auth.tenantId}:${auth.role ?? "tenant-agent"}`, roles: [auth.role ?? "tenant-agent"], traceId: "" }
      : undefined;
    const tenantId = scope?.tenantId ?? "default";
    const domains = parseDomains(body.domains);
    if (domains === null) {
      return reply.status(400).send({ error: "domains 可选——若提供必须是字符串数组且元素非空" });
    }

    // 模板发布：{template, params} → 统一解析器渲染任务（任务模板统一收口 A+）
    if (typeof body.template === "string") {
      const r = resolveTemplateTask({
        template: body.template,
        params: (body.params ?? {}) as Record<string, unknown>,
        tags: Array.isArray(body.tags) ? body.tags.filter((t): t is string => typeof t === "string") : undefined,
      });
      if (!r.ok) {
        if (r.code === "unknown-template") return reply.status(404).send({ error: r.error });
        return reply.status(400).send({ error: r.error, missing: r.missing });
      }
      const task = await facade.publishTask({
        title: r.title,
        text: r.text,
        createdBy: scope?.principalId ?? (typeof body.createdBy === "string" ? body.createdBy : "ptl"),
        tags: r.tags,
        payload: r.payload,
        tenantId,
        domains,
      }, scope);
      return reply.status(201).send(task);
    }

    // 直接发布：{title, text, createdBy, tags?, payload?}
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const text = typeof body.text === "string" ? body.text.trim() : "";
    const createdBy = scope?.principalId ?? (typeof body.createdBy === "string" ? body.createdBy.trim() : "");
    if (!title || !text || !createdBy) {
      return reply.status(400).send({ error: "title/text/createdBy required" });
    }
    // 硬性限制：任务体积上限（防大对象撑 pg/内存/传输——64KB text / 200 字符 title）
    if (title.length > 200 || text.length > 64 * 1024) {
      return reply.status(400).send({ error: `task too large: title ≤200 chars, text ≤64KB (got ${title.length}/${text.length})` });
    }
    const tags = Array.isArray(body.tags) ? body.tags.filter((t): t is string => typeof t === "string") : undefined;
    // payload 透传（任务链 flow 声明等路由信息——发布时 payload 即任务自带路由）
    // body.flow 顶层并入 payload（API 友好——flow 放顶层也能路由——routeTaskRole flowRole 读 payload.flow）
    const payload = { ...((body.payload ?? {}) as Record<string, unknown>), ...(body.flow ? { flow: body.flow } : {}) };
    const task = await facade.publishTask({ title, text, createdBy, tags, payload, tenantId, domains }, scope);
    return reply.status(201).send(task);
  });

  // ── 模板列表（hidden 系统内部模板不外显——模板统一收口 A+） ─────────
  app.get("/api/v1/kernel/templates", async (req, reply) => {
    if (!facade) return unavailable(reply);
    return listPublicTemplates().map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      params: t.params,
    }));
  });

  app.get("/api/v1/kernel/tasks", async (req, reply) => {
    if (!facade) return unavailable(reply);
    const q = (req.query ?? {}) as Record<string, unknown>;
    const limit = typeof q.limit === "string" ? Math.min(Math.max(parseInt(q.limit, 10) || 50, 1), 200) : 50;
    // 列表返回全部状态（pending/claimed/completed/rejected...），按创建时间倒序——
    // candidates() 只返回 pending 队列（批处理认领语义），不适合观测列表（试运行发现）。
    const auth = (req as unknown as { auth?: { tenantId?: string; role?: string; principalId?: string } }).auth;
    const scope: TenantScope | undefined = auth?.tenantId
      ? { tenantId: auth.tenantId, principalId: auth.principalId ?? `tenant:${auth.tenantId}:${auth.role ?? "tenant-agent"}`, roles: [auth.role ?? "tenant-agent"], traceId: "" }
      : undefined;
    return facade.listTasks(limit, scope);
  });

  app.get("/api/v1/kernel/tasks/:id", async (req, reply) => {
    if (!facade) return unavailable(reply);
    const { id } = req.params as { id: string };
    const auth = (req as unknown as { auth?: { tenantId?: string; role?: string; principalId?: string } }).auth;
    const scope: TenantScope | undefined = auth?.tenantId
      ? { tenantId: auth.tenantId, principalId: auth.principalId ?? `tenant:${auth.tenantId}:${auth.role ?? "tenant-agent"}`, roles: [auth.role ?? "tenant-agent"], traceId: "" }
      : undefined;
    const row = await facade.getTask(id, scope);
    if (row === null) return reply.status(404).send({ error: "task not found" });
    return row;
  });

  // W8 P2：任务取消（recursive=true 沿 delivery.parent 链传播到全部未终态子任务）
  app.post("/api/v1/kernel/tasks/:id/cancel", async (req, reply) => {
    if (!facade) return unavailable(reply);
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { recursive?: boolean };
    const auth = (req as unknown as { auth?: { tenantId?: string; role?: string; principalId?: string } }).auth;
    const scope: TenantScope | undefined = auth?.tenantId
      ? { tenantId: auth.tenantId, principalId: auth.principalId ?? `tenant:${auth.tenantId}:${auth.role ?? "tenant-agent"}`, roles: [auth.role ?? "tenant-agent"], traceId: "" }
      : undefined;
    try {
      return await facade.cancelTask(id, { recursive: body.recursive === true }, scope);
    } catch (e) {
      const msg = (e as Error).message;
      return reply.code(msg.includes("不存在") ? 404 : 400).send({ error: msg });
    }
  });

  // ── batch 控制 ───────────────────────────────────────────
  // ── 优化闭环（2026-08-12 体系自制）：建议列表 + 批准应用（监督通道）──
  app.get("/api/v1/kernel/optimizer/suggestions", async (req, reply) => {
    if (!facade) return unavailable(reply);
    try {
      return await facade.optimizerSuggestions();
    } catch (e) {
      return reply.code(500).send({ error: (e as Error).message });
    }
  });
  app.post("/api/v1/kernel/optimizer/apply", async (req, reply) => {
    if (!facade) return unavailable(reply);
    const body = (req.body ?? {}) as { id?: string };
    const id = String(body.id ?? "").trim();
    if (!id) return reply.code(400).send({ error: "id required" });
    try {
      const r = await facade.applyOptimizer(id);
      if (!(r as { ok?: boolean }).ok) return reply.code(400).send(r);
      return r;
    } catch (e) {
      return reply.code(500).send({ error: (e as Error).message });
    }
  });
  // 记忆治理提案批准（2026-08-14 T7 归档闭环执行端——manage.memory.archive 的 draft → 监督批准 → 执行）
  // 2026-08-15 B4 W5：skill-maintain-proposal 同流（提案 → adversarial pass → 监督批准 → 执行）
  app.post("/api/v1/kernel/memory-admin/approve", async (req, reply) => {
    if (!facade) return unavailable(reply);
    const body = (req.body ?? {}) as { id?: string };
    const id = String(body.id ?? "").trim();
    if (!id) return reply.code(400).send({ error: "id required" });
    try {
      const r = await facade.approveMemoryAdmin(id);
      if (!(r as { ok?: boolean }).ok) return reply.code(400).send(r);
      return r;
    } catch (e) {
      return reply.code(500).send({ error: (e as Error).message });
    }
  });
  // ── K4 Phase 4（N22 4）：候选验证与晋升监督通道 ──────────────────
  // body 形状校验失败 400；service 结果 !ok → 400（fail-closed）。
  // 认证沿用既有 kernel 路由模式（无新增角色权限判断——监督通道）。
  app.post("/api/v1/kernel/knowledge/verify", async (req, reply) => {
    if (!facade) return unavailable(reply);
    const body = (req.body ?? {}) as { entryId?: string; kind?: string; verdict?: string; note?: string };
    const entryId = typeof body.entryId === "string" ? body.entryId.trim() : "";
    const kind = body.kind === "domain" || body.kind === "adversarial" ? body.kind : null;
    const verdict = body.verdict === "pass" || body.verdict === "reject" ? body.verdict : null;
    const note = typeof body.note === "string" ? body.note : "";
    if (!entryId || kind === null || verdict === null || !note.trim()) {
      return reply.status(400).send({
        error: "entryId/kind/verdict/note required: kind ∈ domain|adversarial, verdict ∈ pass|reject, note non-empty",
      });
    }
    const auth = (req as unknown as { auth?: { principalId?: string; role?: string } }).auth;
    const reviewerRole = kind === "adversarial"
      ? "controller:adversarial"
      : `domain:${auth?.principalId ?? auth?.role ?? "supervisor"}`;
    const r = await facade.verifyKnowledge(entryId, { kind, verdict, reviewerRole, note, at: Date.now() });
    if (!(r as { ok?: boolean }).ok) return reply.status(400).send(r);
    return r;
  });

  app.post("/api/v1/kernel/knowledge/promote", async (req, reply) => {
    if (!facade) return unavailable(reply);
    const body = (req.body ?? {}) as { entryId?: string };
    const entryId = typeof body.entryId === "string" ? body.entryId.trim() : "";
    if (!entryId) return reply.status(400).send({ error: "entryId required" });
    const r = await facade.promoteKnowledge(entryId);
    if (!(r as { ok?: boolean }).ok) return reply.status(400).send(r);
    return r;
  });

  app.post("/api/v1/kernel/batch/add", async (req, reply) => {
    if (!facade) return unavailable(reply);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const count = typeof body.count === "number" ? Math.min(Math.max(Math.floor(body.count), 1), 10) : 1;
    // BatchProfile（⑤）：role → reinforced 单角色堆叠；weights → balanced 自定义权重；缺省 = 默认构成
    let profile: import("../kernel/execution/worker-cluster.js").BatchProfile | undefined;
    if (typeof body.role === "string" && body.role.length > 0) {
      const copies = typeof body.copies === "number" ? Math.min(Math.max(Math.floor(body.copies), 1), 8) : 1;
      profile = { mode: "reinforced", role: body.role, copies };
    } else if (body.weights && typeof body.weights === "object") {
      profile = { mode: "balanced", weights: body.weights as Record<string, number> };
    }
    try {
      return await facade.spawnBatches(count, profile);
    } catch (e) {
      return reply.status(400).send({ error: `batch 启动失败: ${(e as Error).message}` });
    }
  });

  // ── worker 级控制（单大 batch 启停灵活性）────────────────────────
  // POST /api/v1/kernel/batch/:id/workers {action: pause|resume|remove|add, role, copies?}
  app.post("/api/v1/kernel/batch/:id/workers", async (req, reply) => {
    if (!facade) return unavailable(reply);
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const action = body.action as string;
    const role = body.role as string;
    if (!["pause", "resume", "remove", "add"].includes(action) || typeof role !== "string") {
      return reply.status(400).send({ error: "action ∈ pause|resume|remove|add, role required" });
    }
    const copies = typeof body.copies === "number" ? Math.min(Math.max(Math.floor(body.copies), 1), 8) : 1;
    const ok = await facade.batchWorkers(id, action as "pause" | "resume" | "remove" | "add", role, copies);
    if (!ok) return reply.status(404).send({ error: `batch ${id} not found / IPC 不可用` });
    return { ok: true, batchId: id, action, role, copies: action === "add" ? copies : undefined };
  });

  app.post("/api/v1/kernel/batch/remove", async (req, reply) => {
    if (!facade) return unavailable(reply);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const count = typeof body.count === "number" ? Math.min(Math.max(Math.floor(body.count), 1), 10) : 1;
    return { stopped: await facade.removeBatches(count) };
  });

  app.get("/api/v1/kernel/batch", async (req, reply) => {
    if (!facade) return unavailable(reply);
    return facade.listBatchesWithAlive();
  });

  // ── 运行状态全景（监控面板铺垫）───────────────────────────
  app.get("/api/v1/kernel/status", async (req, reply) => {
    if (!facade) return unavailable(reply);
    const batches = await facade.listBatchesWithAlive();
    const tasks = await facade.taskCounts();
    return {
      kernel: { connected: true },
      autopilot: autopilot?.status() ?? null,
      batches,
      tasks,
      watchdog: { crashLog: facade.crashLog() },
      collectedAt: Date.now(),
    };
  });

  // ── sandbox 活动状态代理（API 覆盖补齐——sandbox:8080 内网隔离——经网关暴露）──
  // ptl hub console --sandbox 数据面：kernel 池（inFlight/idle/capacity）+ 编译统计 + debug 会话
  app.get("/api/v1/kernel/sandbox", async (req, reply) => {
    const sandboxUrl = pthConfig().str("PTH_SANDBOX_KERNEL_URL");
    try {
      // sandbox 通信用共享密钥（SANDBOX_SHARED_SECRET——与 sandbox-kernel 同源——非业务 API token）
      const r = await fetch(`${sandboxUrl}/kernel/status`, {
        headers: { authorization: `Bearer ${pthConfig().str("SANDBOX_SHARED_SECRET")}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) return reply.status(502).send({ error: "sandbox status failed", status: r.status });
      const body = await r.json();
      return { sandbox: body, url: sandboxUrl, collectedAt: Date.now() };
    } catch (e) {
      return reply.status(502).send({ error: "sandbox unreachable", reason: (e as Error).message });
    }
  });

  // ── memory 查询（API 覆盖补齐——分化建议/沉淀/能力索引可查——监督层数据面）──
  // GET /api/v1/kernel/memory?kind=differentiation-proposal&status=draft&anchor=developer&limit=20
  app.get("/api/v1/kernel/memory", async (req, reply) => {
    if (!facade) return unavailable(reply);
    const q = req.query as { kind?: string; status?: string; anchor?: string; limit?: string };
    const kinds = q.kind ? q.kind.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    const statuses = q.status ? q.status.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    const anchors = q.anchor ? q.anchor.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    const limit = Math.min(Math.max(Number(q.limit ?? 20) || 20, 1), 100);
    try {
      const entries = await facade.retrieveMemory({ kinds, status: statuses, anchors });
      return {
        entries: entries.slice(0, limit).map((e) => ({
          id: e.id, kind: e.kind, anchors: e.anchors, status: e.status,
          contentPreview: typeof e.content === "string" ? e.content.slice(0, 500) : "",
          meta: e.meta ?? null,
        })),
        total: entries.length,
        query: { kind: q.kind ?? null, status: q.status ?? null, anchor: q.anchor ?? null, limit },
      };
    } catch (e) {
      return reply.status(500).send({ error: "memory query failed", reason: (e as Error).message });
    }
  });

  // ── 活动事件流（SSE——流式活动状态——ptl hub console --follow 数据面）──
  // 任务接取/agent step（token 用量）/工具调用/完成——实时推送（replay 缓冲补历史）
  app.get("/api/v1/kernel/events", async (req, reply) => {
    if (!facade) return unavailable(reply);
    const { writeSSE } = await import("./sse.js");
    await writeSSE(reply, facade.activityStream());
  });

  // memory 单条详情（全量 content——console show 用）
  app.get("/api/v1/kernel/memory/:id", async (req, reply) => {
    if (!facade) return unavailable(reply);
    const { id } = req.params as { id: string };
    try {
      const entries = await facade.retrieveMemory({});
      const entry = entries.find((e) => e.id === id);
      if (!entry) return reply.status(404).send({ error: "memory entry not found", id });
      return entry;
    } catch (e) {
      return reply.status(500).send({ error: "memory query failed", reason: (e as Error).message });
    }
  });
}
