/**
 * pth-client.js — N30 Task 4 PTH 只读观测客户端（server-to-server）。
 *
 * 安全边界（plan Task 4 Step 3 / design §8.1）：
 *  - token / endpoint 只存在于本模块闭包与出站请求头中；
 *  - 绝不下发浏览器、不进入 emitted data、不出现在日志或 JSON 序列化；
 *  - 不跟随 HTTP 重定向（fetch redirect:"error" + 3xx/redirected 二次拒绝）；
 *  - 只调用 GET/HEAD 只读路径，绝不调用 PTH 写路由。
 *
 * 行为：
 *  - 每 5 秒轮询 durable timeline snapshot（authoritative reconcile 基线）；
 *  - 事件流断开时按有界指数退避重连（base 500ms，cap 30s）；
 *  - 所有计时/退避均可注入 clock，便于确定性测试。
 */

const DEFAULT_RECONCILE_MS = 5000;
const DEFAULT_WINDOW_MS = 3_600_000;
const DEFAULT_LIMIT = 500;
const DEFAULT_TIMELINE_PATH = "/api/v1/observe/timeline";
const DEFAULT_EVENTS_PATH = "/api/v1/observe/runtime/events";
const DEFAULT_BACKOFF_BASE_MS = 500;
const DEFAULT_BACKOFF_MAX_MS = 30_000;

export function nextBackoffMs(attempt, { baseMs = DEFAULT_BACKOFF_BASE_MS, maxMs = DEFAULT_BACKOFF_MAX_MS } = {}) {
  const n = Math.max(0, Math.floor(attempt));
  const exp = Math.min(n, 6); // 2^6 = 64；超过后保持 64×base，仍受 maxMs 封顶。
  return Math.min(maxMs, baseMs * 2 ** exp);
}

