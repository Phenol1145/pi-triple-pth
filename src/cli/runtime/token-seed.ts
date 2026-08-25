/**
 * runtime/token-seed.ts —— local-process 的 operator token 播种（ioredis 直连）。
 *
 * 语义与 packages/pth-console/src/launcher.ts `seedOperatorToken`（compose exec 版）
 * 保持一致：SET `auth:token:<token>` 为 `{"tenantId":...,"role":"platform-admin","source":"pth-operator"}`，
 * 并回收同 tenant 的其他 `source=pth-operator` token；回收失败不阻断。
 * 已知双实现，统一化列 backlog（不在本期）。
 */
export interface TokenSeedClient {
  set(key: string, value: string): Promise<unknown>;
  keys(pattern: string): Promise<string[]>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<unknown>;
}

export async function seedOperatorTokenViaRedis(
  client: TokenSeedClient,
  token: string,
  tenant: string,
): Promise<void> {
  const payload = JSON.stringify({ tenantId: tenant, role: "platform-admin", source: "pth-operator" });
  await client.set(`auth:token:${token}`, payload);
  const keys = await client.keys("auth:token:*");
  for (const key of keys) {
    if (key === `auth:token:${token}`) continue;
    const raw = await client.get(key);
    if (!raw) continue;
    let parsed: { tenantId?: unknown; source?: unknown } | null = null;
    try {
      parsed = JSON.parse(raw) as { tenantId?: unknown; source?: unknown };
    } catch {
      continue;
    }
    if (parsed?.source === "pth-operator" && parsed.tenantId === tenant) {
      try {
        await client.del(key);
      } catch {
        // 回收失败不阻断种入
      }
    }
  }
}
