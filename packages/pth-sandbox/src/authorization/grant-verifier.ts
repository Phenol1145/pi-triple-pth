/**
 * authorization/grant-verifier.ts — sandbox 侧执行 grant 签发/校验（模块化 v2 P2-2）。
 *
 * sandbox 包不依赖 PTH core，因此这里保留一份与 core 契约同构的 wire 类型与 canonical
 * payload/HMAC 实现。密钥只来自部署注入（compose `${...:?}` 语义由装配层保证）；
 * 本模块不提供默认密钥、不读取 SANDBOX_SHARED_SECRET。
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** 任务级 grant 上下文（PTH 侧动态绑定——taskId/tenantId 由 task-loop 每任务提供） */
export interface SandboxGrantContext {
  taskId: string;
  tenantId: string;
  principalId?: string;
}

export interface SandboxExecutionGrant {
  readonly grantId: string;
  readonly nonce: string;
  readonly lease: { taskId: string; leaseId: string; generation: number };
  readonly scope: { tenantId: string; principalId: string; roles: readonly string[]; traceId: string };
  readonly workspace: { tenantId: string; workspaceId: string; taskId?: string };
  readonly language: string;
  readonly capabilities: readonly string[];
  readonly issuedAt: string;
  readonly deadlineAt: string;
  readonly signature?: string;
}

export interface SandboxGrantKeyProvider {
  sign(payload: string): string;
  verify(payload: string, signature: string): boolean;
}

export function createSandboxHmacKeyProvider(opts: { secret: string }): SandboxGrantKeyProvider {
  if (!opts.secret || opts.secret.length < 16) {
    throw new Error("grant signing secret must be at least 16 chars（部署注入，无默认值）");
  }
  return {
    sign(payload) {
      return createHmac("sha256", opts.secret).update(payload).digest("hex");
    },
    verify(payload, signature) {
      const expected = createHmac("sha256", opts.secret).update(payload).digest("hex");
      const a = Buffer.from(expected, "utf8");
      const b = Buffer.from(signature, "utf8");
      return a.length === b.length && timingSafeEqual(a, b);
    },
  };
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

export function canonicalSandboxGrantPayload(grant: SandboxExecutionGrant): string {
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

export interface SandboxGrantIssueInput {
  lease: SandboxExecutionGrant["lease"];
  scope: SandboxExecutionGrant["scope"];
  workspace: SandboxExecutionGrant["workspace"];
  language: string;
  capabilities: readonly string[];
  ttlMs?: number;
}

export interface SandboxGrantIssuer {
  issue(input: SandboxGrantIssueInput): SandboxExecutionGrant;
}

export function createSandboxGrantIssuer(opts: { secret: string; clock?: () => Date }): SandboxGrantIssuer {
  const keyProvider = createSandboxHmacKeyProvider({ secret: opts.secret });
  const clock = opts.clock ?? (() => new Date());
  return {
    issue(input) {
      const ttlMs = input.ttlMs ?? 60_000;
      const issuedAt = clock();
      const grant: SandboxExecutionGrant = {
        grantId: crypto.randomUUID(),
        nonce: crypto.randomUUID(),
        lease: input.lease,
        scope: input.scope,
        workspace: input.workspace,
        language: input.language,
        capabilities: input.capabilities,
        issuedAt: issuedAt.toISOString(),
        deadlineAt: new Date(issuedAt.getTime() + ttlMs).toISOString(),
      };
      return { ...grant, signature: keyProvider.sign(canonicalSandboxGrantPayload(grant)) };
    },
  };
}

export interface SandboxGrantVerifierOptions {
  secret: string;
  /** 允许的租户（缺省 = 只要求 tenantId 与 workspace.tenantId 一致，不设租户白名单） */
  allowedTenants?: readonly string[];
  clock?: () => Date;
}

export interface SandboxGrantVerifier {
  verify(grant: unknown): { ok: true; grant: SandboxExecutionGrant } | { ok: false; error: string };
}

/** persistent 会话私有头：签名 grant 经 base64url(JSON) 传输（wire body 不变，2026-08-22 裁决）。 */
export const SANDBOX_GRANT_HEADER = "x-sandbox-grant";

export function sandboxGrantToHeader(grant: SandboxExecutionGrant): string {
  return Buffer.from(JSON.stringify(grant), "utf8").toString("base64url");
}

export function sandboxGrantFromHeader(header: string): unknown {
  try {
    return JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

export function createSandboxGrantVerifier(opts: SandboxGrantVerifierOptions): SandboxGrantVerifier {
  const keyProvider = createSandboxHmacKeyProvider({ secret: opts.secret });
  const clock = opts.clock ?? (() => new Date());
  return {
    verify(v) {
      if (typeof v !== "object" || v === null) return { ok: false, error: "grant required" };
      const grant = v as SandboxExecutionGrant;
      const requiredStrings: Array<[keyof SandboxExecutionGrant, string]> = [
        ["grantId", grant.grantId],
        ["nonce", grant.nonce],
        ["language", grant.language],
        ["issuedAt", grant.issuedAt],
        ["deadlineAt", grant.deadlineAt],
        ["signature", grant.signature ?? ""],
      ];
      for (const [field, value] of requiredStrings) {
        if (typeof value !== "string" || value.trim() === "") return { ok: false, error: `grant ${String(field)} missing` };
      }
      if (!grant.lease || typeof grant.lease.taskId !== "string" || typeof grant.lease.leaseId !== "string" || !Number.isInteger(grant.lease.generation) || grant.lease.generation <= 0) {
        return { ok: false, error: "grant lease invalid" };
      }
      if (!grant.scope || typeof grant.scope.tenantId !== "string" || grant.scope.tenantId.trim() === "" || typeof grant.scope.principalId !== "string") {
        return { ok: false, error: "grant scope invalid" };
      }
      if (!grant.workspace || typeof grant.workspace.tenantId !== "string" || typeof grant.workspace.workspaceId !== "string") {
        return { ok: false, error: "grant workspace invalid" };
      }
      if (!Array.isArray(grant.capabilities) || grant.capabilities.some((c) => typeof c !== "string")) {
        return { ok: false, error: "grant capabilities invalid" };
      }
      if (!keyProvider.verify(canonicalSandboxGrantPayload(grant), grant.signature!)) {
        return { ok: false, error: "grant signature invalid" };
      }
      const nowMs = clock().getTime();
      if (new Date(grant.issuedAt).getTime() > nowMs) return { ok: false, error: "grant issued in the future" };
      if (new Date(grant.deadlineAt).getTime() <= nowMs) return { ok: false, error: "grant expired" };
      if (grant.scope.tenantId !== grant.workspace.tenantId) return { ok: false, error: "grant tenant/workspace mismatch" };
      if (opts.allowedTenants && !opts.allowedTenants.includes(grant.scope.tenantId)) {
        return { ok: false, error: `tenant not allowed: ${grant.scope.tenantId}` };
      }
      return { ok: true, grant };
    },
  };
}
