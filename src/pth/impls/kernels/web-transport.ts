/**
 * web-transport.ts — 受限只读 HTTP(S) 安全传输（N29 Task 4 抽取自 capability.ts）。
 *
 * 抽取动机：`web.fetchText` 与 Knowledge Intake 的 policy-bound fetch broker 必须共用
 * 同一条安全防线（协议白名单、字面量私网拒绝、DNS 全量校验 + 连接 pin、逐跳重定向
 * 复检、流式字节上限、超时 abort），但两者的输出面不同：
 *  - `web.fetchText()` 只需要文本（公共返回类型 `Promise<string>` 不变）；
 *  - fetch broker 需要 finalUri、redirect chain、status、headers 与 raw bytes 才能
 *    做 hash、admission 与可回放取证。
 *
 * 因此本模块只提供“安全传输 + 原始字节”，不做任何内容解释/策略判断：
 *  - `secureWebFetch()`：逐跳安全 GET，返回 raw bytes 与逐跳取证记录；
 *  - `readWebBodyBytes()` / `readWebBody()`：流式限量读取（超限立即 cancel 上游）；
 *  - `defaultWebLookup` / `defaultWebRequest`：默认 DNS 与 node http/https 传输。
 *
 * 本文件只依赖 node 内建模块（无 PTH 内部依赖），可被 kernel 能力层与 execution
 * application service 共同复用而不引入循环依赖。安全语义与抽取前逐条等价——
 * 默认错误前缀仍为 `web.fetchText:`，既有调用方的错误契约不变。
 */

import { promises as dnsPromises } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";

/** DNS 全量解析结果（H9 防护用——任一地址非公网即整体拒绝）。 */
export interface ResolvedAddress {
  address: string;
  family: number;
}

/** 可注入的 DNS 解析器（测试注入 / 未来出站策略协同点）。 */
export interface WebLookup {
  (hostname: string): Promise<ResolvedAddress[]>;
}

/** HTTP 响应抽象（默认走 node:http/https，测试可注入）。 */
export interface WebResponse {
  status: number;
  headers: { get(name: string): string | null };
  /** 流式 body——消费方按 chunk 读取；超限时调用 cancel 断开上游。 */
  body(): AsyncIterable<Uint8Array>;
  cancel?(): void;
}

/** 传输层注入点：url + 已受检地址 + 超时信号（+ 可选附加请求头）。 */
export interface WebRequest {
  (
    url: URL,
    init: {
      signal: AbortSignal;
      addresses: ResolvedAddress[];
      /** 附加请求头（条件请求 if-none-match / if-modified-since 等）。 */
      headers?: Readonly<Record<string, string>>;
    },
  ): Promise<WebResponse>;
}

/** 可注入的定时器（测试用假时钟；生产用 global）。 */
export interface WebTimerApi {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export type WebTransportErrorCode =
  | "protocol-not-allowed"
  | "private-address"
  | "dns-empty"
  | "too-large"
  | "too-many-redirects"
  | "unexpected-status";

/**
 * 传输层安全/协议拒绝的可判别错误（消息与抽取前逐字一致——既有 fetchText 错误契约不变）。
 */
export class WebTransportError extends Error {
  readonly code: WebTransportErrorCode;
  readonly status?: number;
  /** 触发拒绝的具体 URL（逐跳定位用；协议/状态类错误必带）。 */
  readonly url?: string;

