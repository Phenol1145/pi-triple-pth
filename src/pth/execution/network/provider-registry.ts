/**
 * execution/network/provider-registry.ts — ProviderRegistry（V1 最小实现）。
 *
 * 只做 adapter 身份/能力/profile 匹配；fallback 由 gateway 在“语义兼容”的
 * implementation 间执行，每次 attempt 留痕。
 */

import type {
  NetworkOperationContextV1,
  SearchRequestV1,
} from "@away_from/pth-contracts";
import type { SearchProvider } from "./types.js";

export interface ProviderRegistry {
  register(provider: SearchProvider): void;
  list(): readonly SearchProvider[];
  resolveForSearch(request: SearchRequestV1, ctx: NetworkOperationContextV1): readonly SearchProvider[];
}

export class DefaultProviderRegistry implements ProviderRegistry {
  private readonly providers = new Map<string, SearchProvider>();

  register(provider: SearchProvider): void {
    if (this.providers.has(provider.providerId)) {
      throw new Error(`provider ${provider.providerId} 已注册`);
    }
    this.providers.set(provider.providerId, provider);
  }

  list(): readonly SearchProvider[] {
    return [...this.providers.values()];
  }

  resolveForSearch(_request: SearchRequestV1, ctx: NetworkOperationContextV1): readonly SearchProvider[] {
    return this.list().filter(
      (p) =>
        p.supportedProfiles.includes(ctx.profileId as SearchProvider["supportedProfiles"][number]) &&
        p.capabilities.rawHits === true,
    );
  }
}
