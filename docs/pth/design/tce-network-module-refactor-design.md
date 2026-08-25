# TCE 网络信息基础设施 V1 实施设计

> 状态：**Wave 0-4 已实施；Wave 5 验收/文档收尾中**
> 日期：2026-08-26
> 上位约束：[ADR-0004：TCE 的 C 是 Code](../../adr/0004-tce-code-layer-ptc-capability-first.md)
> 权威范围：[PTH 网络信息基础设施 V1 架构报告](../report/network-information-foundation-v1-architecture-report-2026-08-26.md)
> 本文取代先前 `tce-network-module-refactor-design.md` 草案；实施时以 V1 架构报告为范围裁决，本文只做落地映射。

## 1. 范围

### 1.1 V1 核心

- `net.search`：一次有界、provider-neutral 的公开网络/垂直检索；
- `net.fetch`：一次有界、安全的公开 URL GET，返回 raw artifact 引用；
- `net.extract`：对已有 artifact 做无网络、确定性的正文/元数据/链接解析。

### 1.2 V1 明确不做

- 不注册 `net.read` 能力；“读取网页”只是 `net.fetch → net.extract` 的 Code 配方；
- 不实现 `net.deepSearch`、ResearchPlanner、SearchFrontier、EvidenceLedger、多 Agent；
- 不接通 Search/Research → Intake；
- 不把 `source-discovery` / `auto-expansion` 接入生产装配；
- 不暴露通用 `exec(cmd,args)` / `httpGet(url)` 给 agent。

### 1.3 V1-B（延后，不阻塞核心）

- `net.download`（yt-dlp，固定 argv，默认不注入）；
- `net.doctor` / `net.checkUpdate`（admin/health capability）；
- GitHub / B 站 / V2EX 等垂直 provider。

## 2. 分层架构

```text
Tool：net.search / net.fetch / net.extract tool schema
  ↓ 投影为代码
Code：PTC orchestration runtime（kernel-ts, engine-internal）
  ├─ 静态审核：called capabilities ⊆ role grants
  ├─ 持久任务状态
  └─ 已授权 typed proxy（无 socket/credential/任意进程）
  ↓ reviewed operation + grant
Execute：NetworkProviderGateway
  ├─ OperationPolicy / Budget / Retention
  ├─ ProviderRegistry / SourcePolicy
  ├─ SearchProvider adapter
  ├─ SafeHttpTransport / Fetch adapter
  ├─ offline Extractor adapter
  ├─ fixed-template ExternalTool adapter
  └─ Trace / ArtifactStore / structured errors
  ↓
公开搜索 API、公开站点、受控工具容器
```

### 2.1 职责边界

| 层 | 拥有 | 不拥有 |
|---|---|---|
| Tool | 能力发现、schema 投影、兼容别名 | 真实执行、provider 品牌、凭据 |
| Code | PTC 状态、控制流、静态审核、typed proxy | 网络 socket、DNS、provider key、任意进程 |
| Execute | egress、SSRF、限流、重试、provider、解析、artifact、trace | 研究策略、来源信任、Intake 写入 |

## 3. 与旧草案的关键修正

| 旧草案 | V1 对齐后 |
|---|---|
| `PtcCapabilityHost` 增加 `external-tool` 表示路由 | 拆为 **`codeHost`**（proxy 在哪个编排 runtime 可用）与 **Execute binding**（实际发往哪个 Execute service / target） |
| `net.read` 作为能力 | 不注册；`fetch + extract` 透明 Code 配方 |
| `createNetworkCapability` 接受 `httpGet/exec` | 注入 typed ports / `NetworkExecuteClient`，禁止任意命令与任意 URL 通道 |
| provider 品牌写在能力契约 | 契约 provider-neutral；品牌只在 adapter registry/config |
| Exa→jina 自动 fallback | 仅在语义兼容 implementation 间 fallback，每次 attempt 留痕 |
| `web.fetchText` 作为 `net.fetch` 别名 | legacy implementation binding + 独立 deprecation policy；新 `net.fetch` 默认 HTTPS-only |
| 统一 `AgentToolResult` | search/fetch/extract 使用版本化 discriminated result |
| Search 结果可能进入 Intake | 类型隔离；V1 不提供 Search→Intake 隐式转换 |

## 4. 契约与能力定义

### 4.1 版本化 wire contracts

新增 `packages/pth-contracts/src/network-information.ts`，包含：

- `SearchRequestV1` / `SearchHitV1` / `SearchResponseV1`
- `FetchRequestV1` / `ArtifactRefV1` / `FetchResponseV1`
- `ExtractRequestV1` / `ExtractedDocumentV1`
- `NetworkOperationContextV1`
- `ProviderAttemptV1`
- 结构化错误码（`NET_CAPABILITY_DENIED`、`NET_POLICY_DENIED`、`NET_PRIVATE_ADDRESS` 等）

关键不变量：

