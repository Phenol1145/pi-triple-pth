/**
 * bridge/client.ts — PTH HTTP 客户端
 *
 * 与 PTH server 通信：submit / list / get / delete / run（SSE 流）。
 * 错误区分：401 token 无效 / 404 PTH 版本过旧 / 其他网络错误。
 */
import { loadConfig, getConfigValue } from "@away_from/shared";
import { type ProgramManifest, type ComponentManifest } from "./manifest.js";
import type { SSEEvent, SubmitResponse, ProgramEntry, ObserveSession, ObserveTraceEntry, ObserveTrace, ObserveEventEntry, ObserveEventsResult, FallbackRequestEntry } from "./client-types.js";
export type { SSEEvent, SubmitResponse, ProgramEntry, ObserveSession, ObserveTraceEntry, ObserveTrace, ObserveEventEntry, ObserveEventsResult, FallbackRequestEntry } from "./client-types.js";

export class PthClient {
  private url: string;
  private token: string;

  constructor(url: string, token: string) {
    this.url = url.replace(/\/+$/, "");
    this.token = token;
  }

  /** 从 pi-triple.json 读取配置构造客户端 */
  static fromConfig(): PthClient | null {
    const url = process.env.PTH_URL ?? getConfigValue("pth.url");
    const token = process.env.PTH_TOKEN ?? getConfigValue("pth.token");
    if (!url || !token) return null;
    return new PthClient(url, token);
  }

