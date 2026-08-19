/**
 * test/pth-knowledge-intake/fetch-broker.test.ts — N29 Task 4 红测（先红后绿）。
 *
 * 覆盖计划 §5 Task 4 Step 1 清单：
 *  - exact origin/path（policy 精确 origin + pathPrefix）
 *  - 每跳 redirect 重新授权 + redirect chain 记录 + 越权 origin 拒绝
 *  - HTTP（非 TLS）拒绝（首跳与 redirect 跳）
 *  - private/loopback/link-local/unspecified DNS 目标拒绝（复用现有 web transport 防线）
 *  - 超字节（policy maxBytes）拒绝且不消费预算外字节
 *  - timeout（注入 timer）生效
 *  - ETag 304 / Last-Modified 条件请求 envelope（零成本、server-furnished hash）
 *  - raw hash 稳定、HTML normalized representation 确定
 *  - 未知 content type → envelope 仍返回 raw，但 admission 拒绝 use（quarantine 保留）
 *  - fetch 后、use 前策略轮换/撤销 → admission 拒绝
 *  - 生产 transport（defaultWebRequest）经真实本地 HTTPS server 走通一次
 */
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign as edSign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import https from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  authorizeUse,
  canonicalPolicySigningBytes,
  computePolicyDigest,
  createPolicyBoundSourceFetchBroker,
  decideSourceAdmission,
  loadVerifiedTrustPolicy,
  normalizeSourceText,
  SourceFetchDeniedError,
  type PolicyBoundSourceAcquisitionEnvelope,
  type SourceAdmissionInput,
} from "../../src/pth/execution/knowledge-intake/index.js";
import {
  defaultWebRequest,
  type ResolvedAddress,
  type WebResponse,
} from "../../src/pth/impls/kernels/web-transport.js";
import type {
  FetchPolicyDecision,
  HumanPrincipalRef,
  SourceAcquisitionEnvelope,
  TrustPolicyManifest,
  TrustPolicyRule,
  UseAuthorizationInput,
  VerifiedTrustPolicy,
} from "../../src/pth/contracts/index.js";

// ─── 固定时钟与哈希工具 ──────────────────────────────────────────────

const NOW = new Date("2026-08-20T00:00:00.000Z");
const CLOCK = { now: () => NOW };
const HEX64 = /^[0-9a-f]{64}$/;

const sha256Hex = (data: string | Uint8Array): string =>
  createHash("sha256").update(data instanceof Uint8Array ? Buffer.from(data) : Buffer.from(data, "utf8")).digest("hex");

const PUBLIC_ADDR: ResolvedAddress[] = [{ address: "93.184.216.34", family: 4 }];

// ─── 人类签名 policy 装配（复用 L2 生产验签路径，不 mock） ────────────

const DOCS_ORIGIN = "https://docs.example.org";
const CDN_ORIGIN = "https://cdn.example.org";
const OTHER_ORIGIN = "https://other.example.org";

function rule(overrides: Partial<TrustPolicyRule> = {}): TrustPolicyRule {
  return {
    ruleId: "rule-docs",
    effect: "allow",
    httpsOrigin: DOCS_ORIGIN,
    pathPrefix: "/guide/",
    spaces: ["space-a"],
    domains: ["docs.example.org"],
    sourceTypes: ["bounded-html"],
    contentTypes: ["text/html"],
    licenses: ["public-domain"],
    maxBytes: 4096,
    redirectOrigins: [DOCS_ORIGIN, CDN_ORIGIN],
    ...overrides,
  };
}

function baseManifest(overrides: Partial<TrustPolicyManifest> = {}): TrustPolicyManifest {
  const approvedBy: HumanPrincipalRef = {
    kind: "human",
    principalId: "human-alice",
    tenantId: "tenant-a",
    issuer: "ptl-human-interface",
  };
  return {
    policyId: "policy-l4-intake",
    version: "1",
    tenantId: "tenant-a",
    spaces: ["space-a"],
    validFrom: "2026-08-01T00:00:00.000Z",
    validUntil: "2099-08-01T00:00:00.000Z",
    approvedBy,
    approvalProof: { method: "signed-manifest", keyId: "human-alice", signature: "" },
    rules: [
      rule(),
      // 同 redirectOrigins 集合的 cdn 规则：授权跨 origin 跳转的第二跳
      rule({ ruleId: "rule-cdn", httpsOrigin: CDN_ORIGIN, domains: ["cdn.example.org"] }),
      // other 规则自身允许，但不在 rule-docs.redirectOrigins 中 → 越权 redirect（escape）
      rule({ ruleId: "rule-other", httpsOrigin: OTHER_ORIGIN, domains: ["other.example.org"], redirectOrigins: [DOCS_ORIGIN, OTHER_ORIGIN] }),
    ],
    digest: "",
    ...overrides,
  };
}

function signManifest(manifest: TrustPolicyManifest, privateKeyPem: string): TrustPolicyManifest {
  const digest = computePolicyDigest(manifest);
  const signature = edSign(null, canonicalPolicySigningBytes(manifest), privateKeyPem).toString("base64");
  return { ...manifest, digest, approvalProof: { ...manifest.approvalProof, signature } };
}

async function verifiedPolicy(
  overrides: Partial<TrustPolicyManifest> = {},
  clock: { now(): Date } = CLOCK,
): Promise<VerifiedTrustPolicy> {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const keyring = { "human-alice": publicKey.export({ type: "spki", format: "pem" }).toString() };
  const manifest = signManifest(baseManifest(overrides), privateKey.export({ type: "pkcs8", format: "pem" }).toString());
  return await loadVerifiedTrustPolicy(manifest, keyring, clock);
}

const DECLARED = { sourceType: "bounded-html", contentType: "text/html", license: "public-domain" } as const;

