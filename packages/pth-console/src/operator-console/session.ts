/**
 * operator-console/session.ts — 一次性 bootstrap + 短时会话（内存态）
 *
 * 安全要点：
 * - bootstrap 与会话 token 只存 SHA-256 摘要，比较用 timingSafeEqual。
 * - 会话 30 分钟空闲过期（每次认证成功顺延）。
 * - 纯 HTTP loopback 使用 `ptl-operator` cookie（浏览器 __Host- 前缀要求 HTTPS），
 *   任何路径都不得声称 Secure；未来 TLS profile 才切换 __Host-ptl-operator。
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const OPERATOR_SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
export const OPERATOR_COOKIE_NAME = "ptl-operator";
export const OPERATOR_TOKEN_PATTERN = /^[0-9a-f]{64}$/;

export type OperatorSessionClock = () => number;

export interface OperatorSessionView {
  readonly id: string;
  readonly principalId: string;
  readonly expiresAt: string;
}

export interface OperatorBootstrapResult {
  readonly sessionToken: string;
  readonly csrfToken: string;
  readonly principalId: string;
  readonly expiresAt: string;
}

export interface OperatorSessionManager {
  /** 预置（或生成）一次性 bootstrap token；只返回明文，内部只存摘要。 */
  issueBootstrapToken(principalId: string, rawToken?: string): string;
  /** 一次性兑换：成功即消费 bootstrap token 并创建会话；任何失败返回 null。 */
  bootstrap(rawToken: string): OperatorBootstrapResult | null;
  /** 校验会话 cookie token；成功顺延空闲过期。 */
  authenticate(sessionToken: string): OperatorSessionView | null;
  /** CSRF 校验（不顺延空闲过期）。 */
  verifyCsrf(sessionToken: string, csrfToken: string): boolean;
  /** 销毁会话（logout）。 */
  destroy(sessionToken: string): void;
}

interface PendingBootstrap {
  readonly digest: Buffer;
  readonly principalId: string;
  readonly expiresAt: number;
}

interface SessionRecord {
  readonly id: string;
  readonly tokenDigest: Buffer;
  readonly csrfDigest: Buffer;
  readonly principalId: string;
  expiresAt: number;
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function newToken(): string {
  return randomBytes(32).toString("hex");
}

function isToken(value: unknown): value is string {
  return typeof value === "string" && OPERATOR_TOKEN_PATTERN.test(value);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function createOperatorSessionManager(options: {
  clock?: OperatorSessionClock;
  idleTimeoutMs?: number;
} = {}): OperatorSessionManager {
  const clock = options.clock ?? (() => Date.now());
  const idleTimeoutMs = options.idleTimeoutMs ?? OPERATOR_SESSION_IDLE_TIMEOUT_MS;

  let pending: PendingBootstrap | null = null;
  const sessions = new Map<string, SessionRecord>();

  function issueBootstrapToken(principalId: string, rawToken?: string): string {
    const token = rawToken ?? newToken();
    if (!isToken(token)) {
      throw new Error("bootstrap token must be 64 lowercase hex characters");
    }
    if (typeof principalId !== "string" || principalId.trim() === "") {
      throw new Error("operator principal id must be a non-empty string");
    }
    pending = {
      digest: sha256(token),
      principalId,
      expiresAt: clock() + idleTimeoutMs,
    };
    return token;
  }

  function bootstrap(rawToken: string): OperatorBootstrapResult | null {
    if (!isToken(rawToken)) return null;
    if (!pending) return null;
    if (clock() > pending.expiresAt) {
      pending = null;
      return null;
    }
    const candidate = sha256(rawToken);
    if (candidate.length !== pending.digest.length || !timingSafeEqual(candidate, pending.digest)) {
      return null;
    }

    const sessionToken = newToken();
    const csrfToken = newToken();
    const record: SessionRecord = {
      id: `op-${newToken().slice(0, 16)}`,
      tokenDigest: sha256(sessionToken),
      csrfDigest: sha256(csrfToken),
      principalId: pending.principalId,
      expiresAt: clock() + idleTimeoutMs,
    };
    pending = null;
    sessions.set(record.id, record);

    return {
      sessionToken,
      csrfToken,
      principalId: record.principalId,
      expiresAt: iso(record.expiresAt),
    };
  }

  function findRecord(sessionToken: string): SessionRecord | null {
    if (!isToken(sessionToken)) return null;
    const digest = sha256(sessionToken);
    for (const record of sessions.values()) {
      if (digest.length === record.tokenDigest.length && timingSafeEqual(digest, record.tokenDigest)) {
        return record;
      }
    }
    return null;
  }

  function authenticate(sessionToken: string): OperatorSessionView | null {
    const record = findRecord(sessionToken);
    if (!record) return null;
    if (clock() > record.expiresAt) {
      sessions.delete(record.id);
      return null;
    }
    record.expiresAt = clock() + idleTimeoutMs;
    return {
      id: record.id,
      principalId: record.principalId,
      expiresAt: iso(record.expiresAt),
    };
  }

  function verifyCsrf(sessionToken: string, csrfToken: string): boolean {
    const record = findRecord(sessionToken);
    if (!record || !isToken(csrfToken)) return false;
    const digest = sha256(csrfToken);
    return digest.length === record.csrfDigest.length && timingSafeEqual(digest, record.csrfDigest);
  }

  function destroy(sessionToken: string): void {
    const record = findRecord(sessionToken);
    if (record) sessions.delete(record.id);
  }

  return {
    issueBootstrapToken,
    bootstrap,
    authenticate,
    verifyCsrf,
    destroy,
  };
}
