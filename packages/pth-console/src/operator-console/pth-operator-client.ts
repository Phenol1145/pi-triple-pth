/**
 * operator-console/pth-operator-client.ts — server 侧 PTH 窄客户端（N33 Task 5）
 *
 * 安全要点：
 *  - PTH baseUrl/token 只存在于服务端内存（构造参数），本模块的任何返回值、
 *    错误信息与日志都不得包含 token；浏览器永远无法经 console 响应拿到凭据；
 *  - 只暴露 work 页面三个原生动作需要的窄方法——不提供任意路径/任意方法请求面；
 *  - 响应做最小形状归一化，原生 body 里的多余字段不透传给上层。
 */

import { PthClient } from "../bridge/client.js";

export interface PthTaskPublishResult {
  readonly id: string;
  readonly status: string;
}

export interface PthTaskView {
  readonly id: string;
  readonly status: string;
  readonly tenantId?: string;
  readonly completedAt?: string;
}

export interface PthIntakeSubscriptionView {
  readonly id: string;
  readonly canonicalUri?: string;
  readonly status: string;
  readonly policyId?: string;
  readonly policyVersion?: string;
  readonly policyDigest?: string;
  readonly domainId?: string;
}

export interface PthIntakeRunView {
  readonly id: string;
  readonly subscriptionId?: string;
  readonly status: string;
  readonly stage?: string;
  readonly attempt?: number;
  readonly lastError?: string;
}

export interface PthOptimizerSuggestionView {
  readonly id: string;
  readonly status: string;
  readonly kind?: string;
  readonly preview?: string;
  readonly created_at?: string;
}

export interface PthOptimizerApplyResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly applied?: { readonly target: string; readonly pattern: string };
}

