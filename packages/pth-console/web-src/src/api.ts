import { sessionStore } from "./session";

/**
 * Stable client-facing error. `code` is a safe, lowercase identifier the UI
 * may render directly; upstream error bodies are never surfaced as-is.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(code: string, status: number) {
    super(code);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

const SAFE_CODE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

function extractStableCode(data: unknown, status: number): string {
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    const candidate = record.code ?? record.error;
    if (typeof candidate === "string" && SAFE_CODE_PATTERN.test(candidate)) {
      return candidate;
    }
  }
  return `http-${status}`;
}

export interface ApiFetchOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
}

/**
 * Fetch helper for the console HTTP API.
 * - always same-origin credentials
 * - injects x-ptl-csrf on non-GET requests when a CSRF token is known
 * - parses JSON bodies and throws ApiError with a stable code on failure
 */
export async function apiFetch<T = unknown>(
  path: string,
  options: ApiFetchOptions = {},
): Promise<T> {
  const method = (options.method ?? "GET").toUpperCase();
  const headers: Record<string, string> = {};
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  if (method !== "GET" && method !== "HEAD") {
    const csrfToken = sessionStore.get().csrfToken;
    if (csrfToken) {
      headers["x-ptl-csrf"] = csrfToken;
    }
  }

  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: "same-origin",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
  } catch {
    throw new ApiError("network-error", 0);
  }

  const text = await response.text();
  let data: unknown = null;
  if (text.length > 0) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!response.ok) {
    throw new ApiError(extractStableCode(data, response.status), response.status);
  }
  return data as T;
}