  constructor(code: WebTransportErrorCode, message: string, detail: { status?: number; url?: string } = {}) {
    super(message);
    this.name = "WebTransportError";
    this.code = code;
    if (detail.status !== undefined) this.status = detail.status;
    if (detail.url !== undefined) this.url = detail.url;
  }
}

export const WEB_MAX_BYTES = 1024 * 1024;   // 1MB——官方文档页常超 256KB（go.dev/ref/spec ≈ 339KB）
export const WEB_TIMEOUT_MS = 30_000;
export const WEB_MAX_REDIRECTS = 5;

const DEFAULT_LABEL = "web.fetchText";
const DEFAULT_PROTOCOLS = ["http:", "https:"] as const;

/** 2026-08-15 筛查 H9：字面量层面 SSRF 防护——拒 localhost/私网/链路本地 IP 字面量。
 *  2026-08-16 S0-2：补 DNS rebinding 防护——解析与连接 pin 到同一份已受检地址
 *  （fetchText 先全量解析校验，传输层不再二次解析；重定向逐跳重复校验）。
 *  2026-08-19 N29 再验收 P1-1：覆盖 IPv6 multicast/link scope、IPv4-mapped 全展开形式、
 *  benchmark / documentation / reserved / future-use 范围，改用数值前缀匹配而非正则拼补。 */

/** IPv4 非公网判定（TEST-NET、benchmark、CGNAT、组播、保留段全部拒绝）。 */
function isNonPublicIpv4(a: number, b: number, c: number): boolean {
  if (a === 0 || a === 10 || a === 127) return true;                 // 本网络 / RFC1918 / loopback
  if (a === 100 && b >= 64 && b <= 127) return true;                 // 100.64.0.0/10 CGNAT
  if (a === 169 && b === 254) return true;                           // 169.254.0.0/16 link-local
  if (a === 172 && b >= 16 && b <= 31) return true;                  // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true;                           // 192.168.0.0/16 private
  if (a === 192 && b === 0 && c === 2) return true;                  // 192.0.2.0/24 TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true;              // 198.18.0.0/15 benchmark
  if (a === 198 && b === 51 && c === 100) return true;               // 198.51.100.0/24 TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true;                // 203.0.113.0/24 TEST-NET-3
  if (a >= 224) return true;                                         // 224.0.0.0/4 组播 + 240.0.0.0/4 保留
  return false;
}

/** 展开 IPv6 为 8 个 hextet；支持 `::` 压缩与尾部点分四段；非法返回 null。 */
function expandIpv6Hextets(input: string): number[] | null {
  let ip = input.toLowerCase();
  // 尾部点分四段 → 两个 hextet
  const quadMatch = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
  if (quadMatch) {
    const quad = quadMatch.slice(1).map(Number);
    if (quad.some((v) => v > 255)) return null;
    ip = `${ip.slice(0, quadMatch.index)}${((quad[0]! << 8) | quad[1]!).toString(16)}:${((quad[2]! << 8) | quad[3]!).toString(16)}`;
  }
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const seg of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(seg)) return null;
      out.push(parseInt(seg, 16));
    }
    return out;
  };
  const left = parse(halves[0]!);
  const right = halves.length === 2 ? parse(halves[1]!) : null;
  if (!left || right === undefined) return null;
  if (right === null) return left.length === 8 ? left : null;
  const missing = 8 - left.length - right.length;
  if (missing < 0) return null;
  return [...left, ...new Array<number>(missing).fill(0), ...right];
}

/** IPv6 非公网判定。 */
function isNonPublicIpv6(ip: string): boolean {
  const h = expandIpv6Hextets(ip);
  if (!h) return true;                                               // 无法判定 → 拒绝
  if (h.every((x) => x === 0)) return true;                          // ::
  if (h.slice(0, 7).every((x) => x === 0) && h[7] === 1) return true; // ::1 loopback
  // IPv4-mapped ::ffff:0:0/96（含点分与全展开两种记法）——按嵌入 IPv4 判定；
  // 映射前缀本身不是可路由公网地址，非公网一律拒绝，公网映射也按特殊用途拒绝（fail-closed）。
  if (h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff) return true;
  const first = h[0]!;
  if ((first & 0xfe00) === 0xfc00) return true;                      // fc00::/7 ULA
  if ((first & 0xffc0) === 0xfe80) return true;                      // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return true;                      // ff00::/8 multicast
  if (first === 0x2001 && h[1] === 0x0db8) return true;              // 2001:db8::/32 documentation
  return false;
}

export function isPrivateIpLiteral(ip: string): boolean {
  if (isIP(ip) === 4) {
    const p = ip.split(".").map(Number);
    const [a, b, c] = p as [number, number, number];
    return isNonPublicIpv4(a, b, c);
  }
  if (isIP(ip) === 6) return isNonPublicIpv6(ip);
  return true;   // 无法判定 → 拒绝
}

export function assertPublicLiteralHost(hostname: string, label = DEFAULT_LABEL): void {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) {
    throw new WebTransportError("private-address", `${label}: localhost 目标被拒（SSRF 防护）`);
  }
  if (isIP(host) && isPrivateIpLiteral(host)) {
    throw new WebTransportError("private-address", `${label}: 非公网 IP 目标被拒（SSRF 防护）: ${host}`);
  }
}

/** DoH 端点（仅作为系统 DNS 被 fake-ip/私网污染时的回退；结果仍经 SSRF 全量校验）。 */
const DEFAULT_DOH_ENDPOINTS = ["https://1.1.1.1/dns-query", "https://dns.google/resolve"] as const;