- `queryDigest` 而非完整 query 进普通日志；
- `discovery.providerId` 与 `publisher.origin` 分离；
- `trust` 固定为 `public-untrusted` / `processed-untrusted`；
- `ArtifactRefV1` 从 V1 起稳定，未来可切换对象存储。

### 4.2 PTC 能力注册

在 `PTC_CAPABILITIES` 增加 `net` family：

| 能力 | 签名 | codeHost | Execute binding |
|---|---|---|---|
| `net.search` | `(query, opts?)` | `kernel-ts` | `execute-service:network-broker` |
| `net.fetch` | `(url, opts?)` | `kernel-ts` | `execute-service:network-broker` |
| `net.extract` | `(artifactRef, opts?)` | `kernel-ts` | `execute-service:extractor` |

扩展 `PtcCapabilityDef`（或由 contracts canonical record 单向生成）：

- `contractVersion`
- `effect: "pure" | "read-external" | "write-artifact" | "admin"`
- `discoveryChannels: { ptc, tool, prompt }`
- `codeHost`
- `toolSchema`

`PTC_CAPABILITIES` 仍是 Tool/Code 单一事实源；`CapabilityImplementation` / `ExecuteServiceDefinition` 是 Execute 路由事实源。

### 4.3 静态审核

- `surface.ts` 识别 `net.search()` / `net.fetch()` / `net.extract()`；
- 角色 grant 只允许 exact capability ID 或已声明 family grant；
- 未知、歧义、alias 冲突必须 CI 失败；
- 未授权调用在 Execute/provider 调用前被拒绝，backing call 数为 0。

## 5. Execute 网络基础服务

### 5.1 组件

| 组件 | 位置 | 职责 |
|---|---|---|
| `NetworkExecuteGateway` | `src/pth/execution/network/gateway.ts` | 接收 typed request，执行 policy/budget/routing |
| `SafeHttpTransport` | `src/pth/execution/network/safe-http-transport.ts` | 从 kernel 路径迁移 ownership；保留旧 import barrel 兼容 |
| `SearchProvider` adapters | `src/pth/execution/network/providers/*` | 每个 provider typed、可替换、无品牌进入契约 |
| `Extractor` adapters | `src/pth/execution/network/extractors/*` | 默认离线、无二次网络、确定性 output hash |
| `ArtifactStore` adapters | `src/pth/execution/network/artifacts/*` | V1 task-scoped + PG-inline，未来 object |
| `ProviderRegistry` / `OperationPolicy` / `Budget` | `src/pth/execution/network/*` | provider 身份、版本、配额、预算、retention |

### 5.2 安全底线

- 所有 URL 在 provider/socket 调用前做 userinfo、scheme、DNS/IP、internal suffix、敏感 query 检查；
- 每次 redirect 重新校验；
- 超限响应不产生完整 artifact，返回 `NET_SIZE_LIMIT`；
- provider error/doctor/trace 不泄露 key、Authorization、cookie 或完整敏感 query。

## 6. 注入与授权

- `buildCapabilities`：将 `web` 对象迁移为 `net` typed proxy；`web.fetchText` 保留 legacy binding；
- `task-capability-inject.ts`：按角色 `capabilities` 方法级注入 `net.search/fetch/extract`；
- 未声明即“不存在”，不进入能力索引；
- `net.download` / `net.doctor` / `net.checkUpdate` 默认不注入，V1-B 再启用。

## 7. 兼容迁移

| 旧入口 | V1 归宿 |
|---|---|
| `web.fetchText` | legacy implementation binding，复用同一 fetch port + deprecation policy；新 `net.fetch` 默认 HTTPS-only |
| `web.get` | Tool→Code 投影到 `net.fetch`，不保留独立执行体 |
| `reach.webSearch` | Tool→Code 投影到 `net.search` |
| `reach.webRead` | 静态审核前展开为 `net.fetch` + `net.extract`；要求两个 grant |
| `reach.ghSearch` / `biliSearch` / `v2exHot` | V1-B 垂直 provider；未迁移前显式标记 legacy |
| `yt-dlp` | V1-B `net.download`，固定 argv、默认不注入 |
| `reach.doctor` / `checkUpdate` | V1-B admin capability |

兼容分支由服务端冻结的 implementation binding 选择，LLM 参数面不能出现 `legacy/allowHttp/compatibilityMode` 等开关。

## 8. Search / Research / Intake 边界

- V1 只启用 `search-public` profile；
- `research-public` 仅冻结名称与安全边界，部署策略 unavailable；
- `intake-authorized` 只是 Intake 内部 trace 分类，不能由 `net.*` 请求选择；
- Intake 继续走 N29 内环：人类签名 Trust Policy → Subscription → quarantine → revision → 双核验 → CAS promotion；
- `source-discovery` / `auto-expansion` 保持 feature-off，不纳入 V1 完成度。

## 9. 存储