function allowDecision(policy: VerifiedTrustPolicy, url = `${DOCS_ORIGIN}/guide/intro`): FetchPolicyDecision {
  return policy.authorizeFetch({
    tenantId: "tenant-a",
    space: "space-a",
    url,
    redirectOrigins: [DOCS_ORIGIN],
    ...DECLARED,
    byteLength: 0,
  });
}

// ─── 可控传输（注入；不替换任何策略/验签逻辑） ────────────────────────

interface FakeResponse extends WebResponse {
  status: number;
  headers: { get(name: string): string | null };
  body(): AsyncIterable<Uint8Array>;
  cancel?(): void;
}

function fakeResponse(
  body: string | Uint8Array | Uint8Array[],
  status = 200,
  headers: Record<string, string> = {},
): FakeResponse {
  const chunks = typeof body === "string"
    ? [new TextEncoder().encode(body)]
    : body instanceof Uint8Array ? [body] : body;
  return {
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    body: async function* () {
      for (const chunk of chunks) yield chunk;
    },
  };
}

interface RequestCall {
  url: string;
  addresses: readonly ResolvedAddress[];
  headers: Readonly<Record<string, string>>;
}

function recordingTransport(responses: FakeResponse[]) {
  const calls: RequestCall[] = [];
  const request = async (
    url: URL,
    init: { signal: AbortSignal; addresses: ResolvedAddress[]; headers?: Readonly<Record<string, string>> },
  ): Promise<WebResponse> => {
    calls.push({ url: url.toString(), addresses: init.addresses, headers: init.headers ?? {} });
    const next = responses.shift();
    if (!next) throw new Error(`no fake response left for ${url.toString()}`);
    return next;
  };
  return { calls, request };
}

interface HarnessOptions {
  responses?: FakeResponse[];
  lookup?: (hostname: string) => Promise<ResolvedAddress[]>;
  manifest?: Partial<TrustPolicyManifest>;
  timeoutMs?: number;
  maxRedirects?: number;
  timers?: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void };
}

async function harness(opts: HarnessOptions = {}) {
  const policy = await verifiedPolicy(opts.manifest ?? {});
  const lookups: string[] = [];
  const { calls, request } = recordingTransport(opts.responses ?? []);
  const broker = createPolicyBoundSourceFetchBroker({
    policy,
    declaredSource: DECLARED,
    lookup: async (hostname) => {
      lookups.push(hostname);
      return opts.lookup ? await opts.lookup(hostname) : PUBLIC_ADDR;
    },
    request,
    clock: CLOCK,
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    ...(opts.maxRedirects === undefined ? {} : { maxRedirects: opts.maxRedirects }),
    ...(opts.timers === undefined ? {} : { timers: opts.timers }),
  });
  return { policy, broker, calls, lookups };
}

function acquireInput(policy: VerifiedTrustPolicy, extra: Record<string, unknown> = {}) {
  return {
    tenantId: "tenant-a",
    space: "space-a",
    subscriptionId: "sub-1",
    requestedUri: `${DOCS_ORIGIN}/guide/intro`,
    // 入口决策固定取自「合法 URI」：broker 不得因为持有一张 allow 票据就放行别的 URI，
    // 必须对实际要抓的每一跳重新调用 authorizeFetch。
    fetchPolicyDecision: allowDecision(policy, String(extra.decisionUrl ?? `${DOCS_ORIGIN}/guide/intro`)),
    ...extra,
  };
}

async function captureDeny(p: Promise<unknown>): Promise<SourceFetchDeniedError> {
  try {
    await p;
  } catch (error) {
    if (error instanceof SourceFetchDeniedError) return error;
    throw error;
  }
  throw new Error("expected SourceFetchDeniedError but acquire resolved");
}

const HTML = "<html><head><title>T</title><style>b{}</style></head><body><h1>Cats</h1><p>Rain &amp; sun&#39;s day&nbsp;end</p><script>x()</script></body></html>";

// ─── §1 acquisition：exact origin/path 与 envelope 形状 ───────────────