function isRecord(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asError(err) {
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * @param {object} [options]
 * @param {string} [options.endpoint] PTH 基地址（如 http://127.0.0.1:4000）
 * @param {string} [options.token] 只读 runtime-observer token；仅服务端持有
 * @param {() => number} [options.clock]
 * @param {typeof globalThis.fetch} [options.fetchImpl]
 * @param {string} [options.timelinePath]
 * @param {string} [options.eventsPath]
 * @param {number} [options.reconcileMs]
 * @param {number} [options.windowMs]
 * @param {number} [options.limit]
 * @param {number} [options.backoffBaseMs]
 * @param {number} [options.backoffMaxMs]
 * @param {(snapshot: Record<string, unknown>) => void} [options.onSnapshot]
 * @param {(delta: Record<string, unknown>) => void} [options.onDelta]
 * @param {(source: "pth-timeline" | "pth-events", error: Error) => void} [options.onError]
 */
export function createPthClient({
  endpoint,
  token,
  clock = () => Date.now(),
  fetchImpl = globalThis.fetch,
  timelinePath = DEFAULT_TIMELINE_PATH,
  eventsPath = DEFAULT_EVENTS_PATH,
  reconcileMs = DEFAULT_RECONCILE_MS,
  windowMs = DEFAULT_WINDOW_MS,
  limit = DEFAULT_LIMIT,
  backoffBaseMs = DEFAULT_BACKOFF_BASE_MS,
  backoffMaxMs = DEFAULT_BACKOFF_MAX_MS,
  onSnapshot,
  onDelta,
  onError,
} = {}) {
  if (!endpoint || typeof endpoint !== "string") {
    throw new TypeError("createPthClient: endpoint must be a non-empty string");
  }
  if (!token || typeof token !== "string") {
    throw new TypeError("createPthClient: token must be a non-empty string (server-side only)");
  }
  if (typeof fetchImpl !== "function") {
    throw new TypeError("createPthClient: fetchImpl must be a function");
  }

  const baseUrl = endpoint.replace(/\/+$/, "");
  const timelineUrl = `${baseUrl}${timelinePath}`;
  const eventsUrl = `${baseUrl}${eventsPath}`;
  const authHeaders = { authorization: `Bearer ${token}` };

  let stopped = false;
  let pollStarted = false;
  let pollTimer = null;
  let pollInFlight = null;
  let lastSnapshot = null;
  let lastPollError = null;

  let eventAbort = null;
  let reconnectTimer = null;
  let connectPromise = null;
  let consecutiveDisconnects = 0;
  let lastEventDelta = null;

  function checkRedirect(res) {
    if (res.redirected) {
      throw new Error("pth-client: redirect not allowed");
    }
    if (res.status >= 300 && res.status < 400) {
      throw new Error(`pth-client: redirect not allowed (HTTP ${res.status})`);
    }
  }

  async function pollOnce() {
    try {
      const now = clock();
      const from = now - windowMs;
      const url = new URL(timelineUrl);
      url.searchParams.set("from", String(from));
      url.searchParams.set("to", String(now));
      url.searchParams.set("limit", String(limit));

      const res = await fetchImpl(url.toString(), {
        method: "GET",
        headers: { ...authHeaders, accept: "application/json" },
        redirect: "error",
      });
      checkRedirect(res);
      if (!res.ok) {
        lastPollError = new Error(`pth-client: timeline ${res.status}`);
        throw lastPollError;
      }
      const snapshot = await res.json();
      if (!isRecord(snapshot) || !Array.isArray(snapshot.intervals)) {
        lastPollError = new Error("pth-client: timeline snapshot must include intervals[]");
        throw lastPollError;
      }
      lastSnapshot = snapshot;
      lastPollError = null;
      onSnapshot?.(snapshot);
      return snapshot;
    } catch (err) {
      lastPollError = asError(err);
      onError?.("pth-timeline", asError(err));
      throw lastPollError;
    }
  }

  function start() {
    if (pollStarted) return;
    stopped = false;
    pollStarted = true;
    pollInFlight = void pollOnce();
    pollTimer = setInterval(() => {
      if (!stopped) pollInFlight = void pollOnce();
    }, reconcileMs);
    pollTimer.unref?.();
  }

  function stop() {
    stopped = true;
    pollStarted = false;
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    eventAbort?.abort();
    eventAbort = null;
  }

  function parseSseBlock(block) {
    const ev = {};
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) ev.event = line.slice(6).trim();
      else if (line.startsWith("data:")) ev.data = line.slice(5).trim();
      else if (line.startsWith("id:")) ev.id = line.slice(3).trim();
    }
    return ev;
  }

  function emitSseBlock(block) {
    const ev = parseSseBlock(block);
    if (!ev.data) return;
    let parsed = null;
    try {
      parsed = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (!isRecord(parsed)) return;
    const delta = { ...parsed, ...(ev.event ? { type: ev.event } : {}) };
    lastEventDelta = delta;
    onDelta?.(delta);
  }

  function scheduleReconnect() {
    if (stopped) return;
    const delay = nextBackoffMs(consecutiveDisconnects, { baseMs: backoffBaseMs, maxMs: backoffMaxMs });
    consecutiveDisconnects += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!stopped) connectPromise = void connectEvents();
    }, delay);
    reconnectTimer.unref?.();
  }

  async function connectEvents() {
    eventAbort?.abort();
    eventAbort = new AbortController();

    try {
      const res = await fetchImpl(eventsUrl, {
        method: "GET",
        headers: { ...authHeaders, accept: "text/event-stream" },
        redirect: "error",
        signal: eventAbort.signal,
      });
      checkRedirect(res);
      if (!res.ok) {
        throw new Error(`pth-client: events ${res.status}`);
      }
      const contentType = res.headers.get("content-type") ?? "";
      if (!contentType.includes("text/event-stream")) {
        throw new Error("pth-client: events endpoint is not text/event-stream");
      }
      if (!res.body || typeof res.body.getReader !== "function") {
        throw new Error("pth-client: events stream has no readable body");
      }

      // 连接建立即重置退避计数；只有连续断开才指数增长。
      consecutiveDisconnects = 0;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (!stopped) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          emitSseBlock(block);
        }
      }
      if (!stopped) scheduleReconnect();
    } catch (err) {
      if (stopped || (err instanceof Error && err.name === "AbortError")) return;
      onError?.("pth-events", asError(err));
      if (!stopped) scheduleReconnect();
    }
  }

  return {
    /** 立即轮询一次 durable timeline snapshot（authoritative）。 */
    pollOnce,

    /** 启动 5 秒轮询（会立即先 poll 一次）。 */
    start,

    /** 停止轮询与事件流重连；不向浏览器暴露任何凭据。 */
    stop,

    /** 打开 PTH 事件流；断连后按有界退避自动重连。 */
    connectEvents,

    /** 最近一次成功的 durable snapshot（浏览器可读，内容绝不含 token）。 */
    getLastSnapshot() {
      return lastSnapshot ? { ...lastSnapshot } : null;
    },

    /** 最近一次成功解析的事件 delta（同样不含凭据）。 */
    getLastEventDelta() {
      return lastEventDelta ? { ...lastEventDelta } : null;
    },

    /** 最近一次 poll 错误（不含 token / URL）。 */
    getLastPollError() {
      return lastPollError ? asError(lastPollError).message : null;
    },
  };
}
