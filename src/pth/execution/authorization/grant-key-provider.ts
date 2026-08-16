/**
 * execution/authorization/grant-key-provider.ts — 签名密钥提供器（模块化 v2 P2-1）。
 *
 * 密钥由 bootstrap 注入；本模块不提供默认值、不读取 sandbox-dev-secret 一类默认凭据。
 * 验证侧使用 timing-safe 比较，防止签名 oracle。
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export interface GrantKeyProvider {
  sign(payload: string): string;
  verify(payload: string, signature: string): boolean;
}

export function createHmacGrantKeyProvider(opts: { secret: string }): GrantKeyProvider {
  if (!opts.secret || opts.secret.length < 16) {
    throw new Error("grant signing secret must be at least 16 chars（bootstrap 注入，无默认值）");
  }
  return {
    sign(payload: string): string {
      return createHmac("sha256", opts.secret).update(payload).digest("hex");
    },
    verify(payload: string, signature: string): boolean {
      const expected = createHmac("sha256", opts.secret).update(payload).digest("hex");
      const a = Buffer.from(expected, "utf8");
      const b = Buffer.from(signature, "utf8");
      return a.length === b.length && timingSafeEqual(a, b);
    },
  };
}