describe("N29 Task 4: policy-bound artifact fetch", () => {
  it("授权 origin/path 抓取产出与 contracts 兼容的 acquisition envelope", async () => {
    const { policy, broker, calls, lookups } = await harness({
      responses: [fakeResponse(HTML, 200, {
        "content-type": "text/html; charset=utf-8",
        etag: 'W/"v1"',
        "last-modified": "Tue, 19 Aug 2026 00:00:00 GMT",
      })],
    });
    const envelope = await broker.acquire(acquireInput(policy));

    // 结构上必须能当 SourceAcquisitionEnvelope 用（契约桶兼容）
    const asContract: SourceAcquisitionEnvelope = envelope;
    expect(asContract.requestedUri).toBe(`${DOCS_ORIGIN}/guide/intro`);
    expect(envelope.finalUri).toBe(`${DOCS_ORIGIN}/guide/intro`);
    expect(envelope.redirectChain).toEqual([`${DOCS_ORIGIN}/guide/intro`]);
    expect(envelope.status).toBe(200);
    expect(envelope.headers.contentType).toBe("text/html");
    expect(envelope.headers.etag).toBe('W/"v1"');
    expect(envelope.headers.lastModified).toBe("Tue, 19 Aug 2026 00:00:00 GMT");
    expect(envelope.rawBytes).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(envelope.rawBytes).toString("utf8")).toBe(HTML);
    expect(envelope.byteLength).toBe(Buffer.byteLength(HTML));
    expect(envelope.rawHash).toBe(sha256Hex(HTML));
    expect(envelope.rawHash).toMatch(HEX64);
    expect(envelope.normalizedTextHash).toBe(sha256Hex(envelope.normalizedText));
    expect(envelope.normalizedText).toContain("Cats");
    expect(envelope.normalizedText).not.toContain("<");
    expect(envelope.notModified).toBe(false);
    expect(envelope.contentTypeApproved).toBe(true);
    expect(envelope.normalization).toBe("normalized-text");
    expect(envelope.policyDecisionRef).toMatchObject({
      policyId: "policy-l4-intake",
      ruleId: "rule-docs",
      decision: "allow",
    });
    expect(envelope.hopDecisions.map((d) => d.ruleId)).toEqual(["rule-docs"]);
    expect(calls).toHaveLength(1);
    expect(lookups).toEqual(["docs.example.org"]);
  });

  it("raw bytes 不可变：envelope 冻结且外部修改不影响 hash 真相", async () => {
    const { policy, broker } = await harness({
      responses: [fakeResponse(HTML, 200, { "content-type": "text/html" })],
    });
    const envelope = await broker.acquire(acquireInput(policy));
    expect(Object.isFrozen(envelope)).toBe(true);
    expect(() => {
      (envelope as { rawHash: string }).rawHash = "tampered";
    }).toThrow();
    expect(envelope.rawHash).toBe(sha256Hex(HTML));
  });

  it("path 越出 pathPrefix → 拒绝且零请求", async () => {
    const { policy, broker, calls, lookups } = await harness({ responses: [] });
    const denied = await captureDeny(broker.acquire(acquireInput(policy, {
      requestedUri: `${DOCS_ORIGIN}/secret/intro`,
    })));
    expect(denied.code).toBe("policy-denied");
    expect(calls).toHaveLength(0);
    expect(lookups).toHaveLength(0);
  });

  it("未授权 origin → 拒绝且零请求", async () => {
    const { policy, broker, calls } = await harness({ responses: [] });
    const denied = await captureDeny(broker.acquire(acquireInput(policy, {
      requestedUri: "https://evil.example/guide/intro",
    })));
    expect(denied.code).toBe("policy-denied");
    expect(calls).toHaveLength(0);
  });

  it("非 allow 的 fetch decision（deny/policy 不一致）直接 fail closed", async () => {
    const { policy, broker, calls } = await harness({ responses: [] });
    const denyDecision: FetchPolicyDecision = { ...allowDecision(policy), decision: "deny", reason: "forced" };
    const d1 = await captureDeny(broker.acquire(acquireInput(policy, { fetchPolicyDecision: denyDecision })));
    expect(d1.code).toBe("fetch-decision-not-allow");

    const rotated: FetchPolicyDecision = { ...allowDecision(policy), policyDigest: sha256Hex("other-policy") };
    const d2 = await captureDeny(broker.acquire(acquireInput(policy, { fetchPolicyDecision: rotated })));
    expect(d2.code).toBe("policy-mismatch");
    expect(calls).toHaveLength(0);
  });

  // ─── §2 TLS-only ────────────────────────────────────────────────────

  it("HTTP（非 TLS）首跳拒绝且零请求/零解析", async () => {
    const { policy, broker, calls, lookups } = await harness({ responses: [] });
    const denied = await captureDeny(broker.acquire(acquireInput(policy, {
      requestedUri: "http://docs.example.org/guide/intro",
    })));
    expect(denied.code).toBe("not-https");
    expect(calls).toHaveLength(0);
    expect(lookups).toHaveLength(0);
  });

  it("redirect 到 HTTP（非 TLS）在该跳拒绝", async () => {
    const { policy, broker, calls } = await harness({
      responses: [fakeResponse("", 302, { location: "http://docs.example.org/guide/plain" })],
    });
    const denied = await captureDeny(broker.acquire(acquireInput(policy)));
    expect(denied.code).toBe("not-https");
    expect(denied.hopUrl).toBe("http://docs.example.org/guide/plain");
    expect(calls).toHaveLength(1);
  });

  // ─── §3 逐跳 redirect 重新授权 ───────────────────────────────────────

  it("每跳重新授权：授权 redirect origin 通过并记录 redirect chain", async () => {
    const { policy, broker, calls, lookups } = await harness({
      responses: [
        fakeResponse("", 302, { location: `${CDN_ORIGIN}/guide/intro-v2` }),
        fakeResponse(HTML, 200, { "content-type": "text/html" }),
      ],
    });
    const envelope = await broker.acquire(acquireInput(policy));
    expect(envelope.redirectChain).toEqual([
      `${DOCS_ORIGIN}/guide/intro`,
      `${CDN_ORIGIN}/guide/intro-v2`,
    ]);
    expect(envelope.finalUri).toBe(`${CDN_ORIGIN}/guide/intro-v2`);
    expect(envelope.hopDecisions).toHaveLength(2);
    expect(envelope.hopDecisions.map((d) => d.ruleId)).toEqual(["rule-docs", "rule-cdn"]);
    expect(envelope.hopDecisions.every((d) => d.decision === "allow")).toBe(true);
    expect(envelope.hops.map((h) => h.status)).toEqual([302, 200]);
    // 逐跳重新解析（DNS rebinding 防线保持）
    expect(lookups).toEqual(["docs.example.org", "cdn.example.org"]);
    expect(calls.map((c) => c.url)).toEqual([
      `${DOCS_ORIGIN}/guide/intro`,
      `${CDN_ORIGIN}/guide/intro-v2`,
    ]);
  });

  it("redirect 到策略外 origin → 拒绝（不再发第二跳）", async () => {
    const { policy, broker, calls } = await harness({
      responses: [fakeResponse("", 302, { location: "https://evil.example/guide/x" })],
    });
    const denied = await captureDeny(broker.acquire(acquireInput(policy)));
    expect(denied.code).toBe("redirect-origin-not-authorized");
    expect(denied.hopUrl).toBe("https://evil.example/guide/x");
    expect(calls).toHaveLength(1);
  });

  it("redirect 逃逸到「自身有规则但不在入口规则 redirectOrigins」的 origin → 拒绝", async () => {
    const { policy, broker, calls } = await harness({
      responses: [fakeResponse("", 302, { location: `${OTHER_ORIGIN}/guide/x` })],
    });
    // other 规则自身 allow（origin+path+redirectOrigins 都能命中），但入口规则未授权该 redirect origin
    expect(policy.authorizeFetch({
      tenantId: "tenant-a", space: "space-a", url: `${OTHER_ORIGIN}/guide/x`,
      redirectOrigins: [DOCS_ORIGIN, OTHER_ORIGIN], ...DECLARED, byteLength: 0,
    }).decision).toBe("allow");
    const denied = await captureDeny(broker.acquire(acquireInput(policy)));
    expect(denied.code).toBe("redirect-origin-not-authorized");
    expect(calls).toHaveLength(1);
  });

  it("redirect 到授权 origin 但越出 pathPrefix → 该跳 policy 拒绝", async () => {
    const { policy, broker, calls } = await harness({
      responses: [fakeResponse("", 302, { location: `${CDN_ORIGIN}/private/x` })],
    });
    const denied = await captureDeny(broker.acquire(acquireInput(policy)));
    expect(denied.code).toBe("policy-denied");
    expect(calls).toHaveLength(1);
  });

  it("超过 hop 上限 → 拒绝", async () => {
    const { policy, broker, calls } = await harness({
      maxRedirects: 2,
      responses: [
        fakeResponse("", 302, { location: `${DOCS_ORIGIN}/guide/a` }),
        fakeResponse("", 302, { location: `${DOCS_ORIGIN}/guide/b` }),
        fakeResponse("", 302, { location: `${DOCS_ORIGIN}/guide/c` }),
      ],
    });
    const denied = await captureDeny(broker.acquire(acquireInput(policy)));
    expect(denied.code).toBe("too-many-redirects");
    expect(calls).toHaveLength(3);
  });

  it("非 2xx/304 状态 → 拒绝", async () => {
    const { policy, broker } = await harness({ responses: [fakeResponse("nope", 404)] });
    const denied = await captureDeny(broker.acquire(acquireInput(policy)));
    expect(denied.code).toBe("unexpected-status");
    expect(denied.status).toBe(404);
  });

  // ─── §4 DNS/IP 安全（复用现有 transport 防线） ────────────────────────

  const privateTargets: Array<[string, ResolvedAddress[]]> = [
    ["loopback", [{ address: "127.0.0.1", family: 4 }]],
    ["private-10", [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.1", family: 4 }]],
    ["link-local", [{ address: "169.254.169.254", family: 4 }]],
    ["unspecified", [{ address: "0.0.0.0", family: 4 }]],
    ["ipv6-loopback", [{ address: "::1", family: 6 }]],
    ["ipv6-link-local", [{ address: "fe80::1", family: 6 }]],
    ["ipv6-unspecified", [{ address: "::", family: 6 }]],
    ["ipv4-mapped-loopback", [{ address: "::ffff:127.0.0.1", family: 6 }]],
  ];

  for (const [label, addresses] of privateTargets) {
    it(`DNS 解析到 ${label} 地址 → 拒绝且零请求`, async () => {
      const { policy, broker, calls } = await harness({
        responses: [],
        lookup: async () => addresses,
      });
      const denied = await captureDeny(broker.acquire(acquireInput(policy)));
      expect(denied.code).toBe("private-address");
      expect(calls).toHaveLength(0);
    });
  }

  it("DNS 无解析结果 → 拒绝", async () => {
    const { policy, broker } = await harness({ responses: [], lookup: async () => [] });
    const denied = await captureDeny(broker.acquire(acquireInput(policy)));
    expect(denied.code).toBe("dns-empty");
  });

  it("redirect 跳的目标解析到私网 → 在该跳拒绝", async () => {
    const { policy, broker, calls } = await harness({
      responses: [fakeResponse("", 302, { location: `${CDN_ORIGIN}/guide/intro-v2` })],
      lookup: async (hostname) => (hostname === "docs.example.org" ? PUBLIC_ADDR : [{ address: "10.1.2.3", family: 4 }]),
    });
    const denied = await captureDeny(broker.acquire(acquireInput(policy)));
    expect(denied.code).toBe("private-address");
    expect(calls).toHaveLength(1);
  });

  // ─── §5 字节预算与超时预算 ───────────────────────────────────────────

  it("超过 policy maxBytes → 拒绝，且不消费预算外字节", async () => {
    let yieldedAfterOverflow = false;
    let canceled = false;
    const response = fakeResponse("");
    response.headers = { get: (n) => (n.toLowerCase() === "content-type" ? "text/html" : null) };
    response.body = async function* () {
      yield new Uint8Array(3000);
      yield new Uint8Array(3000); // 累计 6000 > maxBytes 4096
      yieldedAfterOverflow = true;
      yield new Uint8Array(10_000);
    };
    response.cancel = () => { canceled = true; };
    const { policy, broker } = await harness({ responses: [response] });
    const denied = await captureDeny(broker.acquire(acquireInput(policy)));
    expect(denied.code).toBe("oversized");
    expect(canceled).toBe(true);
    expect(yieldedAfterOverflow).toBe(false);
  });

  it("恰好等于 maxBytes 的响应通过（边界内）", async () => {
    const body = new Uint8Array(4096).fill(0x61);
    const { policy, broker } = await harness({
      responses: [fakeResponse(body, 200, { "content-type": "text/html" })],
    });
    const envelope = await broker.acquire(acquireInput(policy));
    expect(envelope.byteLength).toBe(4096);
    expect(envelope.rawHash).toBe(sha256Hex(body));
  });

  it("timeout 预算生效（注入 timer，无真实等待）", async () => {
    const scheduled: Array<{ fn: () => void; ms: number }> = [];
    let cleared = 0;
    const timers = {
      setTimeout: (fn: () => void, ms: number) => { scheduled.push({ fn, ms }); return scheduled.length; },
      clearTimeout: () => { cleared += 1; },
    };
    const policy = await verifiedPolicy();
    let started: () => void = () => {};
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const broker = createPolicyBoundSourceFetchBroker({
      policy,
      declaredSource: DECLARED,
      lookup: async () => PUBLIC_ADDR,
      request: (_url, init) => new Promise<WebResponse>((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")));
        started();
      }),
      clock: CLOCK,
      timeoutMs: 1500,
      timers,
    });
    const pending = broker.acquire(acquireInput(policy));
    await startedPromise;
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.ms).toBe(1500);
    scheduled[0]!.fn();
    const denied = await captureDeny(pending);
    expect(denied.code).toBe("timeout");
    expect(cleared).toBeGreaterThan(0);
  });

  // ─── §6 条件请求：ETag 304 / Last-Modified ───────────────────────────

  it("ETag 条件请求发出 if-none-match；304 返回零成本 envelope（保留已知 hash）", async () => {
    const priorHash = sha256Hex(HTML);
    const { policy, broker, calls } = await harness({
      responses: [fakeResponse("", 304, { etag: 'W/"v1"' })],
    });
    const envelope = await broker.acquire(acquireInput(policy, {
      ifNoneMatch: 'W/"v1"',
      knownRawHash: priorHash,
      knownNormalizedTextHash: sha256Hex("prior-normalized"),
    }));
    expect(calls[0]!.headers["if-none-match"]).toBe('W/"v1"');
    expect(envelope.status).toBe(304);
    expect(envelope.notModified).toBe(true);
    expect(envelope.rawHash).toBe(priorHash);
    expect(envelope.rawBytes.byteLength).toBe(0);
    expect(envelope.byteLength).toBe(0);
    expect(envelope.headers.etag).toBe('W/"v1"');
    expect(envelope.normalizedTextHash).toBe(sha256Hex("prior-normalized"));
    // 内容类型回退到申报值，envelope 仍是合法可存 revision 输入
    expect(envelope.headers.contentType).toBe("text/html");
  });

  it("304 无已知 hash 时接受 server-furnished content-digest", async () => {
    const digestHex = sha256Hex(HTML);
    const digestB64 = Buffer.from(digestHex, "hex").toString("base64");
    const { policy, broker } = await harness({
      responses: [fakeResponse("", 304, { etag: 'W/"v1"', "content-digest": `sha-256=:${digestB64}:` })],
    });
    const envelope = await broker.acquire(acquireInput(policy, { ifNoneMatch: 'W/"v1"' }));
    expect(envelope.rawHash).toBe(digestHex);
    expect(envelope.notModified).toBe(true);
  });

  it("304 既无已知 hash 也无 server digest → 拒绝（不得返回缺 rawHash 的 envelope）", async () => {
    const { policy, broker } = await harness({ responses: [fakeResponse("", 304, { etag: 'W/"v1"' })] });
    const denied = await captureDeny(broker.acquire(acquireInput(policy, { ifNoneMatch: 'W/"v1"' })));
    expect(denied.code).toBe("not-modified-without-artifact-hash");
  });

  it("未发条件请求却收到 304 → 协议违约拒绝", async () => {
    const { policy, broker } = await harness({ responses: [fakeResponse("", 304, {})] });
    const denied = await captureDeny(broker.acquire(acquireInput(policy, { knownRawHash: sha256Hex(HTML) })));
    expect(denied.code).toBe("not-modified-without-conditional");
  });

  it("Last-Modified 条件请求发出 if-modified-since 并回填 304 envelope", async () => {
    const priorHash = sha256Hex(HTML);
    const { policy, broker, calls } = await harness({
      responses: [fakeResponse("", 304, { "last-modified": "Tue, 19 Aug 2026 00:00:00 GMT" })],
    });
    const envelope = await broker.acquire(acquireInput(policy, {
      ifModifiedSince: "Tue, 19 Aug 2026 00:00:00 GMT",
      knownRawHash: priorHash,
    }));
    expect(calls[0]!.headers["if-modified-since"]).toBe("Tue, 19 Aug 2026 00:00:00 GMT");
    expect(envelope.status).toBe(304);
    expect(envelope.headers.lastModified).toBe("Tue, 19 Aug 2026 00:00:00 GMT");
    expect(envelope.rawHash).toBe(priorHash);
  });

  it("200 响应携带的 content-digest 与实算 hash 不一致 → 拒绝", async () => {
    const wrong = Buffer.from(sha256Hex("other"), "hex").toString("base64");
    const { policy, broker } = await harness({
      responses: [fakeResponse(HTML, 200, { "content-type": "text/html", "content-digest": `sha-256=:${wrong}:` })],
    });
    const denied = await captureDeny(broker.acquire(acquireInput(policy)));
    expect(denied.code).toBe("artifact-hash-mismatch");
  });

  // ─── §7 hash 稳定性与确定性归一化 ─────────────────────────────────────

  it("raw hash 与 normalized hash 不受 chunk 切分影响（稳定）", async () => {
    const bytes = new TextEncoder().encode(HTML);
    const split = [bytes.slice(0, 7), bytes.slice(7, 40), bytes.slice(40)];
    const one = await harness({ responses: [fakeResponse(HTML, 200, { "content-type": "text/html" })] });
    const many = await harness({ responses: [fakeResponse(split, 200, { "content-type": "text/html" })] });
    const a = await one.broker.acquire(acquireInput(one.policy));
    const b = await many.broker.acquire(acquireInput(many.policy));
    expect(a.rawHash).toBe(b.rawHash);
    expect(a.rawHash).toBe(sha256Hex(bytes));
    expect(a.normalizedText).toBe(b.normalizedText);
    expect(a.normalizedTextHash).toBe(b.normalizedTextHash);
  });

  it("HTML normalized representation 确定：空白/注释/CRLF/charset 差异归一到同一 hash", async () => {
    const variantA = "<html>\r\n<body>\r\n  <h1>Cats</h1>\r\n  <p>Rain &amp; sun</p>\r\n</body></html>";
    const variantB = "<html><body><!-- 注释 --><h1>Cats</h1>    <p>Rain &amp; sun</p>\n\n</body></html>";
    const a = await harness({ responses: [fakeResponse(variantA, 200, { "content-type": "text/html; charset=UTF-8" })] });
    const b = await harness({ responses: [fakeResponse(variantB, 200, { "content-type": "text/html" })] });
    const ea = await a.broker.acquire(acquireInput(a.policy));
    const eb = await b.broker.acquire(acquireInput(b.policy));
    expect(ea.normalizedText).toBe("Cats Rain & sun");
    expect(ea.normalizedTextHash).toBe(eb.normalizedTextHash);
    expect(ea.rawHash).not.toBe(eb.rawHash); // raw 字节不同 → artifact 不同
  });

  it("normalizeSourceText 是纯确定函数（同输入同输出，含实体与 NBSP）", async () => {
    const bytes = new TextEncoder().encode(HTML);
    const first = normalizeSourceText(bytes, "text/html; charset=utf-8");
    const second = normalizeSourceText(bytes, "text/html");
    expect(first.text).toBe(second.text);
    expect(first.hash).toBe(second.hash);
    expect(first.representation).toBe("normalized-text");
    expect(first.text).toContain("Rain & sun's day end");
    expect(first.text).not.toContain("x()");
    expect(first.text).not.toContain("b{}");
    const unknown = normalizeSourceText(bytes, "application/octet-stream");
    expect(unknown.representation).toBe("none");
    expect(unknown.text).toBe("");
    expect(unknown.hash).toBe(sha256Hex(""));
  });
});

