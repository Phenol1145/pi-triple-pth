import { describe, it, expect } from "vitest";
import { WORK_MODES, isWorkMode } from "@away_from/shared";
import {
  OPERATOR_PAGE_IDS,
  isOperatorPageId,
  canonicalPreviewDigest,
  deepFreezeJson,
  type OperatorContext,
  type OperatorPreviewCanonicalInput,
} from "../../packages/pth-console/src/operator-console/contracts.js";

/** 与 PTH src/pth/contracts/work-mode.ts 同源的 canonical WorkMode 镜像 */
describe("@away_from/shared WorkMode mirror", () => {
  it("exports the three canonical work modes in fixed order", () => {
    expect(WORK_MODES).toEqual(["intake", "optimize", "run"]);
    expect(new Set(WORK_MODES).size).toBe(3);
  });

  it("isWorkMode validates only the three canonical values", () => {
    expect(isWorkMode("intake")).toBe(true);
    expect(isWorkMode("optimize")).toBe(true);
    expect(isWorkMode("run")).toBe(true);
    expect(isWorkMode("shell.exec")).toBe(false);
    expect(isWorkMode("RUN")).toBe(false);
    expect(isWorkMode(3)).toBe(false);
    expect(isWorkMode(null)).toBe(false);
  });
});

describe("OPERATOR_PAGE_IDS", () => {
  it("contains exactly the five operator console pages and is frozen", () => {
    expect(OPERATOR_PAGE_IDS).toEqual(["overview", "work", "debug", "memory", "config"]);
    expect(Object.isFrozen(OPERATOR_PAGE_IDS)).toBe(true);
  });

  it("isOperatorPageId accepts only those five ids", () => {
    expect(isOperatorPageId("overview")).toBe(true);
    expect(isOperatorPageId("work")).toBe(true);
    expect(isOperatorPageId("debug")).toBe(true);
    expect(isOperatorPageId("memory")).toBe(true);
    expect(isOperatorPageId("config")).toBe(true);
    expect(isOperatorPageId("http.request")).toBe(false);
    expect(isOperatorPageId("")).toBe(false);
  });
});

const baseInput = (): OperatorPreviewCanonicalInput => ({
  mode: "run",
  action: "task.publish",
  normalizedInput: { taskId: "t-1", budget: 2 },
  nativeTarget: "pth://task/publish",
  impact: { scope: "tenant", reversible: false, risk: "high" },
  expiresAt: "2026-08-19T00:00:00.000Z",
});

const baseContext = (): OperatorContext => ({
  tenant: "tenant-a",
  space: "space-1",
});

