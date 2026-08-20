import { createStore } from "./store";

export type SessionState = "bootstrapping" | "ready" | "expired" | "failed";

export type SessionFailureKind = "none" | "unauthorized" | "network" | "http";

export interface SessionInfo {
  state: SessionState;
  csrfToken: string | null;
  operatorPrincipalId: string | null;
  /** ISO timestamp or epoch-ms string from the server. */
  expiresAt: string | null;
  failureKind: SessionFailureKind;
}

const ONE_TIME_TOKEN_PATTERN = /^[0-9a-f]{64}$/i;

export const sessionStore = createStore<SessionInfo>({
  state: "bootstrapping",
  csrfToken: null,
  operatorPrincipalId: null,
  expiresAt: null,
  failureKind: "none",
});

interface SessionPayload {
  ok?: boolean;
  csrfToken?: string;
  operatorPrincipalId?: string;
  expiresAt?: string | number;
}

/**
 * Extract a one-time bootstrap token from the URL fragment.
 * Returns null when no well-formed token is present.
 */
function extractFragmentToken(): string | null {
  const raw = window.location.hash.replace(/^#/, "");
  if (ONE_TIME_TOKEN_PATTERN.test(raw)) {
    return raw.toLowerCase();
  }
  return null;
}

function normalizeExpiresAt(value: string | number | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  return String(value);
}

function applyReady(payload: SessionPayload): void {
  sessionStore.set({
    state: "ready",
    csrfToken: typeof payload.csrfToken === "string" ? payload.csrfToken : null,
    operatorPrincipalId:
      typeof payload.operatorPrincipalId === "string"
        ? payload.operatorPrincipalId
        : null,
    expiresAt: normalizeExpiresAt(payload.expiresAt),
    failureKind: "none",
  });
}

/**
 * First-load session bootstrap.
 * When the URL fragment carries a one-time token, exchange it for a cookie
 * session, then strip the fragment so the token never persists in the URL,
 * history, or referrer headers. Otherwise probe the existing cookie session.
 */
export async function bootstrapSession(): Promise<void> {
  const token = extractFragmentToken();
  if (token) {
    const exchange = fetch("/api/v1/session/bootstrap", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    // Remove the token from the URL immediately; the exchange continues
    // in the background regardless of what the address bar shows.
    window.history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search,
    );
    try {
      const response = await exchange;
      if (response.ok) {
        const payload = (await response.json()) as SessionPayload;
        applyReady(payload);
        return;
      }
      if (response.status === 401 || response.status === 403) {
        sessionStore.update({ state: "expired", failureKind: "unauthorized" });
        return;
      }
      sessionStore.update({ state: "failed", failureKind: "http" });
      return;
    } catch {
      sessionStore.update({ state: "failed", failureKind: "network" });
      return;
    }
  }
  await refreshSession();
}

/**
 * Re-check the cookie session via GET /api/v1/session.
 * 200 -> ready, 401 -> expired (operator needs a fresh one-time link),
 * network failure -> failed/degraded.
 */
export async function refreshSession(): Promise<void> {
  let response: Response;
  try {
    response = await fetch("/api/v1/session", { credentials: "same-origin" });
  } catch {
    sessionStore.update({ state: "failed", failureKind: "network" });
    return;
  }
  if (response.ok) {
    try {
      const payload = (await response.json()) as SessionPayload;
      applyReady(payload);
    } catch {
      sessionStore.update({ state: "failed", failureKind: "http" });
    }
    return;
  }
  if (response.status === 401) {
    sessionStore.update({
      state: "expired",
      failureKind: "unauthorized",
      csrfToken: null,
      operatorPrincipalId: null,
      expiresAt: null,
    });
    return;
  }
  sessionStore.update({ state: "failed", failureKind: "http" });
}

/** Parse expiresAt (ISO string or epoch ms) into a millisecond timestamp. */
export function sessionExpiryMs(expiresAt: string | null): number | null {
  if (!expiresAt) {
    return null;
  }
  const parsed = Date.parse(expiresAt);
  if (!Number.isNaN(parsed)) {
    return parsed;
  }
  const asNumber = Number(expiresAt);
  if (Number.isFinite(asNumber) && asNumber > 0) {
    return asNumber;
  }
  return null;
}