async function dohLookupOnce(hostname: string, endpoint: string, type: 1 | 28): Promise<ResolvedAddress[]> {
  const response = await fetch(`${endpoint}?name=${encodeURIComponent(hostname)}&type=${type}`, {
    headers: { accept: "application/dns-json" },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) return [];
  const data = (await response.json()) as { Answer?: Array<{ type: number; data: string }> };
  return (data.Answer ?? [])
    .filter((answer) => answer.type === type)
    .map((answer) => ({ address: answer.data, family: type === 1 ? 4 : 6 }));
}

/** 默认 DoH 回退解析：A + AAAA；所有端点失败返回空数组。 */
export const defaultDohLookup: WebLookup = async (hostname) => {
  for (const endpoint of DEFAULT_DOH_ENDPOINTS) {
    try {
      const settled = await Promise.allSettled([
        dohLookupOnce(hostname, endpoint, 1),
        dohLookupOnce(hostname, endpoint, 28),
      ]);
      const addresses = settled.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
      if (addresses.length > 0) return addresses;
    } catch {
      // 尝试下一个 DoH 端点
    }
  }
  return [];
};

/** 系统解析器：全量 A/AAAA 解析（verbatim 保留 IPv6 字面量）。 */
async function systemWebLookup(hostname: string): Promise<ResolvedAddress[]> {
  const resolved = await dnsPromises.lookup(hostname, { all: true, verbatim: true });
  return resolved.map((r) => ({ address: r.address, family: r.family }));
}

export interface WebLookupFallbackOptions {
  systemLookup?: WebLookup;
  dohLookup?: WebLookup;
}

/**
 * 默认解析器：先走系统 DNS；仅当系统 DNS 没有给出任何公网地址（例如本机 fake-ip
 * 代理把公网域名解析到 198.18.0.0/15 或 ULA）或解析失败时，回退到 DoH 获取真实公网
 * 地址。回退结果仍由调用方 resolvePublicAddresses 做完整 SSRF 校验，不放开私网。
 */
export function createWebLookupWithDohFallback(opts: WebLookupFallbackOptions = {}): WebLookup {
  const systemLookup = opts.systemLookup ?? systemWebLookup;
  const dohLookup = opts.dohLookup ?? defaultDohLookup;
  return async (hostname) => {
    let systemError: unknown;
    try {
      const addresses = await systemLookup(hostname);
      if (addresses.length > 0 && addresses.some((a) => !isPrivateIpLiteral(a.address))) {
        return addresses;
      }
    } catch (err) {
      systemError = err;
    }
    try {
      const addresses = await dohLookup(hostname);
      if (addresses.length > 0) return addresses;
    } catch {
      // DoH 失败时继续走下面的原始错误/空结果路径
    }
    if (systemError !== undefined) throw systemError;
    return [];
  };
}

export const defaultWebLookup: WebLookup = createWebLookupWithDohFallback();

/** DNS rebinding 防线：任一解析结果落在非公网段即整体拒绝（fail-closed）。 */
export function assertPublicResolvedAddresses(
  hostname: string,
  addresses: ResolvedAddress[],
  label = DEFAULT_LABEL,
): void {
  if (addresses.length === 0) {
    throw new WebTransportError("dns-empty", `${label}: DNS 无解析结果（拒绝）: ${hostname}`);
  }
  const bad = addresses.find((a) => isPrivateIpLiteral(a.address));
  if (bad) {
    throw new WebTransportError(
      "private-address",
      `${label}: DNS 解析到非公网地址被拒（SSRF 防护）: ${hostname} -> ${bad.address}`,
    );
  }
}

export async function resolvePublicAddresses(
  hostname: string,
  lookup: WebLookup,
  label = DEFAULT_LABEL,
): Promise<ResolvedAddress[]> {
  assertPublicLiteralHost(hostname, label);
  const addresses = await lookup(hostname);
  assertPublicResolvedAddresses(hostname, addresses, label);
  return addresses;
}

export function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/** 无 body 语义状态（304/204）——条件请求零成本路径不读 body。 */
function hasNoBody(status: number): boolean {
  return status === 304 || status === 204;
}

/** 默认传输：node http/https + pin 到调用方已校验的首个地址（不再触发第二次解析）。 */
export async function defaultWebRequest(
  url: URL,
  init: { signal: AbortSignal; addresses: ResolvedAddress[]; headers?: Readonly<Record<string, string>> },
): Promise<WebResponse> {
  const lib = url.protocol === "https:" ? https : http;
  const address = init.addresses[0]!;
  return new Promise((resolve, reject) => {
    let upstream: ReturnType<typeof lib.request> | null = null;
    const req = lib.request(
      {
        hostname: url.hostname.replace(/^\[|\]$/g, ""),
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: {
          accept: "text/html,text/plain,*/*",
          "user-agent": "pth-web-fetch/1.0",
          ...(init.headers ?? {}),
        },
        signal: init.signal,
        lookup: (_hostname, options, callback) => {
          // node http.request 以 all:true 调用 lookup——该分支必须回传地址数组（LookupAddress[]）
          if ((options as { all?: boolean }).all) {
            callback(null, [{ address: address.address, family: address.family || 4 }]);
          } else {
            callback(null, address.address, address.family || 4);
          }
        },
      },
      (res) => {
        upstream = req;
        const headers = res.headers;
        resolve({
          status: res.statusCode ?? 0,
          headers: {
            get: (name) => {
              const value = headers[name.toLowerCase()];
              return Array.isArray(value) ? value[0] ?? null : value ?? null;
            },
          },
          body: async function* () {
            for await (const chunk of res) {
              yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer);
            }
          },
          cancel: () => {
            res.destroy();
            upstream?.destroy();
          },
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** 流式限量读取原始字节：累计超 maxBytes 即 cancel 上游并抛错。 */
export async function readWebBodyBytes(
  res: WebResponse,
  maxBytes: number,
  label = DEFAULT_LABEL,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for await (const chunk of res.body()) {
      total += chunk.byteLength;
      if (total > maxBytes) {
        res.cancel?.();
        throw new WebTransportError("too-large", `${label}: response too large (${total} > ${maxBytes} bytes)`);
      }
      chunks.push(chunk);
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  } catch (err) {
    res.cancel?.();
    throw err;
  }
}

/** 流式限量读取文本（TextDecoder 解码——多字节字符跨 chunk 不裂）。 */
export async function readWebBody(res: WebResponse, maxBytes: number, label = DEFAULT_LABEL): Promise<string> {
  const bytes = await readWebBodyBytes(res, maxBytes, label);
  return new TextDecoder().decode(bytes);
}

/** 逐跳取证记录（fetch broker 用于 redirect chain 与地址回放）。 */
export interface SecureFetchHopRecord {
  readonly url: string;
  readonly origin: string;
  readonly status: number;
  readonly location?: string;
  readonly addresses: readonly ResolvedAddress[];
}

export interface SecureFetchHopContext {
  readonly url: URL;
  readonly hopIndex: number;
  /** 含本跳在内、按序累计的 hop origin（首跳 origin 在 index 0）。 */
  readonly origins: readonly string[];
  readonly previousUrl?: URL;
}

export interface SecureFetchOptions {
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  readonly maxRedirects?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly lookup?: WebLookup;
  readonly request?: WebRequest;
  readonly timers?: WebTimerApi;
  /** 协议白名单（缺省 http/https；intake 只允许 https）。 */
  readonly allowedProtocols?: readonly string[];
  /** 错误前缀（缺省 `web.fetchText`——既有调用方错误契约不变）。 */
  readonly label?: string;
  /** 外部取消信号（调用方自管超时预算时使用）。 */
  readonly signal?: AbortSignal;
  /** 逐跳授权钩子：每跳在 DNS 解析与建连之前调用；抛错即拒绝该跳。 */
  readonly authorizeHop?: (ctx: SecureFetchHopContext) => void | Promise<void>;
  /** 可接受的终态状态码（缺省仅 2xx）。 */
  readonly acceptStatus?: (status: number) => boolean;
}

export interface SecureFetchResult {
  readonly requestedUri: string;
  readonly finalUri: string;
  /** 实际请求过的 URL 序列（含首跳；末位 = finalUri）。 */
  readonly redirectChain: readonly string[];
  readonly status: number;
  /** 归一化小写响应头（单值）。 */
  readonly headers: Readonly<Record<string, string>>;
  readonly rawBytes: Uint8Array;
  readonly byteLength: number;
  readonly hops: readonly SecureFetchHopRecord[];
}

const CAPTURED_HEADERS = [
  "content-type",
  "etag",
  "last-modified",
  "location",
  "content-length",
  "content-digest",
  "digest",
  "cache-control",
] as const;

function captureHeaders(res: WebResponse): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of CAPTURED_HEADERS) {
    const value = res.headers.get(name);
    if (value !== null && value !== undefined) out[name] = value;
  }
  return out;
}

/**
 * 逐跳安全 GET：协议白名单 → 逐跳授权钩子 → 字面量/DNS 校验 → pin 地址建连 →
 * 重定向逐跳重复上述全部检查 → 流式限量读 raw bytes。
 *
 * 不解释内容、不做策略判断；raw bytes 原样返回给调用方 hash/归一化。
 */
export async function secureWebFetch(url: string, opts: SecureFetchOptions = {}): Promise<SecureFetchResult> {
  const label = opts.label ?? DEFAULT_LABEL;
  const maxBytes = opts.maxBytes ?? WEB_MAX_BYTES;
  const maxRedirects = opts.maxRedirects ?? WEB_MAX_REDIRECTS;
  const lookup = opts.lookup ?? defaultWebLookup;
  const request = opts.request ?? defaultWebRequest;
  const timers = opts.timers ?? { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as never) };
  const protocols = opts.allowedProtocols ?? DEFAULT_PROTOCOLS;
  const acceptStatus = opts.acceptStatus ?? ((status: number) => status >= 200 && status < 300);

  assertAllowedProtocol(url, protocols, label);

  const ctrl = new AbortController();
  const forwardAbort = (): void => ctrl.abort();
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort();
    else opts.signal.addEventListener("abort", forwardAbort, { once: true });
  }
  const timer = opts.timeoutMs === undefined ? null : timers.setTimeout(() => ctrl.abort(), opts.timeoutMs);
  try {
    let current = url;
    let previous: URL | undefined;
    const chain: string[] = [];
    const origins: string[] = [];
    const hops: SecureFetchHopRecord[] = [];

    for (let hop = 0; hop <= maxRedirects; hop++) {
      const target = new URL(current);
      assertAllowedProtocol(target.toString(), protocols, label);
      origins.push(target.origin);
      if (opts.authorizeHop) {
        await opts.authorizeHop({
          url: target,
          hopIndex: hop,
          origins: [...origins],
          ...(previous ? { previousUrl: previous } : {}),
        });
      }
      const addresses = await resolvePublicAddresses(target.hostname, lookup, label);
      const res = await request(target, {
        signal: ctrl.signal,
        addresses,
        ...(opts.headers ? { headers: opts.headers } : {}),
      });
      const headers = captureHeaders(res);
      chain.push(target.toString());
      const location = headers.location ?? null;
      hops.push({
        url: target.toString(),
        origin: target.origin,
        status: res.status,
        ...(location === null ? {} : { location }),
        addresses,
      });

      if (isRedirectStatus(res.status) && location !== null) {
        res.cancel?.();
        previous = target;
        current = new URL(location, target).toString();
        continue;
      }
      if (!acceptStatus(res.status)) {
        res.cancel?.();
        throw new WebTransportError("unexpected-status", `${label}: HTTP ${res.status} for ${target}`, {
          status: res.status,
          url: target.toString(),
        });
      }
      const rawBytes = hasNoBody(res.status) ? new Uint8Array(0) : await readWebBodyBytes(res, maxBytes, label);
      if (hasNoBody(res.status)) res.cancel?.();
      return Object.freeze({
        requestedUri: url,
        finalUri: target.toString(),
        redirectChain: Object.freeze([...chain]),
        status: res.status,
        headers: Object.freeze(headers),
        rawBytes,
        byteLength: rawBytes.byteLength,
        hops: Object.freeze([...hops]),
      });
    }
    throw new WebTransportError("too-many-redirects", `${label}: too many redirects (max ${maxRedirects})`);
  } finally {
    if (timer !== null) timers.clearTimeout(timer);
    opts.signal?.removeEventListener("abort", forwardAbort);
  }
}

function assertAllowedProtocol(url: string, protocols: readonly string[], label: string): void {
  const pattern = protocols.map((p) => p.replace(":", "")).join("|");
  if (!new RegExp(`^(?:${pattern}):\\/\\/`, "i").test(url)) {
    const allowed = protocols.length === 1 ? protocols[0]!.replace(":", "") : "http(s)";
    throw new WebTransportError(
      "protocol-not-allowed",
      `${label}: only ${allowed} URLs allowed (got: ${url.slice(0, 50)})`,
      { url },
    );
  }
}