// ─── §8 两阶段 admission（fetch → quarantine → use） ───────────────────

describe("N29 Task 4: deterministic fetch/use admission", () => {
  async function acquired(
    responses: FakeResponse[] = [fakeResponse(HTML, 200, { "content-type": "text/html", etag: 'W/"v1"' })],
    manifest: Partial<TrustPolicyManifest> = {},
  ) {
    const h = await harness({ responses, manifest });
    const envelope = await h.broker.acquire(acquireInput(h.policy));
    return { ...h, envelope };
  }

  function useInput(
    policy: VerifiedTrustPolicy,
    envelope: PolicyBoundSourceAcquisitionEnvelope,
    extra: Partial<SourceAdmissionInput> = {},
  ): SourceAdmissionInput {
    return {
      envelope,
      tenantId: "tenant-a",
      space: "space-a",
      subscriptionId: "sub-1",
      domain: "docs.example.org",
      sourceType: "bounded-html",
      license: "public-domain",
      subscriptionStatus: "probing",
      ...extra,
    } as SourceAdmissionInput;
  }

  it("authorizeUse 通过后才给出 admitted 判定；不得改动 envelope", async () => {
    const { policy, envelope } = await acquired();
    const before = JSON.stringify({ ...envelope, rawBytes: Array.from(envelope.rawBytes) });
    const verdict = decideSourceAdmission({ policy, clock: CLOCK }, useInput(policy, envelope));
    expect(verdict.verdict).toBe("admit");
    expect(verdict.mayStoreAdmittedRevision).toBe(true);
    expect(verdict.mayExtract).toBe(true);
    expect(verdict.nextRevisionDisposition).toBe("admitted");
    expect(verdict.quarantinedDisposition).toBe("raw-quarantine");
    expect(verdict.denyCodes).toEqual([]);
    expect(verdict.usePolicyDecision.decision).toBe("allow");
    expect(verdict.usePolicyDecision.ruleId).toBe("rule-docs");
    expect(verdict.artifactHash).toBe(sha256Hex(HTML));
    expect(verdict.representation).toBe("normalized-text");
    expect(verdict.policyDecisionDigest).toMatch(HEX64);
    expect(verdict.decidedAt).toBe(NOW.toISOString());
    // envelope 未被改写
    expect(JSON.stringify({ ...envelope, rawBytes: Array.from(envelope.rawBytes) })).toBe(before);
    // 同输入同判定（确定性）
    const again = decideSourceAdmission({ policy, clock: CLOCK }, useInput(policy, envelope));
    expect(again.policyDecisionDigest).toBe(verdict.policyDecisionDigest);
  });

  it("acquisition 之后 use 之前：raw 只能是 quarantine（deny 不产出 admitted）", async () => {
    const { policy, envelope } = await acquired();
    const denied = decideSourceAdmission(
      { policy, clock: CLOCK },
      useInput(policy, envelope, { license: "unknown-license" }),
    );
    expect(denied.verdict).toBe("deny");
    expect(denied.denyCodes).toContain("unknown-license");
    expect(denied.mayStoreAdmittedRevision).toBe(false);
    expect(denied.mayExtract).toBe(false);
    expect(denied.nextRevisionDisposition).toBeUndefined();
    expect(denied.quarantinedDisposition).toBe("raw-quarantine");
    expect(denied.usePolicyDecision.decision).toBe("deny");
  });

  it("未知/未批准 content type：envelope 保留 raw，但 use 被拒", async () => {
    const { policy, envelope } = await acquired([
      fakeResponse(new Uint8Array([0x00, 0x01, 0x02, 0x03]), 200, { "content-type": "application/octet-stream" }),
    ]);
    expect(envelope.rawHash).toMatch(HEX64);
    expect(envelope.contentTypeApproved).toBe(false);
    expect(envelope.normalization).toBe("none");
    expect(envelope.normalizedText).toBe("");
    const verdict = decideSourceAdmission({ policy, clock: CLOCK }, useInput(policy, envelope));
    expect(verdict.verdict).toBe("deny");
    expect(verdict.denyCodes).toContain("content-type-not-approved");
    expect(verdict.mayExtract).toBe(false);
  });

  it("fetch 后策略轮换（新 digest/version）→ use 拒绝 policy-changed", async () => {
    const { policy, envelope } = await acquired();
    const rotated = await verifiedPolicy({ version: "2" });
    const verdict = decideSourceAdmission({ policy: rotated, clock: CLOCK }, useInput(rotated, envelope));
    expect(verdict.verdict).toBe("deny");
    expect(verdict.denyCodes).toContain("policy-changed");
    expect(verdict.mayStoreAdmittedRevision).toBe(false);
  });

  it("fetch 后策略过期 → use 拒绝（use 时刻走生产 authorizeUse matcher）", async () => {
    const { policy, envelope } = await acquired();
    // use 阶段重新读策略：同一份已验签 manifest，但按「use 时刻」的时钟走生产 matcher
    const expiredClock = { now: () => new Date("2100-01-01T00:00:00.000Z") };
    const useTimePolicy = {
      manifest: policy.manifest,
      authorizeUse: (i: UseAuthorizationInput) => authorizeUse(policy.manifest, i, expiredClock),
    };
    const verdict = decideSourceAdmission({ policy: useTimePolicy, clock: expiredClock }, useInput(policy, envelope));
    expect(verdict.verdict).toBe("deny");
    expect(verdict.denyCodes).toContain("policy-denied");
    expect(verdict.usePolicyDecision.reason).toMatch(/expired/);
  });

  it("订阅被撤销/暂停 → use 拒绝", async () => {
    const { policy, envelope } = await acquired();
    for (const status of ["revoked", "paused", "retired"] as const) {
      const verdict = decideSourceAdmission(
        { policy, clock: CLOCK },
        useInput(policy, envelope, { subscriptionStatus: status }),
      );
      expect(verdict.verdict).toBe("deny");
      expect(verdict.denyCodes).toContain("subscription-inactive");
    }
  });

  it("domain/sourceType 不匹配 → use 拒绝", async () => {
    const { policy, envelope } = await acquired();
    const d1 = decideSourceAdmission({ policy, clock: CLOCK }, useInput(policy, envelope, { domain: "elsewhere.example" }));
    expect(d1.denyCodes).toContain("domain-not-approved");
    const d2 = decideSourceAdmission({ policy, clock: CLOCK }, useInput(policy, envelope, { sourceType: "browser-rendered" }));
    expect(d2.denyCodes).toContain("source-type-not-approved");
  });

  it("被篡改的 envelope（hash/字节/字节数/越权 redirect/私网地址/非 TLS）一律 fail closed", async () => {
    const { policy, envelope } = await acquired();
    const mutate = (patch: Partial<PolicyBoundSourceAcquisitionEnvelope>): PolicyBoundSourceAcquisitionEnvelope =>
      ({ ...envelope, ...patch }) as PolicyBoundSourceAcquisitionEnvelope;

    const tampered = decideSourceAdmission({ policy, clock: CLOCK }, useInput(policy, mutate({
      rawBytes: new TextEncoder().encode("<html><body>evil</body></html>"),
    })));
    expect(tampered.denyCodes).toContain("artifact-hash-mismatch");

    const oversized = decideSourceAdmission({ policy, clock: CLOCK }, useInput(policy, mutate({ byteLength: 999_999 })));
    expect(oversized.denyCodes).toContain("oversized");

    const escaped = decideSourceAdmission({ policy, clock: CLOCK }, useInput(policy, mutate({
      redirectChain: [`${DOCS_ORIGIN}/guide/intro`, "https://evil.example/guide/x"],
      finalUri: "https://evil.example/guide/x",
    })));
    expect(escaped.denyCodes).toContain("escaped-redirect");

    const insecure = decideSourceAdmission({ policy, clock: CLOCK }, useInput(policy, mutate({
      finalUri: "http://docs.example.org/guide/intro",
      redirectChain: ["http://docs.example.org/guide/intro"],
    })));
    expect(insecure.denyCodes).toContain("insecure-transport");

    const privateAddr = decideSourceAdmission({ policy, clock: CLOCK }, useInput(policy, mutate({
      hops: envelope.hops.map((h) => ({ ...h, addresses: [{ address: "10.0.0.7", family: 4 }] })),
    })));
    expect(privateAddr.denyCodes).toContain("private-address");
  });

  it("304 unchanged：允许复用 artifact，但不产生新的 admitted revision", async () => {
    const priorHash = sha256Hex(HTML);
    const h = await harness({ responses: [fakeResponse("", 304, { etag: 'W/"v1"' })] });
    const envelope = await h.broker.acquire(acquireInput(h.policy, {
      ifNoneMatch: 'W/"v1"',
      knownRawHash: priorHash,
      knownNormalizedTextHash: sha256Hex("prior"),
    }));
    const verdict = decideSourceAdmission({ policy: h.policy, clock: CLOCK }, useInput(h.policy, envelope));
    expect(verdict.verdict).toBe("reuse-unchanged");
    expect(verdict.nextRevisionDisposition).toBe("unchanged");
    expect(verdict.mayStoreAdmittedRevision).toBe(false);
    expect(verdict.mayExtract).toBe(false);
    expect(verdict.usePolicyDecision.decision).toBe("allow");
    expect(verdict.artifactHash).toBe(priorHash);
  });
});