describe("canonicalPreviewDigest", () => {
  it("returns a 64-char lowercase sha-256 hex digest", () => {
    const d = canonicalPreviewDigest(baseInput(), baseContext());
    expect(d).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable under top-level key insertion order", () => {
    const ctx = baseContext();
    const a: OperatorPreviewCanonicalInput = {
      mode: "run",
      action: "task.publish",
      normalizedInput: { taskId: "t-1", budget: 2 },
      nativeTarget: "pth://task/publish",
      impact: { scope: "tenant", reversible: false, risk: "high" },
      expiresAt: "2026-08-19T00:00:00.000Z",
    };
    const b: OperatorPreviewCanonicalInput = {
      expiresAt: "2026-08-19T00:00:00.000Z",
      impact: { risk: "high", reversible: false, scope: "tenant" },
      nativeTarget: "pth://task/publish",
      normalizedInput: { budget: 2, taskId: "t-1" },
      action: "task.publish",
      mode: "run",
    };
    expect(canonicalPreviewDigest(a, ctx)).toBe(canonicalPreviewDigest(b, ctx));
  });

  it("changes on any one-byte input mutation", () => {
    const ctx = baseContext();
    const d = canonicalPreviewDigest(baseInput(), ctx);
    expect(
      canonicalPreviewDigest(
        { ...baseInput(), nativeTarget: "pth://task/publish!" },
        ctx,
      ),
    ).not.toBe(d);
    expect(
      canonicalPreviewDigest(
        { ...baseInput(), normalizedInput: { taskId: "t-1", budget: 3 } },
        ctx,
      ),
    ).not.toBe(d);
    expect(
      canonicalPreviewDigest({ ...baseInput(), action: "task.unpublish" }, ctx),
    ).not.toBe(d);
  });

  it("changes across tenant context and is stable across context key order", () => {
    const input = baseInput();
    const a = canonicalPreviewDigest(input, { tenant: "tenant-a", space: "space-1" });
    const b = canonicalPreviewDigest(input, { tenant: "tenant-b", space: "space-1" });
    const c = canonicalPreviewDigest(input, { space: "space-1", tenant: "tenant-a" });
    expect(a).not.toBe(b);
    expect(a).toBe(c);
  });

  it("excludes CSRF/session tokens from the digest", () => {
    const input = baseInput();
    const withoutTokens = canonicalPreviewDigest(input, {
      tenant: "tenant-a",
      space: "space-1",
    });
    const withTokens = canonicalPreviewDigest(input, {
      tenant: "tenant-a",
      space: "space-1",
      csrfToken: "csrf-a",
      sessionToken: "sess-a",
    });
    expect(withoutTokens).toBe(withTokens);
  });

  it("rejects non-finite numbers anywhere in the canonical input", () => {
    const ctx = baseContext();
    expect(() =>
      canonicalPreviewDigest(
        { ...baseInput(), normalizedInput: { budget: Infinity } },
        ctx,
      ),
    ).toThrow(/non-finite|finite/i);
    expect(() =>
      canonicalPreviewDigest(
        { ...baseInput(), normalizedInput: { budget: NaN } },
        ctx,
      ),
    ).toThrow(/non-finite|finite/i);
  });

  it("rejects functions anywhere in the canonical input", () => {
    expect(() =>
      canonicalPreviewDigest(
        { ...baseInput(), normalizedInput: { fn: () => "x" } },
        baseContext(),
      ),
    ).toThrow(/function/i);
  });

  it("rejects non-plain prototypes anywhere in the canonical input", () => {
    class Evtl {
      x = 1;
    }
    expect(() =>
      canonicalPreviewDigest(
        { ...baseInput(), normalizedInput: { evil: new Evtl() } },
        baseContext(),
      ),
    ).toThrow(/prototype/i);
    expect(() =>
      canonicalPreviewDigest(
        { ...baseInput(), normalizedInput: { at: new Date("2026-08-19T00:00:00Z") } },
        baseContext(),
      ),
    ).toThrow(/prototype/i);
  });

  it("rejects unknown top-level fields on the preview input", () => {
    expect(() =>
      canonicalPreviewDigest(
        { ...baseInput(), extra: "nope" } as unknown as OperatorPreviewCanonicalInput,
        baseContext(),
      ),
    ).toThrow(/unknown/i);
  });

  it("rejects unknown top-level fields on the operator context", () => {
    expect(() =>
      canonicalPreviewDigest(baseInput(), {
        tenant: "tenant-a",
        space: "space-1",
        token: "nope",
      } as OperatorContext),
    ).toThrow(/unknown/i);
  });
});

describe("deepFreezeJson", () => {
  it("deep-copies and deep-freezes plain JSON values without mutating the caller", () => {
    const source = {
      normalizedInput: { nested: { list: [1, 2], on: true } },
    };
    const before = JSON.stringify(source);
    const frozen = deepFreezeJson(source);

    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.normalizedInput)).toBe(true);
    expect(Object.isFrozen(frozen.normalizedInput.nested)).toBe(true);
    expect(Object.isFrozen(frozen.normalizedInput.nested.list)).toBe(true);
    expect(frozen.normalizedInput.nested.list).toEqual([1, 2]);

    // 调用方对象不被冻结、不被篡改
    expect(Object.isFrozen(source)).toBe(false);
    expect(JSON.stringify(source)).toBe(before);
  });

  it("does not mutate or freeze caller-owned objects while digesting", () => {
    const input = baseInput();
    const before = JSON.stringify(input);
    canonicalPreviewDigest(input, baseContext());
    expect(JSON.stringify(input)).toBe(before);
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(input.normalizedInput)).toBe(false);
  });
});
