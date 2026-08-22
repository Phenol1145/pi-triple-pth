import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  acceptanceEnvelopeCanonicalBytes,
  assertIntakeFullAcceptance,
  selectIntakeStageHandlers,
  verifyIntakeAcceptanceSignature,
  type IntakeAcceptanceEnvelopeLike,
} from "../../src/pth/bootstrap/intake-mode-gates.js";

const handlers = {
  "intake.fetch": async () => {},
  "intake.extract": async () => {},
  "intake.review-domain": async () => {},
  "intake.review-adversarial": async () => {},
  "intake.promote": async () => {},
};

describe("N29 refix P0-9：draft/full 模式分离", () => {
  it("off 模式零 handler", () => {
    expect(Object.keys(selectIntakeStageHandlers("off", handlers, "intake.promote"))).toHaveLength(0);
  });

  it("draft 模式剔除 promote handler（只到 private draft + open plan）", () => {
    const selected = selectIntakeStageHandlers("draft", handlers, "intake.promote");
    expect(Object.keys(selected).sort()).toEqual([
      "intake.extract", "intake.fetch", "intake.review-adversarial", "intake.review-domain",
    ]);
    expect(selected["intake.promote"]).toBeUndefined();
    // 原对象不被修改。
    expect(handlers["intake.promote"]).toBeDefined();
  });

  it("full 模式保留全部 handler", () => {
    expect(Object.keys(selectIntakeStageHandlers("full", handlers, "intake.promote")).sort())
      .toEqual(Object.keys(handlers).sort());
  });

  it("full 启动门：非 MIN_INNER_LOOP_GO / 缺 commit / 脏树 / commit 不符全部拒绝", () => {
    expect(() => assertIntakeFullAcceptance({ decision: "EVALUATION-INCOMPLETE", evaluatedCommit: "abc", implementationTreeClean: true }))
      .toThrow(/MIN_INNER_LOOP_GO/);
    expect(() => assertIntakeFullAcceptance({ decision: "NO-GO", evaluatedCommit: "abc", implementationTreeClean: true }))
      .toThrow(/MIN_INNER_LOOP_GO/);
    expect(() => assertIntakeFullAcceptance({ decision: "MIN_INNER_LOOP_GO" }))
      .toThrow(/evaluatedCommit/);
    expect(() => assertIntakeFullAcceptance({ decision: "MIN_INNER_LOOP_GO", evaluatedCommit: "abc", implementationTreeClean: false }))
      .toThrow(/implementationTreeClean/);
    expect(() => assertIntakeFullAcceptance(
      { decision: "MIN_INNER_LOOP_GO", evaluatedCommit: "abc", implementationTreeClean: true },
      "def",
    )).toThrow(/不一致/);
  });

  it("full 启动门：合法 envelope 通过", () => {
    expect(() => assertIntakeFullAcceptance(
      { decision: "MIN_INNER_LOOP_GO", evaluatedCommit: "abc", implementationTreeClean: true },
    )).not.toThrow();
    expect(() => assertIntakeFullAcceptance(
      { decision: "MIN_INNER_LOOP_GO", evaluatedCommit: "abc", implementationTreeClean: true },
      "abc",
    )).not.toThrow();
  });
});

describe("N29 refix D-5：full 验收 envelope 签名验签", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  function signedEnvelope(overrides: Partial<IntakeAcceptanceEnvelopeLike> = {}): IntakeAcceptanceEnvelopeLike {
    const unsigned: IntakeAcceptanceEnvelopeLike = {
      decision: "MIN_INNER_LOOP_GO",
      evaluatedCommit: "abc",
      implementationTreeClean: true,
      signingAlgorithm: "ed25519",
      signingKeyId: "ci-release",
      ...overrides,
    };
    const signature = edSign(null, acceptanceEnvelopeCanonicalBytes(unsigned), privateKeyPem).toString("base64");
    return { ...unsigned, signature };
  }

  it("canonical bytes 排除 signature 字段，签名可被公钥验证", () => {
    const envelope = signedEnvelope();
    expect(verifyIntakeAcceptanceSignature(envelope, publicKeyPem)).toBe(true);
    const tampered = { ...envelope, evaluatedCommit: "def" } as IntakeAcceptanceEnvelopeLike;
    expect(verifyIntakeAcceptanceSignature(tampered, publicKeyPem)).toBe(false);
  });

  it("full 启动门 requireSignature=true 时缺公钥/缺签名/坏签名/错 commit 全部拒绝", () => {
    expect(() => assertIntakeFullAcceptance(
      signedEnvelope(),
      "abc",
      { requireSignature: true },
    )).toThrow(/公钥/);
    expect(() => assertIntakeFullAcceptance(
      { decision: "MIN_INNER_LOOP_GO", evaluatedCommit: "abc", implementationTreeClean: true },
      "abc",
      { publicKeyPem, requireSignature: true },
    )).toThrow(/签名/);
    const valid = signedEnvelope();
    expect(() => assertIntakeFullAcceptance(
      { ...valid, signature: "bm90LWEtc2lnbmF0dXJl" },
      "abc",
      { publicKeyPem, requireSignature: true },
    )).toThrow(/签名验证失败/);
    expect(() => assertIntakeFullAcceptance(
      signedEnvelope({ evaluatedCommit: "def" }),
      "abc",
      { publicKeyPem, requireSignature: true },
    )).toThrow(/不一致/);
  });

  it("full 启动门 requireSignature=true 时合法签名通过", () => {
    expect(() => assertIntakeFullAcceptance(
      signedEnvelope(),
      "abc",
      { publicKeyPem, requireSignature: true },
    )).not.toThrow();
  });
});