/** work 页面 adapter 依赖的窄面（测试可注入 fake）。 */
export interface PthOperatorClient {
  publishTask(input: {
    title: string;
    text: string;
    tags?: readonly string[];
    payload?: Readonly<Record<string, unknown>>;
    idempotencyKey?: string;
  }): Promise<PthTaskPublishResult>;
  getTask(id: string): Promise<PthTaskView | null>;
  createIntakeSubscription(input: {
    canonicalUri: string;
    domainId: string;
    recrawlIntervalMs: number;
    declared: { sourceType: string; contentType: string; license: string };
    idempotencyKey?: string;
    expectedPolicyId?: string;
    expectedPolicyVersion?: string;
    expectedPolicyDigest?: string;
  }): Promise<PthIntakeSubscriptionView>;
  getIntakeSubscription(id: string): Promise<PthIntakeSubscriptionView | null>;
  triggerIntakeRun(input: {
    subscriptionId: string;
    idempotencyKey: string;
  }): Promise<PthIntakeRunView>;
  getIntakeRun(id: string): Promise<PthIntakeRunView | null>;
  listOptimizerSuggestions(): Promise<readonly PthOptimizerSuggestionView[]>;
  applyOptimizerSuggestion(input: { id: string }): Promise<PthOptimizerApplyResult>;
  listWorkers(): Promise<readonly unknown[]>;
  getMemorySummary(): Promise<unknown>;
  listMemoryEntries(query: {
    type?: string; kind?: string; status?: string; anchor?: string; cursor?: string; limit?: number;
  }): Promise<unknown>;
  getMemoryEntry(id: string): Promise<unknown>;
  getMemoryRevisions(id: string): Promise<unknown>;
  getPthConfig(): Promise<unknown>;
  getPthRoles(): Promise<unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function requireString(value: unknown, what: string): string {
  const s = asString(value);
  if (s === undefined || s === "") {
    throw new Error(`PTH response missing ${what}`);
  }
  return s;
}

export function createPthOperatorClient(deps: {
  baseUrl: string;
  token: string;
  /** 测试注入；缺省用全局 fetch（经 PthClient 统一错误翻译）。 */
  client?: PthClient;
}): PthOperatorClient {
  if (typeof deps.baseUrl !== "string" || deps.baseUrl.trim() === "") {
    throw new Error("pth operator client requires a baseUrl");
  }
  if (typeof deps.token !== "string" || deps.token.trim() === "") {
    throw new Error("pth operator client requires a server-held token");
  }
  // token 只闭包在 PthClient 内部；本模块不再保存明文引用。
  const inner = deps.client ?? new PthClient(deps.baseUrl, deps.token);

  return {
    async publishTask(input) {
      const raw = await inner.publishTask({
        title: input.title,
        text: input.text,
        createdBy: "ptl-operator-console",
        ...(input.tags ? { tags: [...input.tags] } : {}),
        ...(input.payload ? { payload: input.payload } : {}),
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      });
      return { id: requireString(raw.id, "task id"), status: requireString(raw.status, "task status") };
    },

    async getTask(id) {
      const row = await inner.getTask(id);
      if (!row) return null;
      return {
        id: requireString(row.id, "task id"),
        status: requireString(row.status, "task status"),
        ...(asString(row.tenant_id) !== undefined ? { tenantId: asString(row.tenant_id) } : {}),
        ...(asString(row.completed_at) !== undefined ? { completedAt: asString(row.completed_at) } : {}),
      };
    },

    async createIntakeSubscription(input) {
      const raw = await inner.createIntakeSubscription({
        canonicalUri: input.canonicalUri,
        domainId: input.domainId,
        recrawlIntervalMs: input.recrawlIntervalMs,
        declared: input.declared,
        ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
        ...(input.expectedPolicyId !== undefined ? { expectedPolicyId: input.expectedPolicyId } : {}),
        ...(input.expectedPolicyVersion !== undefined
          ? { expectedPolicyVersion: input.expectedPolicyVersion }
          : {}),
        ...(input.expectedPolicyDigest !== undefined
          ? { expectedPolicyDigest: input.expectedPolicyDigest }
          : {}),
      });
      return {
        id: requireString(raw.id, "subscription id"),
        status: requireString(raw.status, "subscription status"),
        ...(asString(raw.canonicalUri) !== undefined ? { canonicalUri: asString(raw.canonicalUri) } : {}),
        ...(asString(raw.policyId) !== undefined ? { policyId: asString(raw.policyId) } : {}),
        ...(asString(raw.policyVersion) !== undefined ? { policyVersion: asString(raw.policyVersion) } : {}),
        ...(asString(raw.policyDigest) !== undefined ? { policyDigest: asString(raw.policyDigest) } : {}),
        ...(asString(raw.domainId) !== undefined ? { domainId: asString(raw.domainId) } : {}),
      };
    },

    async getIntakeSubscription(id) {
      const raw = await inner.getIntakeSubscription(id);
      if (!raw || raw.id === undefined) return null;
      return {
        id: requireString(raw.id, "subscription id"),
        status: requireString(raw.status, "subscription status"),
        ...(asString(raw.canonicalUri) !== undefined ? { canonicalUri: asString(raw.canonicalUri) } : {}),
        ...(asString(raw.policyId) !== undefined ? { policyId: asString(raw.policyId) } : {}),
        ...(asString(raw.policyVersion) !== undefined ? { policyVersion: asString(raw.policyVersion) } : {}),
        ...(asString(raw.policyDigest) !== undefined ? { policyDigest: asString(raw.policyDigest) } : {}),
        ...(asString(raw.domainId) !== undefined ? { domainId: asString(raw.domainId) } : {}),
      };
    },

    async triggerIntakeRun(input) {
      const raw = await inner.triggerIntakeRun({
        subscriptionId: input.subscriptionId,
        idempotencyKey: input.idempotencyKey,
      });
      return {
        id: requireString(raw.id, "run id"),
        status: requireString(raw.status, "run status"),
        ...(asString(raw.subscriptionId) !== undefined ? { subscriptionId: asString(raw.subscriptionId) } : {}),
        ...(asString(raw.stage) !== undefined ? { stage: asString(raw.stage) } : {}),
        ...(typeof raw.attempt === "number" ? { attempt: raw.attempt } : {}),
      };
    },

    async getIntakeRun(id) {
      const raw = await inner.getIntakeRun(id);
      if (!raw || raw.id === undefined) return null;
      return {
        id: requireString(raw.id, "run id"),
        status: requireString(raw.status, "run status"),
        ...(asString(raw.subscriptionId) !== undefined ? { subscriptionId: asString(raw.subscriptionId) } : {}),
        ...(asString(raw.stage) !== undefined ? { stage: asString(raw.stage) } : {}),
        ...(typeof raw.attempt === "number" ? { attempt: raw.attempt } : {}),
        ...(asString(raw.lastError) !== undefined ? { lastError: asString(raw.lastError) } : {}),
      };
    },

    async listOptimizerSuggestions() {
      const raw = (await inner.requestJson("/api/v1/kernel/optimizer/suggestions", {
        method: "GET",
      })) as unknown;
      if (!Array.isArray(raw)) return [];
      return raw
        .filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null)
        .map((row) => ({
          id: requireString(row.id, "suggestion id"),
          status: requireString(row.status, "suggestion status"),
          ...(asString(row.kind) !== undefined ? { kind: asString(row.kind) } : {}),
          ...(asString(row.preview) !== undefined ? { preview: asString(row.preview) } : {}),
          ...(asString(row.created_at) !== undefined ? { created_at: asString(row.created_at) } : {}),
        }));
    },

    async listWorkers() {
      return await inner.listObserveWorkers();
    },

    async getMemorySummary() {
      return await inner.observeMemorySummary();
    },

    async listMemoryEntries(query) {
      return await inner.observeMemoryEntries(query);
    },

    async getMemoryEntry(id) {
      return await inner.observeMemoryEntry(id);
    },

    async getMemoryRevisions(id) {
      return await inner.observeMemoryRevisions(id);
    },

    async getPthConfig() {
      return await inner.observeConfig();
    },

    async getPthRoles() {
      return await inner.observeRoles();
    },

    async applyOptimizerSuggestion(input) {
      const raw = (await inner.requestJson("/api/v1/kernel/optimizer/apply", {
        method: "POST",
        body: JSON.stringify({ id: input.id }),
      })) as Record<string, unknown>;
      const applied = raw.applied as { target?: unknown; pattern?: unknown } | undefined;
      return {
        ok: raw.ok === true,
        ...(asString(raw.error) !== undefined ? { error: asString(raw.error) } : {}),
        ...(applied && asString(applied.target) !== undefined && asString(applied.pattern) !== undefined
          ? { applied: { target: applied.target as string, pattern: applied.pattern as string } }
          : {}),
      };
    },
  };
}
