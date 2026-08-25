/**
 * execution/network/extractors/offline-html.ts — 无网络确定性 HTML Extractor。
 *
 * 不发起任何二次网络请求；同一 artifact/hash/processor 产生相同 output hash。
 * V1 使用轻量正则/文本解析，不引入重型 HTML 引擎；解析结果只作为
 * `processed-untrusted` 内容返回。
 */

import { createHash } from "node:crypto";
import type {
  ExtractedDocumentV1,
  ExtractRequestV1,
  ExtractModeV1,
} from "@away_from/pth-contracts";
import type { ArtifactStore, StoredArtifact } from "../types.js";
import { createNetworkExecuteError } from "../errors.js";

export const OFFLINE_HTML_PROCESSOR_ID = "offline-html";
export const OFFLINE_HTML_PROCESSOR_VERSION = "1.0.0";

export interface OfflineHtmlExtractorOptions {
  readonly maxOutputChars?: number;
}

function decodeText(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function stripTags(input: string): string {
  return input
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function extractMeta(html: string, name: string): string | undefined {
  const patterns = [
    new RegExp(`<meta\\b[^>]*name=["']${name}["'][^>]*content=["']([^"']*)["']`, "i"),
    new RegExp(`<meta\\b[^>]*content=["']([^"']*)["'][^>]*name=["']${name}["']`, "i"),
    new RegExp(`<meta\\b[^>]*property=["']${name}["'][^>]*content=["']([^"']*)["']`, "i"),
    new RegExp(`<meta\\b[^>]*content=["']([^"']*)["'][^>]*property=["']${name}["']`, "i"),
  ];
  for (const re of patterns) {
    const m = re.exec(html);
    if (m?.[1]) return m[1].trim();
  }
  return undefined;
}

function extractLinks(html: string): { url: string; text?: string; relation?: string }[] {
  const out: { url: string; text?: string; relation?: string }[] = [];
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  for (const m of html.matchAll(re)) {
    const attrs = m[1] ?? "";
    const href = /href=["']([^"']+)["']/i.exec(attrs)?.[1];
    if (!href) continue;
    const rel = /rel=["']([^"']+)["']/i.exec(attrs)?.[1];
    const text = stripTags(m[2] ?? "").slice(0, 200);
    out.push({ url: href, ...(text ? { text } : {}), ...(rel ? { relation: rel } : {}) });
  }
  return out;
}

function extractSections(html: string): { headingPath: string[]; text: string }[] {
  const out: { headingPath: string[]; text: string }[] = [];
  const re = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  const matches = [...html.matchAll(re)];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]!;
    const level = Number(m[1]);
    const heading = stripTags(m[2] ?? "");
    const start = (m.index ?? 0) + m[0].length;
    const end = matches[i + 1]?.index ?? html.length;
    const body = html.slice(start, end);
    const text = stripTags(body);
    out.push({ headingPath: [heading], text });
  }
  return out;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(",")}}`;
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…[truncated]`;
}

export function createOfflineHtmlExtractor(opts: OfflineHtmlExtractorOptions = {}) {
  const maxOutputChars = opts.maxOutputChars ?? 50_000;

  async function extract(
    request: ExtractRequestV1,
    artifactStore: ArtifactStore,
  ): Promise<ExtractedDocumentV1> {
    const stored = await artifactStore.get(request.artifactRef);
    return extractFromStored(request, stored, maxOutputChars);
  }

  return { extract, extractFromStored };
}

export function extractFromStored(
  request: ExtractRequestV1,
  artifact: StoredArtifact,
  maxOutputChars = 50_000,
): ExtractedDocumentV1 {
  const html = decodeText(artifact.bytes);
  const mode: ExtractModeV1 = request.mode;
  const title = extractMeta(html, "og:title") ?? extractMeta(html, "twitter:title") ?? /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim();
  const canonicalUrl = extractMeta(html, "og:url") ?? extractMeta(html, "twitter:url") ?? /<link\b[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i.exec(html)?.[1];
  const author = extractMeta(html, "author") ?? extractMeta(html, "article:author");
  const publishedAt = extractMeta(html, "article:published_time") ?? extractMeta(html, "date");
  const language = /<html\b[^>]*lang=["']([^"']+)["']/i.exec(html)?.[1];

  const links = extractLinks(html);
  const sections = extractSections(html);

  let text: string | undefined;
  if (mode === "main-content") {
    const bodyMatch = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html);
    const body = bodyMatch?.[1] ?? html;
    text = stripTags(body);
  } else if (mode === "structured") {
    text = sections.map((s) => `${s.headingPath.join(" > ")}\n${s.text}`).join("\n\n");
  } else if (mode === "metadata") {
    text = [title, author, publishedAt, canonicalUrl].filter(Boolean).join("\n") || undefined;
  }

  if (text !== undefined && text.length > maxOutputChars) {
    text = truncateText(text, maxOutputChars);
  }

  const outputPayload = {
    title,
    canonicalUrl,
    author,
    publishedAt,
    language,
    text,
    sections: mode === "structured" ? sections : undefined,
    links: mode === "links" ? links : undefined,
  };
  const outputHash = createHash("sha256").update(stableStringify(outputPayload)).digest("hex");

  return {
    schemaVersion: "net.document/v1",
    sourceArtifact: artifact.ref,
    ...(title ? { title } : {}),
    ...(canonicalUrl ? { canonicalUrl } : {}),
    ...(author ? { author } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    ...(language ? { language } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(mode === "structured" ? { sections } : {}),
    ...(mode === "links" ? { links } : {}),
    processingChain: [
      {
        processorId: OFFLINE_HTML_PROCESSOR_ID,
        processorVersion: OFFLINE_HTML_PROCESSOR_VERSION,
        implementationLanguage: "ts",
        inputHash: artifact.ref.sha256,
        outputHash,
      },
    ],
    warnings: [],
    trust: "processed-untrusted",
  };
}

export function createOfflineHtmlExtractorService() {
  const extractor = createOfflineHtmlExtractor();
  return {
    extract: (request: ExtractRequestV1, artifactStore: ArtifactStore) => extractor.extract(request, artifactStore),
  };
}

export type OfflineHtmlExtractor = ReturnType<typeof createOfflineHtmlExtractor>;
