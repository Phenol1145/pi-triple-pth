# TCE 网络 V1 真实 Provider Smoke 记录

> 日期：2026-08-26  
> 命令：`PTH_NETWORK_LIVE_TEST=1 npm test -- test/pth-execution/network-live-smoke.test.ts`  
> 提交基线：`e48fca9` + 第二轮施工（attempt-scope 语义、生产 trace/metrics adapter、raw-hit UA 修正）

## 结果

| 用例 | 结果 | 耗时 | 说明 |
|---|---|---|---|
| `net.search` 默认 raw-hit provider | ✅ 通过 | ~1.7s | provider=`duckduckgo-html`；返回结构化 raw hits |
| `net.fetch` 抓取 `https://example.com` | ✅ 通过 | ~0.6s | 保存 artifact，sha256 长度 64 |

综合成功率：**2/2**。

## 环境说明

- 网络出口：本机默认公网出口（未固定地区；DuckDuckGo HTML 端点对地区/反自动化敏感）。
- 首次运行 `net.search` 曾因 HTTP 202 失败；为降低 raw-hit HTML 端点的自动化拒绝概率，
  已将默认 provider 请求头补为最小浏览器特征（UA/Accept/Accept-Language），
  不携带任何凭据或 cookie。
- `net.fetch` 使用 HTTPS-only 安全传输，未触发 SSRF/DNS 防护。

## 与第二轮门槛的对账

- [x] live provider smoke 至少成功一次并留有记录（本文件）。
- [x] provider、成功率、耗时已记录。
- [ ] 多地区/多 provider fallback 仍属后续 P2，不在 V1 承诺内。
