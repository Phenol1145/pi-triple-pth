/**
 * test/pth-knowledge-intake/trust-policy.test.ts — N29 Task 2 红测（先红后绿）。
 *
 * 覆盖：
 *  - signed-manifest 验证（human signer / issuer / keyring / digest / validity / tenant / space）
 *  - deny-first 双阶段 matcher（authorizeFetch / authorizeUse）
 *  - fetch/use 边界（tenant/space/origin/path/redirect/bytes/license/content-type/sourceType/domain）
 *  - policy/subscription expiry/revocation fail closed
 */
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { describe, it, expect } from "vitest";
import {
  canonicalPolicySigningBytes,
  computePolicyDigest,
  loadVerifiedTrustPolicy,
} from "../../src/pth/execution/knowledge-intake/index.js";
import type {
  FetchAuthorizationInput,
  HumanPrincipalRef,
  TrustPolicyManifest,
  TrustPolicyRule,
  UseAuthorizationInput,
} from "../../src/pth/contracts/index.js";

const CLOCK = { now: () => new Date("2026-08-20T00:00:00.000Z") };

function makeKeypair(principalId: string): { publicKeyPem: string; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

function baseManifest(overrides: Partial<TrustPolicyManifest> = {}): TrustPolicyManifest {
  const approvedBy: HumanPrincipalRef = {
    kind: "human",
    principalId: "human-alice",
    tenantId: "tenant-a",
    issuer: "ptl-human-interface",
  };
  const rule: TrustPolicyRule = {
    ruleId: "rule-example-docs",
    effect: "allow",
    httpsOrigin: "https://example.com",
    pathPrefix: "/docs/",
    spaces: ["space-a"],
    domains: ["example.com"],
    sourceTypes: ["bounded-html"],
    contentTypes: ["text/html"],
    licenses: ["public-domain"],
    maxBytes: 1024,
    redirectOrigins: ["https://example.com"],
  };
  return {
    policyId: "policy-l2-test",
    version: "1",
    tenantId: "tenant-a",
    spaces: ["space-a"],
    validFrom: "2026-08-01T00:00:00.000Z",
    validUntil: "2099-08-01T00:00:00.000Z",
    approvedBy,
    approvalProof: { method: "signed-manifest", keyId: "human-alice", signature: "" },
    rules: [rule],
    digest: "",
    ...overrides,
  };
}

function signManifest(manifest: TrustPolicyManifest, privateKeyPem: string): TrustPolicyManifest {
  const digest = computePolicyDigest(manifest);
  const signature = edSign(null, canonicalPolicySigningBytes(manifest), privateKeyPem).toString("base64");
  return {
    ...manifest,
    digest,
    approvalProof: { ...manifest.approvalProof, signature },
  };
}

function buildValid(overrides: Partial<TrustPolicyManifest> = {}) {
  const keypair = makeKeypair("human-alice");
  const keyring = { "human-alice": keypair.publicKeyPem };
  const manifest = signManifest(baseManifest(overrides), keypair.privateKeyPem);
  return { keyring, manifest };
}

function fetchInput(overrides: Partial<FetchAuthorizationInput> = {}): FetchAuthorizationInput {
  return {
    tenantId: "tenant-a",
    space: "space-a",
    url: "https://example.com/docs/intro",
    redirectOrigins: ["https://example.com"],
    sourceType: "bounded-html",
    contentType: "text/html",
    license: "public-domain",
    byteLength: 1024,
    ...overrides,
  };
}

function useInput(overrides: Partial<UseAuthorizationInput> = {}): UseAuthorizationInput {
  return { ...fetchInput(), domain: "example.com", ...overrides };
}

describe("N29 Task 2: human-signed Trust Policy", () => {
  it("valid signed manifest verifies and yields authorized fetch/use decisions", async () => {
    const { keyring, manifest } = buildValid();
    const verified = await loadVerifiedTrustPolicy(manifest, keyring, CLOCK);
    expect(verified.manifest).toMatchObject({
      approvedBy: { kind: "human", tenantId: "tenant-a" },
    });
    expect(verified.authorizeFetch(fetchInput()).decision).toBe("allow");
    expect(verified.authorizeUse(useInput()).decision).toBe("allow");
  });

  it("service-signed manifest rejects with human signer", async () => {
    const keypair = makeKeypair("service-svc");
    const keyring = { "service-svc": keypair.publicKeyPem };
    const manifest = signManifest(
      baseManifest({
        approvedBy: {
          kind: "service" as unknown as HumanPrincipalRef["kind"],
          principalId: "service-svc",
          tenantId: "tenant-a",
          issuer: "ptl-human-interface",
        },
        approvalProof: { method: "signed-manifest", keyId: "service-svc", signature: "" },
      }),
      keypair.privateKeyPem,
    );
    await expect(loadVerifiedTrustPolicy(manifest, keyring, CLOCK)).rejects.toThrow("human signer");
  });

  it("fake human principal not present in the keyring rejects", async () => {
    const keypair = makeKeypair("human-alice");
    const { manifest } = buildValid();
    // 签名用的是 human-alice，但 keyring 只认识 human-bob —— 伪造主体必须失败。
    await expect(
      loadVerifiedTrustPolicy(manifest, { "human-bob": keypair.publicKeyPem }, CLOCK),
    ).rejects.toThrow(/principal|keyring/i);
  });

  it("wrong issuer rejects", async () => {
    const keypair = makeKeypair("human-alice");
    const keyring = { "human-alice": keypair.publicKeyPem };
    const manifest = signManifest(
      baseManifest({
        approvedBy: {
          kind: "human",
          principalId: "human-alice",
          tenantId: "tenant-a",
          issuer: "ptl-platform-service" as unknown as HumanPrincipalRef["issuer"],
        },
      }),
      keypair.privateKeyPem,
    );
    await expect(loadVerifiedTrustPolicy(manifest, keyring, CLOCK)).rejects.toThrow("human signer");
  });

  it("tampered digest rejects with digest", async () => {
    const { keyring, manifest } = buildValid();
    await expect(
      loadVerifiedTrustPolicy({ ...manifest, digest: "sha256:tampered" }, keyring, CLOCK),
    ).rejects.toThrow("digest");
  });

  it("expired validUntil rejects with expired", async () => {
    const keypair = makeKeypair("human-alice");
    const keyring = { "human-alice": keypair.publicKeyPem };
    const manifest = signManifest(
      baseManifest({ validUntil: "2020-01-01T00:00:00.000Z" }),
      keypair.privateKeyPem,
    );
    await expect(loadVerifiedTrustPolicy(manifest, keyring, CLOCK)).rejects.toThrow("expired");
  });

  it("wrong approvedBy tenant rejects", async () => {
    const keypair = makeKeypair("human-alice");
    const keyring = { "human-alice": keypair.publicKeyPem };
    const manifest = signManifest(
      baseManifest({
        approvedBy: {
          kind: "human",
          principalId: "human-alice",
          tenantId: "tenant-b",
          issuer: "ptl-human-interface",
        },
      }),
      keypair.privateKeyPem,
    );
    await expect(loadVerifiedTrustPolicy(manifest, keyring, CLOCK)).rejects.toThrow("tenant");
  });

  it("rule space outside manifest spaces rejects", async () => {
    const keypair = makeKeypair("human-alice");
    const keyring = { "human-alice": keypair.publicKeyPem };
    const manifest = signManifest(
      baseManifest({
        rules: [
          {
            ...baseManifest().rules[0]!,
            spaces: ["space-b"],
          },
        ],
      }),
      keypair.privateKeyPem,
    );
    await expect(loadVerifiedTrustPolicy(manifest, keyring, CLOCK)).rejects.toThrow("space");
  });

  it("deny-first matcher: a matching deny rule overrides a matching allow rule", async () => {
    const keypair = makeKeypair("human-alice");
    const keyring = { "human-alice": keypair.publicKeyPem };
    const allow = baseManifest().rules[0]!;
    const deny: TrustPolicyRule = { ...allow, ruleId: "rule-deny-docs", effect: "deny" };
    const manifest = signManifest(baseManifest({ rules: [allow, deny] }), keypair.privateKeyPem);
    const verified = await loadVerifiedTrustPolicy(manifest, keyring, CLOCK);

    const decision = verified.authorizeFetch(fetchInput());
    expect(decision.decision).toBe("deny");
    expect(decision.ruleId).toBe("rule-deny-docs");
    expect(decision.policyId).toBe("policy-l2-test");
  });

  it("unlisted origin fails closed with a structured deny decision", async () => {
    const { keyring, manifest } = buildValid();
    const verified = await loadVerifiedTrustPolicy(manifest, keyring, CLOCK);

    const decision = verified.authorizeFetch(fetchInput({ url: "https://unlisted.example.com/docs/intro" }));
    expect(decision.decision).toBe("deny");
    expect(decision.ruleId).toBe("fail-closed");
    expect(decision.policyDigest).toBe(manifest.digest);
  });

  it("tenant/space/origin/path/redirect/bytes boundaries fail closed", async () => {
    const { keyring, manifest } = buildValid();
    const verified = await loadVerifiedTrustPolicy(manifest, keyring, CLOCK);

    expect(verified.authorizeFetch(fetchInput({ tenantId: "tenant-b" })).decision).toBe("deny");
    expect(verified.authorizeFetch(fetchInput({ space: "space-b" })).decision).toBe("deny");
    expect(verified.authorizeFetch(fetchInput({ url: "https://example.com.evil/docs/intro" })).decision).toBe("deny");
    expect(verified.authorizeFetch(fetchInput({ url: "http://example.com/docs/intro" })).decision).toBe("deny");
    expect(verified.authorizeFetch(fetchInput({ url: "https://example.com/docs" })).decision).toBe("deny"); // prefix "/docs/"
    expect(verified.authorizeFetch(fetchInput({ url: "https://example.com/docs/intro" })).decision).toBe("allow");
    expect(verified.authorizeFetch(fetchInput({ redirectOrigins: ["https://cdn.example.com"] })).decision).toBe("deny");
    expect(verified.authorizeFetch(fetchInput({ byteLength: 1024 })).decision).toBe("allow");
    expect(verified.authorizeFetch(fetchInput({ byteLength: 1025 })).decision).toBe("deny");
  });

  it("unknown sourceType/contentType/license/domain rejects", async () => {
    const { keyring, manifest } = buildValid();
    const verified = await loadVerifiedTrustPolicy(manifest, keyring, CLOCK);

    expect(verified.authorizeFetch(fetchInput({ sourceType: "pdf" })).decision).toBe("deny");
    expect(verified.authorizeFetch(fetchInput({ contentType: "application/pdf" })).decision).toBe("deny");
    expect(verified.authorizeFetch(fetchInput({ license: "proprietary" })).decision).toBe("deny");
    expect(verified.authorizeUse(useInput({ domain: "other.example.com" })).decision).toBe("deny");
  });

  it("policy expiry at use time and revoked subscription reject", async () => {
    const keypair = makeKeypair("human-alice");
    const keyring = { "human-alice": keypair.publicKeyPem };
    const manifest = signManifest(
      baseManifest({ validUntil: "2026-08-21T00:00:00.000Z" }),
      keypair.privateKeyPem,
    );
    let currentDate = new Date("2026-08-20T00:00:00.000Z");
    const mutableClock = { now: () => currentDate };
    const verified = await loadVerifiedTrustPolicy(manifest, keyring, mutableClock);

    expect(verified.authorizeUse(useInput({ subscriptionStatus: "active" })).decision).toBe("allow");
    const revoked = verified.authorizeUse(useInput({ subscriptionStatus: "revoked" }));
    expect(revoked.decision).toBe("deny");
    expect(revoked.reason).toContain("revoked");

    currentDate = new Date("2026-08-22T00:00:00.000Z");
    const expiredAtUse = verified.authorizeUse(useInput());
    expect(expiredAtUse.decision).toBe("deny");
    expect(expiredAtUse.reason).toContain("expired");
  });
});