| 数据 | V1 存储 |
|---|---|
| task/role/grant/policy/trace | PostgreSQL |
| SearchResponse | 默认不持久化全文；随 task result 或短期 trace |
| 普通 Search/Research raw page | task-scoped ephemeral ArtifactStore；PG 只存 manifest |
| Intake 小型有界 raw HTML/text | 继续 PG `BYTEA` |
| 大 PDF/图片/音视频 | V1 拒绝/延后，未来 Object Store |

从 V1 起统一返回 `ArtifactRefV1`，内容寻址、不可变、可重算 hash。

## 10. 实施 Wave

### Wave 0：文档与边界校正

- 将 `kernel-ts` 定义为 PTC orchestration runtime；
- 旧 `PtcCapabilityHost` 迁移/改名为 `codeHost`，另建 Execute binding；
- 冻结 `search-public` / `research-public` / Intake trace 分类；
- `source-discovery` / `auto-expansion` 标记为实验骨架并保持关闭；
- 收口 toolstore `agent-reach` 与 secrets CLI 两条旧路径。

### Wave 1：契约与 Catalog

- contracts 增加 Search/Fetch/Extract/Artifact/Trace/Error 类型；
- `PTC_CAPABILITIES` 增加 `net` family 三个核心能力；
- 定义 `CapabilityImplementation` / `ExecuteServiceDefinition` / TS invocation binding；
- 从同一事实源生成 by-capability 与“TS 可调用能力”文档；
- 用 fake Execute client 完成 contract/projection/static audit/injection 测试。

### Wave 2：Execute 网络基础服务

- 安全传输 ownership 移到 Execute 公共底座；
- 实现 `NetworkExecuteGateway`、OperationPolicy、Budget、ProviderRegistry；
- 接一个 raw-hit SearchProvider；
- 实现 `net.fetch` public profile；
- 接无网络 deterministic extractor；
- 实现 task-scoped ArtifactStore adapter 与结构化 trace。

### Wave 3：兼容投影与零散能力收编

- `web.get` / `reach.*` 变为 Code projection；
- `reach.webRead` 展开为 `fetch + extract`；
- `web.fetchText` 进入 legacy implementation binding；
- 更新 role/prompt 为精确 `net.*` grants；
- 评估 GitHub/B 站/V2EX adapter；`yt-dlp` 保持固定 argv。

### Wave 4：策略、来源与可观测

- provider/source/egress/budget/retention policy；
- provider/publisher/processor 三方留痕；
- query redaction、敏感输入拒绝、凭据泄漏回归；
- attempts/partial/stopReason/bytes/latency/billable units 观测；
- Search/Research→Intake 类型隔离测试。

### Wave 5：验收与文档收尾

- TCE coverage 纳入所有 `net.*` 与 legacy projection；
- 更新 concepts/architecture/module ownership/execution topology；
- 跑 V1 acceptance matrix；
- 记录基准：Code proxy 固定开销、provider 延迟、extract 吞吐、artifact 大小。

## 11. 文件落点

| 责任 | 建议位置 |
|---|---|
| wire/domain contracts | `packages/pth-contracts/src/network-information.ts` |
| PTC capability definitions | `packages/pth-kernel-interpreter/src/ptc/contract.ts` |
| capability binding contracts | `packages/pth-contracts/src/capability-catalog.ts` |
| Code typed proxy | `packages/pth-kernel-execution/src/execution/ptc/capabilities/network-proxy.ts` |
| Execute gateway | `src/pth/execution/network/gateway.ts` |
| provider adapters | `src/pth/execution/network/providers/*` |
| safe transport | `src/pth/execution/network/safe-http-transport.ts` |
| extractor adapters | `src/pth/execution/network/extractors/*` |
| artifact adapters | `src/pth/execution/network/artifacts/*` |
| task injection | `src/pth/runner/exec-modes/task-capability-inject.ts` |

目录名是实施建议，实际提交前按 package boundary 检查器确认依赖方向。

## 12. 验收标准（V1）

1. `net.*` tool schema 全部从 `PTC_CAPABILITIES` 派生；
2. role 未声明 `net.search` 时静态审核失败，Execute/provider 调用数为 0；
3. 一个真实 raw-hit provider 返回符合 `net.search.response/v1` 的结果；
4. provider 空/限流/超时/认证失败分别有可区分 attempt/status；
5. `net.fetch` 保存 final URL、redirect chain、media type、hash、byteLength；
6. 超限响应不产生完整 artifact；
7. `net.extract` 对同一 artifact/hash/processor 产生相同 output hash，且不发起网络；
8. `reach.webRead` 投影在静态审核前展开为 `fetch + extract`，缺少任一 grant 都失败；
9. Search/Research 类型不能传给 Intake EvidenceReference 校验器；
10. `npm run lint`、`npm test`、`npm run build` 全绿。

## 13. 非目标防膨胀

V1 代码中不应出现：

- `DeepSearchService` / 自动 `ResearchPlanner` / 多 Agent supervisor；
- success-count source trust；
- SearchResult 直接转 official/candidate；
- 未实现语义的 `coverageScore=1` / `complete=true`；
- 用 provider fallback 数量冒充“来源交叉验证”。