  /** Bearer 认证头 */
  private headers(json = true): Record<string, string> {
    const h: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
    };
    if (json) h["Content-Type"] = "application/json";
    return h;
  }

  /** WS 握手认证 token（hub debug 用，F/WP4 Task 22） */
  get authToken(): string {
    return this.token;
  }

  /** 基础 URL（SSE/fetch 直调用——console --follow） */
  get baseUrl(): string {
    return this.url;
  }

  /**
   * SSE 流消费（统一出口——console --follow 等流式命令复用）：
   * GET 流式端点 → 逐事件回调（data: 行解析——[DONE] 终止）。
   * opts.signal 可中止连接；HTTP 错误经 throwError 统一翻译（401/404 可操作提示）。
   */
  async streamSSE(path: string, onEvent: (e: unknown) => void, opts: { signal?: AbortSignal } = {}): Promise<void> {
    const res = await this.request(path, {
      headers: { Authorization: `Bearer ${this.token}` },
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    if (!res.ok) await this.throwError(res, "SSE 连接失败");
    if (!res.body) throw new Error(`SSE 连接失败: 响应无 body（${this.url}${path}）`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const flushBlock = (block: string): boolean => {
      const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
      if (!dataLine) return false;
      const payload = dataLine.slice(6);
      if (payload === "[DONE]") return true;
      try { onEvent(JSON.parse(payload)); } catch { /* 非 JSON 行忽略 */ }
      return false;
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const blocks = buf.split("\n\n");
        buf = blocks.pop() ?? "";
        for (const block of blocks) {
          if (flushBlock(block)) return;
        }
      }
      // 收尾：无空行结尾的最后一个事件（网络截断容错）
      if (buf.trim() && flushBlock(buf)) return;
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * hub debug WebSocket 地址（F/WP4 Task 22）：http→ws 换算 + /ws/debug 路径。
   * 目标非 sandbox 时带 ?sessionId=（指定调试会话标识）。
   */
  debugUrl(sessionId?: string): string {
    const base = this.url.replace(/^http/, "ws");
    const q = sessionId && sessionId !== "sandbox" ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
    return `${base}/ws/debug${q}`;
  }

  /** 统一请求：网络层错误翻译为可操作提示（连接拒绝/DNS/超时等） */
  /** 公开请求（返回 JSON——jobs 族用；自动带 Bearer 认证头） */
  async requestJson(path: string, init: RequestInit): Promise<unknown> {
    const res = await this.request(path, { ...init, headers: { ...this.headers(), ...(init.headers ?? {}) } });
    if (!res.ok) await this.throwError(res, `HTTP ${res.status}`);
    const text = await res.text();
    try { return text ? JSON.parse(text) : {}; } catch { return { raw: text }; }
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(`${this.url}${path}`, init);
    } catch (err: any) {
      const reason = err?.cause?.code ?? err?.cause?.message ?? err?.message ?? String(err);
      throw new Error(
        `无法连接 PTH 服务器 (${this.url}${path})：${reason}。` +
        `请确认 pth 已启动（node dist/pth/main.js），或检查 ptl config get pth.url`
      );
    }
  }

  /** 提交程序 */
  async submit(manifest: ProgramManifest, archive: Buffer): Promise<SubmitResponse> {
    const body = JSON.stringify({
      name: manifest.name,
      manifest,
      archive: archive.toString("base64"),
    });

    const res = await this.request("/api/v1/programs", {
      method: "POST",
      headers: this.headers(),
      body,
    });

    if (!res.ok) {
      await this.throwError(res, "提交失败");
    }

    return (await res.json()) as SubmitResponse;
  }

  /** 提交构件（F/WP4 Task 17/20）：components API；requestId 可选（respond 闭合关联） */
  async submitComponent(
    type: ComponentManifest["type"],
    manifest: ComponentManifest,
    archive: Buffer,
    requestId?: string,
  ): Promise<SubmitResponse> {
    const body = JSON.stringify({
      type,
      manifest,
      archive: archive.toString("base64"),
      ...(requestId !== undefined ? { requestId } : {}),
    });

    const res = await this.request("/api/v1/components", {
      method: "POST",
      headers: this.headers(),
      body,
    });

    if (!res.ok) {
      await this.throwError(res, "提交构件失败");
    }

    return (await res.json()) as SubmitResponse;
  }

  /** 手动建单（F/WP4 Task 20） */
  async createFallbackRequest(input: {
    description: string;
    slotHint?: string;
    urgency?: string;
  }): Promise<FallbackRequestEntry> {
    const res = await this.request("/api/v1/fallback-requests", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      await this.throwError(res, "创建回退请求失败");
    }
    return (await res.json()) as FallbackRequestEntry;
  }

  /** 观测：会话列表（F/WP4 Task 21——Redis 会话痕迹） */
  async listObserveSessions(): Promise<ObserveSession[]> {
    const res = await this.request("/api/v1/observe/sessions", {
      headers: this.headers(),
    });
    if (!res.ok) {
      await this.throwError(res, "获取观测会话列表失败");
    }
    return (await res.json()) as ObserveSession[];
  }

  /** 观测：会话详情（meta） */
  async getObserveSession(id: string): Promise<ObserveSession> {
    const res = await this.request(`/api/v1/observe/sessions/${encodeURIComponent(id)}`, {
      headers: this.headers(),
    });
    if (!res.ok) {
      await this.throwError(res, "获取观测会话详情失败");
    }
    return (await res.json()) as ObserveSession;
  }

  /** 观测：记忆概要（N33 Task 7 只读记忆页） */
  async observeMemorySummary(): Promise<unknown> {
    return this.requestJson("/api/v1/observe/memory/summary", { method: "GET", headers: this.headers() });
  }

  /** 观测：记忆条目列表（N33 Task 7；limit/cursor 由服务端 fail-closed） */
  async observeMemoryEntries(query: {
    type?: string; kind?: string; status?: string; anchor?: string; cursor?: string; limit?: number;
  }): Promise<unknown> {
    const params = new URLSearchParams();
    for (const key of ["type", "kind", "status", "anchor", "cursor"] as const) {
      const v = query[key];
      if (typeof v === "string" && v !== "") params.set(key, v);
    }
    if (typeof query.limit === "number") params.set("limit", String(query.limit));
    const qs = params.size > 0 ? `?${params.toString()}` : "";
    return this.requestJson(`/api/v1/observe/memory/entries${qs}`, { method: "GET", headers: this.headers() });
  }

  /** 观测：记忆条目精确读取（惰性 detail） */
  async observeMemoryEntry(id: string): Promise<unknown> {
    return this.requestJson(`/api/v1/observe/memory/entries/${encodeURIComponent(id)}`, {
      method: "GET", headers: this.headers(),
    });
  }

  /** 观测：记忆条目最近修订（固定 limit=10） */
  async observeMemoryRevisions(id: string): Promise<unknown> {
    return this.requestJson(`/api/v1/observe/memory/entries/${encodeURIComponent(id)}/revisions`, {
      method: "GET", headers: this.headers(),
    });
  }

  /** 观测：PTH 配置投影（N33 Task 8 只读配置页） */
  async observeConfig(): Promise<unknown> {
    return this.requestJson("/api/v1/observe/config", { method: "GET", headers: this.headers() });
  }

  /** 观测：PTH 角色目录（N33 Task 8） */
  async observeRoles(): Promise<unknown> {
    return this.requestJson("/api/v1/observe/roles", { method: "GET", headers: this.headers() });
  }

  /** 观测：Worker 检查列表（N33 Task 6 只读调试页） */
  async listObserveWorkers(): Promise<unknown[]> {
    const data = await this.requestJson("/api/v1/observe/workers", {
      method: "GET",
      headers: this.headers(),
    });
    if (Array.isArray(data)) return data as unknown[];
    if (typeof data === "object" && data !== null && Array.isArray((data as { items?: unknown }).items)) {
      return (data as { items: unknown[] }).items as unknown[];
    }
    return [];
  }

  /** 观测：trace 时间线（全部 entry） */
  async getObserveTrace(id: string): Promise<ObserveTrace> {
    const res = await this.request(`/api/v1/observe/trace/${encodeURIComponent(id)}`, {
      headers: this.headers(),
    });
    if (!res.ok) {
      await this.throwError(res, "获取 trace 失败");
    }
    return (await res.json()) as ObserveTrace;
  }

  /** 观测：事件查询（EventLog 代理——常驻会话通道查询，F/WP5 Task 28b） */
  async getObserveEvents(filter?: { eventType?: string; since?: number; until?: number; limit?: number }): Promise<ObserveEventsResult> {
    const qs = new URLSearchParams();
    if (filter?.eventType) qs.set("eventType", filter.eventType);
    if (filter?.since !== undefined) qs.set("since", String(filter.since));
    if (filter?.until !== undefined) qs.set("until", String(filter.until));
    if (filter?.limit !== undefined) qs.set("limit", String(filter.limit));
    const q = qs.toString();
    const res = await this.request(`/api/v1/observe/events${q ? `?${q}` : ""}`, {
      headers: this.headers(),
    });
    if (!res.ok) {
      await this.throwError(res, "获取事件失败");
    }
    return (await res.json()) as ObserveEventsResult;
  }

  /** 回退请求列表（F/WP4 Task 20——open 优先） */
  async listFallbackRequests(): Promise<FallbackRequestEntry[]> {
    const res = await this.request("/api/v1/fallback-requests", {
      headers: this.headers(),
    });
    if (!res.ok) {
      await this.throwError(res, "获取回退请求列表失败");
    }
    return (await res.json()) as FallbackRequestEntry[];
  }

  /** 列出程序 */
  async list(): Promise<ProgramEntry[]> {
    const res = await this.request("/api/v1/programs", {
      headers: this.headers(),
    });

    if (!res.ok) {
      await this.throwError(res, "获取程序列表失败");
    }

    return (await res.json()) as ProgramEntry[];
  }

  /** 获取程序详情 */
  async get(name: string): Promise<unknown> {
    const res = await this.request(`/api/v1/programs/${encodeURIComponent(name)}`, {
      headers: this.headers(),
    });

    if (!res.ok) {
      await this.throwError(res, "获取程序详情失败");
    }

    return await res.json();
  }

  /** 删除程序 */
  async delete(name: string): Promise<void> {
    const res = await this.request(`/api/v1/programs/${encodeURIComponent(name)}`, {
      method: "DELETE",
      headers: this.headers(),
    });

    if (!res.ok) {
      await this.throwError(res, "删除失败");
    }
  }

  /** 运行程序（返回 SSE 事件流） */
  async *run(name: string, input: string | Record<string, string>, version?: number): AsyncIterable<SSEEvent> {
    const body = JSON.stringify({
      input,
      ...(version !== undefined ? { version } : {}),
    });

    const res = await this.request(`/api/v1/programs/${encodeURIComponent(name)}/run`, {
      method: "POST",
      headers: this.headers(),
      body,
    });

    if (!res.ok) {
      await this.throwError(res, "运行失败");
    }

    if (!res.body) {
      throw new Error("PTH 未返回 SSE 流");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6).trim();
          if (payload === "[DONE]") return;
          try {
            const parsed = JSON.parse(payload) as Record<string, unknown>;
            // SSE 信封：{seq, type, data, terminal, timestamp}——解包，data 为真正事件数据
            yield {
              type: (parsed.type as string) ?? "unknown",
              data: (parsed.data ?? parsed) as Record<string, unknown>,
            };
          } catch {
            // 忽略解析失败的行
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /** 统一错误处理 */
  private async throwError(res: Response, prefix: string): Promise<never> {
    if (res.status === 401) {
      throw new Error(`${prefix}: Token 无效 (401)。检查 ptl config get pth.token`);
    }
    if (res.status === 404) {
      throw new Error(`${prefix}: 路由不存在 (404)。PTH 可能版本过旧，请升级`);
    }
    let body = "";
    try {
      body = await res.text();
    } catch { /* ignore */ }
    throw new Error(`${prefix}: HTTP ${res.status}${body ? " — " + body : ""}`);
  }

  // ── kernel 任务/批次（任务工具 Task 3）────────────────────

  /** 发布 PTH 任务（kernel tasks 表）；payload 可选（任务链 flow 声明 / WorkEnvelope 盖章等路由信息） */
  async publishTask(input: {
    title: string;
    text: string;
    createdBy: string;
    tags?: string[];
    payload?: Record<string, unknown>;
    /** N33 复验收 P0-4：tenant-scoped 原生幂等键，重复发布收敛到首次任务。 */
    idempotencyKey?: string;
  }): Promise<{ id: string; status: string } & Record<string, unknown>> {
    const res = await this.request("/api/v1/kernel/tasks", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(input),
    });
    if (!res.ok) await this.throwError(res, "发布任务失败");
    return (await res.json()) as { id: string; status: string } & Record<string, unknown>;
  }

  /** 模板发布任务（kernel 侧渲染） */
  async publishTemplateTask(
    template: string,
    params: Record<string, unknown>,
    opts: { createdBy?: string; tags?: string[] } = {},
  ): Promise<{ id: string; status: string } & Record<string, unknown>> {
    const res = await this.request("/api/v1/kernel/tasks", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ template, params, createdBy: opts.createdBy ?? process.env.USER ?? "ptl", tags: opts.tags }),
    });
    if (!res.ok) await this.throwError(res, "模板发布任务失败");
    return (await res.json()) as { id: string; status: string } & Record<string, unknown>;
  }

  /** 模板列表 */
  async listTemplates(): Promise<Array<{ id: string; name: string; description: string; params: Array<{ key: string; required: boolean; description: string }> }>> {
    const res = await this.request("/api/v1/kernel/templates", { method: "GET", headers: this.headers() });
    if (!res.ok) await this.throwError(res, "模板列表失败");
    return (await res.json()) as Array<{ id: string; name: string; description: string; params: Array<{ key: string; required: boolean; description: string }> }>;
  }

  /** 任务列表（kernel tasks 表） */
  async listTasks(opts: { limit?: number } = {}): Promise<Array<Record<string, unknown>>> {
    const q = opts.limit ? `?limit=${opts.limit}` : "";
    const res = await this.request(`/api/v1/kernel/tasks${q}`, { method: "GET", headers: this.headers() });
    if (!res.ok) await this.throwError(res, "任务列表失败");
    return (await res.json()) as Array<Record<string, unknown>>;
  }

  /** 任务详情（W8 P2：wait/cancel 复用） */
  async getTask(id: string): Promise<Record<string, unknown> | null> {
    const res = await this.request(`/api/v1/kernel/tasks/${encodeURIComponent(id)}`, { method: "GET", headers: this.headers() });
    if (res.status === 404) return null;
    if (!res.ok) await this.throwError(res, "任务详情失败");
    return (await res.json()) as Record<string, unknown>;
  }

  /** 取消任务（recursive=true 沿 delivery.parent 链传播到未终态子任务——W8 P2） */
  async cancelTask(id: string, opts: { recursive?: boolean } = {}): Promise<{ cancelled: number; taskIds: string[] }> {
    const res = await this.request(`/api/v1/kernel/tasks/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(opts),
    });
    if (!res.ok) await this.throwError(res, "取消任务失败");
    return (await res.json()) as { cancelled: number; taskIds: string[] };
  }

  /** worker 级控制（pause/resume/remove/add） */
  async workerControl(batchId: string, action: string, role: string, copies?: number): Promise<Record<string, unknown>> {
    const res = await this.request(`/api/v1/kernel/batch/${encodeURIComponent(batchId)}/workers`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ action, role, copies }),
    });
    if (!res.ok) await this.throwError(res, "worker 控制失败");
    return (await res.json()) as Record<string, unknown>;
  }

  /** 启动 n 个 batch（支持 profile：role/copies/weights——⑤强化/均衡模式） */
  async batchAddProfile(count = 1, opts: { role?: string; copies?: number; weights?: string } = {}): Promise<{ spawned: number; mode: string; batches: Array<{ id: string; pid: number; workers?: string[] }> }> {
    const body: Record<string, unknown> = { count };
    if (opts.role) { body.role = opts.role; if (opts.copies) body.copies = opts.copies; }
    else if (opts.weights) {
      // "developer:3,analyst:2" → {developer:3, analyst:2}
      const w: Record<string, number> = {};
      for (const part of opts.weights.split(",")) {
        const [role, n] = part.trim().split(":");
        if (role) w[role] = n ? Number(n) : 1;
      }
      body.weights = w;
    }
    const res = await this.request("/api/v1/kernel/batch/add", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) await this.throwError(res, "启动 batch 失败");
    return (await res.json()) as { spawned: number; mode: string; batches: Array<{ id: string; pid: number; workers?: string[] }> };
  }

  /** 启动 n 个 batch */
  async batchAdd(count = 1): Promise<{ spawned: number; batches: Array<{ id: string; pid: number }> }> {
    const res = await this.request("/api/v1/kernel/batch/add", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ count }),
    });
    if (!res.ok) await this.throwError(res, "启动 batch 失败");
    return (await res.json()) as { spawned: number; batches: Array<{ id: string; pid: number }> };
  }

  /** 停止 n 个 batch */
  async batchRemove(count = 1): Promise<{ stopped: number }> {
    const res = await this.request("/api/v1/kernel/batch/remove", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ count }),
    });
    if (!res.ok) await this.throwError(res, "停止 batch 失败");
    return (await res.json()) as { stopped: number };
  }

  /** batch 列表 */
  async batchList(): Promise<Array<Record<string, unknown>>> {
    const res = await this.request("/api/v1/kernel/batch", { method: "GET", headers: this.headers() });
    if (!res.ok) await this.throwError(res, "batch 列表失败");
    return (await res.json()) as Array<Record<string, unknown>>;
  }

  /** kernel 运行状态全景（监控面板铺垫） */
  async kernelStatus(): Promise<{
    kernel: { connected: boolean };
    batches: Array<Record<string, unknown>>;
    tasks: Record<string, number>;
    watchdog: { crashLog: Array<Record<string, unknown>> };
    collectedAt: number;
  }> {
    const res = await this.request("/api/v1/kernel/status", { method: "GET", headers: this.headers() });
    if (!res.ok) await this.throwError(res, "kernel 状态获取失败");
    return (await res.json()) as {
      kernel: { connected: boolean };
      batches: Array<Record<string, unknown>>;
      tasks: Record<string, number>;
      watchdog: { crashLog: Array<Record<string, unknown>> };
      collectedAt: number;
    };
  }

  // ── N33 Task 5：intake 原生动作窄面（PTL operator console 的 PTH 入口）──

  /** 创建知识摄入订阅（scope 由 PTH 端 auth token 决定；不得携带 manifest/私钥） */
  async createIntakeSubscription(input: {
    canonicalUri: string;
    domainId: string;
    recrawlIntervalMs: number;
    declared: { sourceType: string; contentType: string; license: string };
    idempotencyKey?: string;
    expectedPolicyId?: string;
    expectedPolicyVersion?: string;
    expectedPolicyDigest?: string;
  }): Promise<Record<string, unknown>> {
    const res = await this.request("/api/v1/intake/subscriptions", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(input),
    });
    if (!res.ok) await this.throwError(res, "创建摄入订阅失败");
    return (await res.json()) as Record<string, unknown>;
  }

  /** 摄入订阅详情（404 → null） */
  async getIntakeSubscription(id: string): Promise<Record<string, unknown> | null> {
    const res = await this.request(`/api/v1/intake/subscriptions/${encodeURIComponent(id)}`, {
      method: "GET",
      headers: this.headers(),
    });
    if (res.status === 404) return null;
    if (!res.ok) await this.throwError(res, "摄入订阅详情失败");
    return (await res.json()) as Record<string, unknown>;
  }

  /** 手动触发一次摄入 run（幂等键去重：重复键返回原 run） */
  async triggerIntakeRun(input: {
    subscriptionId: string;
    idempotencyKey: string;
  }): Promise<Record<string, unknown>> {
    const res = await this.request("/api/v1/intake/runs", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(input),
    });
    if (!res.ok) await this.throwError(res, "触发摄入 run 失败");
    return (await res.json()) as Record<string, unknown>;
  }

  /** 摄入 run 状态（404 → null） */
  async getIntakeRun(id: string): Promise<Record<string, unknown> | null> {
    const res = await this.request(`/api/v1/intake/runs/${encodeURIComponent(id)}`, {
      method: "GET",
      headers: this.headers(),
    });
    if (res.status === 404) return null;
    if (!res.ok) await this.throwError(res, "摄入 run 状态失败");
    return (await res.json()) as Record<string, unknown>;
  }
}
