/**
 * execution/network/providers/raw-hit-html.ts — raw-hit SearchProvider adapter。
 *
 * V1 接一个无需 API key 的公开 HTML 搜索端点（默认 DuckDuckGo HTML），
 * 解析原始 URL/title/snippet 为 `net.search.response/v1` 的 raw hits。
 * 真实 egress 走 SafeHttpTransport；测试可注入 fetchHtml 避免网络依赖。
 */

import type {
  NetworkOperationContextV1,
  SearchHitV1,
  SearchRequestV1,
} from "@away_from/pth-contracts";
import { secureWebFetch } from "../safe-http-transport.js";
import type { ProviderSearchOutcome, SearchProvider } from "../types.js";
import { NetworkProviderError } from "../types.js";
import { redactSensitiveInput } from "../redaction.js";

export interface RawHitHtmlProviderOptions {
  readonly providerId?: string;
  readonly implementationId?: string;
  readonly version?: string;
  readonly endpoint?: string;
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  /** 测试注入；缺省走 secureWebFetch。 */
  readonly fetchHtml?: (url: string) => Promise<string>;
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#x27;/gi, "'")
    .replace(/&#39;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .trim();
}

function stripTags(input: string): string {
  return decodeHtmlEntities(input.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function normalizeResultUrl(href: string, base: URL): string {
  try {
    if (href.startsWith("//")) return new URL(`https:${href}`).toString();
    const url = new URL(href, base);
    if (url.hostname === "duckduckgo.com" && url.pathname.startsWith("/l/")) {
      const target = url.searchParams.get("uddg");
      if (target) return new URL(target).toString();
    }
    return url.toString();
  } catch {
    return href;
  }
}

interface ParsedRawHit {
  readonly url: string;
  readonly title: string;
  readonly snippet?: string;
}

function parseRawHits(html: string, base: URL): ParsedRawHit[] {
  const hits: ParsedRawHit[] = [];
  const anchorRe = /<a\b([^>]*class=["'][^"']*result__a[^"']*["'][^>]*)>([\s\S]*?)<\/a>/gi;
  for (const m of html.matchAll(anchorRe)) {
    const attrs = m[1] ?? "";
    const href = /href=["']([^"']+)["']/i.exec(attrs)?.[1];
    if (!href) continue;
    const title = stripTags(m[2] ?? "");
    if (!title) continue;
    hits.push({ url: normalizeResultUrl(href, base), title });
  }
  const snippetRe = /<a\b([^>]*class=["'][^"']*result__snippet[^"']*["'][^>]*)>([\s\S]*?)<\/a>/gi;
  const snippets: string[] = [];
  for (const m of html.matchAll(snippetRe)) {
    snippets.push(stripTags(m[2] ?? ""));
  }
  return hits.map((hit, i) => ({ ...hit, ...(snippets[i] ? { snippet: snippets[i] } : {}) }));
}

export class RawHitHtmlProvider implements SearchProvider {
  readonly providerId: string;
  readonly implementationId: string;
  readonly version: string;
  readonly supportedProfiles = ["search-public"] as const;
  readonly capabilities = { rawHits: true, cursor: false } as const;

  private readonly endpoint: string;
  private readonly maxBytes: number;
  private readonly timeoutMs: number;
  private readonly fetchHtml: (url: string) => Promise<string>;

  constructor(opts: RawHitHtmlProviderOptions = {}) {
    this.providerId = opts.providerId ?? "duckduckgo-html";
    this.implementationId = opts.implementationId ?? "net.search.raw-hit-html-v1";
    this.version = opts.version ?? "1.0.0";
    this.endpoint = opts.endpoint ?? "https://html.duckduckgo.com/html/";
    this.maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.fetchHtml = opts.fetchHtml ?? (async (url) => {
      const result = await secureWebFetch(url, {
        allowedProtocols: ["https:"],
        maxBytes: this.maxBytes,
        timeoutMs: this.timeoutMs,
        label: `net.search.provider.${this.providerId}`,
        acceptStatus: (status) => status === 200,
      });
      return new TextDecoder().decode(result.rawBytes);
    });
  }

  async search(request: SearchRequestV1, ctx: NetworkOperationContextV1): Promise<ProviderSearchOutcome> {
    const startedAt = new Date().toISOString();
    const startMs = Date.now();
    try {
      const url = new URL(this.endpoint);
      url.searchParams.set("q", request.query);
      if (request.language) url.searchParams.set("kl", request.language);
      const html = await this.fetchHtml(url.toString());
      const hits = parseRawHits(html, url).slice(0, request.limit ?? 10);
      const durationMs = Date.now() - startMs;
      const typedHits: SearchHitV1[] = hits.map((hit, index) => {
        let origin = "unknown";
        try {
          origin = new URL(hit.url).hostname;
        } catch {
          // 保留 unknown
        }
        return {
          rank: index + 1,
          title: hit.title,
          url: hit.url,
          ...(hit.snippet ? { snippet: hit.snippet } : {}),
          discovery: {
            providerId: this.providerId,
            providerVersion: this.version,
            retrievedAt: startedAt,
          },
          publisher: { origin },
          trust: "public-untrusted",
        };
      });
      return {
        hits: typedHits,
        attempt: {
          providerId: this.providerId,
          implementationId: this.implementationId,
          startedAt,
          durationMs,
          status: typedHits.length > 0 ? "ok" : "empty",
          resultCount: typedHits.length,
        },
      };
    } catch (err) {
      const durationMs = Date.now() - startMs;
      if (err instanceof NetworkProviderError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new NetworkProviderError("NET_PROVIDER_UNAVAILABLE", `${this.providerId}: ${redactSensitiveInput(message)}`);
    }
  }
}

export function createRawHitHtmlProvider(opts: RawHitHtmlProviderOptions = {}): SearchProvider {
  return new RawHitHtmlProvider(opts);
}