// ─── §9 生产 transport：真实本地 HTTPS server ─────────────────────────

interface SelfSigned { cert: string; key: string; dir: string }

function tryCreateSelfSigned(host: string): SelfSigned | null {
  let dir: string | null = null;
  try {
    dir = mkdtempSync(path.join(tmpdir(), "n29-l4-tls-"));
    const keyPath = path.join(dir, "key.pem");
    const certPath = path.join(dir, "cert.pem");
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", keyPath, "-out", certPath, "-days", "2",
      "-subj", `/CN=${host}`, "-addext", `subjectAltName=DNS:${host}`,
    ], { stdio: "ignore" });
    return { cert: readFileSync(certPath, "utf8"), key: readFileSync(keyPath, "utf8"), dir };
  } catch {
    if (dir) rmSync(dir, { recursive: true, force: true });
    return null;
  }
}

const TLS_HOST = "docs.example.org";
const selfSigned = tryCreateSelfSigned(TLS_HOST);

afterAll(() => {
  if (selfSigned) rmSync(selfSigned.dir, { recursive: true, force: true });
});

describe("N29 Task 4: 生产 transport 经真实本地 HTTPS server", () => {
  it.runIf(selfSigned !== null)("defaultWebRequest 走真实 TLS：redirect/hash/条件请求全链路", async () => {
    const tls = selfSigned!;
    const bodyHtml = "<html><body><h1>TLS</h1><p>real socket</p></body></html>";
    const seen: Array<{ url: string; encrypted: boolean; ifNoneMatch?: string }> = [];
    const server = https.createServer({ cert: tls.cert, key: tls.key }, (req, res) => {
      seen.push({
        url: req.url ?? "",
        encrypted: Boolean((req.socket as { encrypted?: boolean }).encrypted),
        ...(req.headers["if-none-match"] === undefined ? {} : { ifNoneMatch: String(req.headers["if-none-match"]) }),
      });
      if (req.url === "/guide/intro") {
        res.writeHead(302, { location: "/guide/intro-v2" });
        res.end();
        return;
      }
      if (req.headers["if-none-match"] === 'W/"tls-1"') {
        res.writeHead(304, { etag: 'W/"tls-1"' });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", etag: 'W/"tls-1"' });
      res.end(bodyHtml);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const previousCa = https.globalAgent.options.ca;
    https.globalAgent.options.ca = [tls.cert];
    try {
      const policy = await verifiedPolicy({
        rules: [rule({
          httpsOrigin: `https://${TLS_HOST}:${port}`,
          redirectOrigins: [`https://${TLS_HOST}:${port}`],
        })],
      });
      const origin = `https://${TLS_HOST}:${port}`;
      const broker = createPolicyBoundSourceFetchBroker({
        policy,
        declaredSource: DECLARED,
        // DNS 守卫保持生效（公网地址通过校验）；连接目标 pin 到本地测试 server
        lookup: async () => PUBLIC_ADDR,
        request: (url, init) => defaultWebRequest(url, { ...init, addresses: [{ address: "127.0.0.1", family: 4 }] }),
        clock: CLOCK,
      });
      const input = {
        tenantId: "tenant-a",
        space: "space-a",
        subscriptionId: "sub-tls",
        requestedUri: `${origin}/guide/intro`,
        fetchPolicyDecision: policy.authorizeFetch({
          tenantId: "tenant-a", space: "space-a", url: `${origin}/guide/intro`,
          redirectOrigins: [origin], ...DECLARED, byteLength: 0,
        }),
      };
      const envelope = await broker.acquire(input);
      expect(envelope.status).toBe(200);
      expect(envelope.redirectChain).toEqual([`${origin}/guide/intro`, `${origin}/guide/intro-v2`]);
      expect(envelope.finalUri).toBe(`${origin}/guide/intro-v2`);
      expect(envelope.rawHash).toBe(sha256Hex(bodyHtml));
      expect(envelope.headers.contentType).toBe("text/html");
      expect(envelope.headers.etag).toBe('W/"tls-1"');
      expect(envelope.normalizedText).toBe("TLS real socket");
      expect(seen.every((s) => s.encrypted)).toBe(true);

      const verdict = decideSourceAdmission({ policy, clock: CLOCK }, {
        envelope,
        tenantId: "tenant-a",
        space: "space-a",
        subscriptionId: "sub-tls",
        domain: "docs.example.org",
        sourceType: "bounded-html",
        license: "public-domain",
        subscriptionStatus: "probing",
      });
      expect(verdict.verdict).toBe("admit");

      // 条件重爬：304 零成本（真实 socket）
      const unchanged = await broker.acquire({
        ...input,
        requestedUri: `${origin}/guide/intro-v2`,
        fetchPolicyDecision: policy.authorizeFetch({
          tenantId: "tenant-a", space: "space-a", url: `${origin}/guide/intro-v2`,
          redirectOrigins: [origin], ...DECLARED, byteLength: 0,
        }),
        ifNoneMatch: 'W/"tls-1"',
        knownRawHash: envelope.rawHash,
        knownNormalizedTextHash: envelope.normalizedTextHash,
      });
      expect(unchanged.status).toBe(304);
      expect(unchanged.notModified).toBe(true);
      expect(unchanged.rawHash).toBe(envelope.rawHash);
      expect(unchanged.byteLength).toBe(0);
      expect(seen.some((s) => s.ifNoneMatch === 'W/"tls-1"')).toBe(true);
    } finally {
      https.globalAgent.options.ca = previousCa;
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
