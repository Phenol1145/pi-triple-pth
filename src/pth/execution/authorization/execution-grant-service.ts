/**
 * execution/authorization/execution-grant-service.ts — 签名 grant 签发与校验（模块化 v2 P2-1）。
 *
 * - 签发：随机 grantId/nonce + 显式 TTL；canonical payload HMAC 签名。
 * - 校验：结构合法 → 签名合法 → 未过期 → generation 匹配 → replayGuard 单次消费。
 * - 密钥只来自注入的 GrantKeyProvider；本层不产生任何默认凭据。
 */

import { randomUUID } from "node:crypto";
import {
  isExecutionGrantStructurallyValid,
  type ExecutionGrant,
  type ExecutionLanguage,
  type ExecutionRequest,
  type TaskLeaseReference,
  type TenantScope,
  type WorkspaceRef,
} from "@away_from/pth-contracts";
import type { GrantKeyProvider } from "./grant-key-provider.js";

export interface ExecutionGrantIssueInput {
  lease: TaskLeaseReference;
  scope: TenantScope;
  workspace: WorkspaceRef;
  language: ExecutionLanguage;
  capabilities: readonly string[];
  ttlMs?: number;
}

export interface ExecutionGrantVerifyOptions {
  leaseGeneration?: number;
  /** 可选：校验 grant 与具体 request 绑定（防 grant/request 换绑） */
  request?: ExecutionRequest;
}

export interface ReplayGuard {
  checkAndRecord(nonce: string, expiresAtEpochMs: number): boolean;
}

export interface ExecutionGrantService {
  issue(input: ExecutionGrantIssueInput): ExecutionGrant;
  verify(grant: unknown, opts?: ExecutionGrantVerifyOptions): { ok: true; grant: ExecutionGrant } | { ok: false; error: string };
}

export interface ExecutionGrantServiceOptions {
  keyProvider: GrantKeyProvider;
  clock?: () => Date;
  replayGuard?: ReplayGuard;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = stable((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function canonicalGrantPayload(grant: ExecutionGrant): string {
  return JSON.stringify(stable({
    grantId: grant.grantId,
    nonce: grant.nonce,
    lease: grant.lease,
    scope: grant.scope,
    workspace: grant.workspace,
    language: grant.language,
    capabilities: grant.capabilities,
    issuedAt: grant.issuedAt,
    deadlineAt: grant.deadlineAt,
  }));
}

export function createExecutionGrantService(opts: ExecutionGrantServiceOptions): ExecutionGrantService {
  const clock = opts.clock ?? (() => new Date());
  const now = () => clock();

  function issue(input: ExecutionGrantIssueInput): ExecutionGrant {
    const ttlMs = input.ttlMs ?? 60_000;
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error("grant ttlMs must be positive");
    const issuedAt = now();
    const deadlineAt = new Date(issuedAt.getTime() + ttlMs);
    const grant: ExecutionGrant = {
      grantId: randomUUID(),
      nonce: randomUUID(),
      lease: input.lease,
      scope: input.scope,
      workspace: input.workspace,
      language: input.language,
      capabilities: input.capabilities,
      issuedAt: issuedAt.toISOString(),
      deadlineAt: deadlineAt.toISOString(),
    };
    const payload = canonicalGrantPayload(grant);
    return { ...grant, signature: opts.keyProvider.sign(payload) };
  }

  function verify(v: unknown, verifyOpts: ExecutionGrantVerifyOptions = {}): { ok: true; grant: ExecutionGrant } | { ok: false; error: string } {
    if (!isExecutionGrantStructurallyValid(v)) return { ok: false, error: "grant structurally invalid" };
    const grant = v;
    if (typeof grant.signature !== "string" || grant.signature === "") return { ok: false, error: "grant signature missing" };
    if (!opts.keyProvider.verify(canonicalGrantPayload(grant), grant.signature)) return { ok: false, error: "grant signature invalid" };

    const current = now().getTime();
    if (new Date(grant.issuedAt).getTime() > current) return { ok: false, error: "grant issued in the future" };
    if (new Date(grant.deadlineAt).getTime() <= current) return { ok: false, error: "grant expired" };

    if (verifyOpts.leaseGeneration !== undefined && grant.lease.generation !== verifyOpts.leaseGeneration) {
      return { ok: false, error: `grant generation mismatch（grant=${grant.lease.generation}, current=${verifyOpts.leaseGeneration}）` };
    }

    if (verifyOpts.request) {
      const r = verifyOpts.request;
      if (r.scope.tenantId !== grant.scope.tenantId || r.workspace.workspaceId !== grant.workspace.workspaceId || r.language !== grant.language) {
        return { ok: false, error: "grant not bound to this request" };
      }
    }

    if (opts.replayGuard && !opts.replayGuard.checkAndRecord(grant.nonce, new Date(grant.deadlineAt).getTime())) {
      return { ok: false, error: "grant replay detected" };
    }
    return { ok: true, grant };
  }

  return { issue, verify };
}

export function createMemoryReplayGuard(opts: { clock?: () => Date; maxEntries?: number } = {}): ReplayGuard {
  const seen = new Map<string, number>();
  const clock = opts.clock ?? (() => new Date());
  const maxEntries = opts.maxEntries ?? 10_000;
  return {
    checkAndRecord(nonce: string, expiresAtEpochMs: number): boolean {
      const nowMs = clock().getTime();
      for (const [k, exp] of seen) {
        if (exp <= nowMs) seen.delete(k);
      }
      if (seen.has(nonce)) return false;
      if (seen.size >= maxEntries) {
        // 有界防内存放大：清掉最旧一个
        const oldest = seen.keys().next().value;
        if (oldest) seen.delete(oldest);
      }
      seen.set(nonce, expiresAtEpochMs);
      return true;
    },
  };
}
