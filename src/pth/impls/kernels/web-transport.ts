/**
 * web-transport.ts — 兼容 barrel（N29 Task 4 原入口）。
 *
 * 实际安全传输实现已迁移到 `src/pth/execution/network/safe-http-transport.ts`
 * （TCE 网络 V1 Wave 2：Execute 层拥有 egress/SSRF/限流等网络底座）。
 * 本文件保留旧 import 路径兼容，不再持有实现。
 */

export {
  WEB_MAX_BYTES,
  WEB_MAX_REDIRECTS,
  WEB_TIMEOUT_MS,
  WebTransportError,
  assertPublicLiteralHost,
  assertPublicResolvedAddresses,
  createWebLookupWithDohFallback,
  defaultDohLookup,
  defaultWebLookup,
  defaultWebRequest,
  isPrivateIpLiteral,
  isRedirectStatus,
  readWebBody,
  readWebBodyBytes,
  resolvePublicAddresses,
  secureWebFetch,
  type ResolvedAddress,
  type SecureFetchHopContext,
  type SecureFetchHopRecord,
  type SecureFetchOptions,
  type SecureFetchResult,
  type WebLookup,
  type WebLookupFallbackOptions,
  type WebRequest,
  type WebResponse,
  type WebTimerApi,
  type WebTransportErrorCode,
} from "../../execution/network/index.js";
