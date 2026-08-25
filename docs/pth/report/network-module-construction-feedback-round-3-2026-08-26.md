# TCE 网络模块施工反馈报告（第三轮验收）

> 状态：**基础功能通过；生产装配、观测和 live smoke 已闭环，但 ArtifactRef 的 retention 契约仍与 Attempt 生命周期不一致**
> 日期：2026-08-26
> 验收基线：`de69854`（已在 `origin/main`）
> 检查范围：TCE 分层、lease-attempt gateway、ArtifactStore、生产 trace/metrics、query redaction、真实 provider smoke、文档与交付状态
> 第二轮报告：[TCE 网络模块施工反馈报告（第二轮）](./network-module-construction-feedback-round-2-2026-08-26.md)
> 架构报告：[网络信息基础设施 V1 架构报告](./network-information-foundation-v1-architecture-report-2026-08-26.md)
> 关联设计：[TCE 网络模块重构设计](../design/tce-network-module-refactor-design.md)

## 0. 第三轮结论

第二轮剩余的三项主要工作已经完成：

- lifecycle 已明确冻结为 **lease Attempt scope**；
- 生产 factory 已注入 structured logger trace 与 IPC/Prometheus metrics；
- 本轮重新执行真实 DuckDuckGo HTML search 和 `example.com` fetch，2/2 通过。

同时，既有 taskId/tenantId/roleId 盖章、跨 gateway artifact 隔离、legacy `web.fetchText` 收口和
离线 deterministic acceptance 均保持通过。复杂研究规划、来源权威性裁决和多源深度检索没有被
提前塞进 Execute V1，符合“底层服务在 Execute，Code 负责组织”的定位。

第三轮仍发现一个跨契约语义问题：

> **实现与文档声明 artifact 是 lease-attempt-scoped，`net.fetch` 返回的 `ArtifactRefV1` 却继续标记
> `retentionClass: "task"`。调用方只看 typed contract 会合理地推断引用至少在 Task 生命周期内可用，
> 但 retry/pause/requeue 后的新 gateway 实际无法解析它。**

因此本轮给出分层结论：

- **基础网络 Execute：通过；**
- **受控试运行：可以继续；**
- **ArtifactRef 契约完全闭环：未通过，需把 retention class 改为 `ephemeral` 或重新定义并实现
  `task` 的持久语义；**
- **复杂、高深度/高广度检索：仍属后续版本，当前没有宣称完成。**

## 1. TCE 分层复核

### 1.1 Tool

Tool/能力索引暴露：

- `net.search`；
- `net.fetch`；
- `net.extract`；
- legacy `web.fetchText` 兼容投影。

Tool 只描述 schema、能力和安全语义，不持有 provider credential，不直接实现 HTTP。

### 1.2 Code

Code 可以通过普通语言结构组合：

```ts
const hits = await net.search({ query, limit: 5 });
const page = await net.fetch({ url: hits.hits[0].url });
const text = await net.extract({ artifactRef: page.artifact.ref, mode: "main-content" });
```

查询展开、来源多样性、追踪线索、交叉验证、停止条件和最终报告仍由 LLM/Code 决定。V1 没有加入
高层 `deepResearch()` 固定流程。

### 1.3 Execute

Execute 继续集中拥有：

- ProviderRegistry；
- OperationPolicy；
- NetworkBudget；
- SafeHttpTransport；
- HTTPS、DNS、redirect、private-address 和 size/timeout 防护；
- raw-hit provider；
- bytes/artifact store；
- offline extractor；
- trace、redaction 与 observability。

这套边界可被普通搜索、后续 intake 和后续 deep search 复用，但三者的 source policy 不应相同。

## 2. 第二轮门槛对账

| 第二轮门槛 | 第三轮状态 | 证据与判断 |
|---|---|---|
| 不同任务不共享 ArtifactStore | **通过** | 每 lease Attempt 新建 gateway/store；隔离测试通过 |
| task/tenant/role 服务端盖章 | **通过** | defaultContext 来自 runner/task scope，不由请求体自报 |
| legacy fetch 使用同一 task-bound gateway | **通过** | capability injection 继续走当前 client |
| artifact scope 与真实生命周期一致 | **部分通过** | 文档/注释/错误消息已写明 Attempt scope；typed ref 仍写 `retentionClass: task` |
| 生产 trace/observability sink | **通过** | logger trace + IPC metric + 主进程 Prometheus 聚合 |
| factory 装配测试 | **通过** | recorder/observability/defaultContext injection 有测试 |
| live provider smoke | **通过** | 本轮重新实跑 search/fetch 2/2 |
| 与 persistent delegation 的跨 Attempt 行为已裁决 | **通过设计裁决** | 跨 Attempt 不复用 ref；Code 重跑时重新 fetch，durable port 后置 |

## 3. 生产装配与观测

### 3.1 Attempt 级 factory

`createTaskNetworkExecuteGatewayFactory()` 按 `{taskId, tenantId, roleId}` 创建独立 gateway，内部默认
拥有独立 budget 与 `InMemoryArtifactStore`。retry、pause、dependency replay 或 lease recovery 会
创建新实例。

### 3.2 structured trace

logger recorder 记录：

- operationId；
- operation kind/profile；
- task/tenant/role；
- provider、publisher、processor；
- duration、bytes、billable units；
- error code；
- artifactId；
- redacted query/final URL。

原始网页正文不进入 trace，敏感 URL 参数会被脱敏。

### 3.3 metrics

batch 通过 IPC 发出 operation metric，主进程只用固定低基数维度聚合：

- kind/ok；
- kind/error code；
- kind/duration；
- kind/bytes；
- total billable units。

taskId、tenantId、roleId 和 providerIds 虽可随 IPC 明细传输，但没有进入 Prometheus label，避免高
基数爆炸。

## 4. P1：retention class 与实际生命周期矛盾

### 4.1 当前事实

实现明确是：

```text
(tenantId, taskId, lease generation) → InMemoryArtifactStore
```

同 task 的下一次 Attempt 无法读取旧 ref，测试预期为 `NET_ARTIFACT_MISMATCH`。

但 `NetworkExecuteGateway.fetch()` 明确传入：

```ts
retentionClass: "task"
```

`InMemoryArtifactStore` 的默认值也仍是 `task`。

### 4.2 为什么文档说明不足以消除问题

`ArtifactRefV1` 是 Code 与 Execute 之间的 typed contract。Code/LLM、未来 consumer 或跨包 adapter
不一定读取实现注释；它们会根据 `retentionClass` 判断引用何时仍有效。

如果 `task` 不承诺 Task 生命周期，字段名失去可操作含义；如果承诺，则当前 store 没有实现该承诺。

### 4.3 建议

V1 最小改法：

1. Attempt 内存产物返回 `retentionClass: "ephemeral"`；
2. contract 文档明确 `ephemeral` 最长不超过当前 lease Attempt；
3. `task` 只保留给可跨 Attempt、至少覆盖任务重放的 backend；
4. 更新 fixtures 与 fetch/assertion 测试；
5. 若未来实现 durable task artifact，key 至少绑定 tenantId/taskId/artifactId，并验证 hash/length。

不建议为了修字段语义就把网页 bytes 塞入 PG。

## 5. 真实 provider smoke

本轮重新执行：

```text
PTH_NETWORK_LIVE_TEST=1 npm test -- test/pth-execution/network-live-smoke.test.ts
```

结果：

| 用例 | 结果 | 本轮耗时 |
|---|---:|---:|
| DuckDuckGo HTML raw-hit search | 通过 | 约 1.63s |
| `https://example.com` fetch + artifact | 通过 | 约 0.61s |

总计 2/2。该结果证明当前出口和 provider 在本轮可用，不代表长期 SLA、地区覆盖或 HTML 结构稳定。

## 6. 信息源与复杂检索定位

当前默认只有一个 DuckDuckGo HTML raw-hit adapter，所有公开结果仍按 `public-untrusted` 处理；
provider 与 publisher identity 分离。这足以作为基础发现源，但不等于高深度、高广度检索已经完成。

后续建议仍保持：

- 普通 Search：低成本、快速停止、公开不受信源；
- Intake：allowlist、许可、内容隔离、schema、人工/策略门；
- Deep Search：多 provider/垂直源、来源多样性、权威层级、交叉验证、Claim–Evidence 绑定；
- 上述差异通过 profile/policy 实现，不复制网络执行器；
- 研究规划和循环留在 Code/Agent 应用，不硬编码进 Execute。

## 7. 存储边界复核

本轮没有把所有网络内容统一塞进 PG，边界保持合理：

| 数据 | 建议后端 |
|---|---|
| operation/task metadata、manifest、bounded provenance | PG/现有 observation store |
| 当前 Attempt 临时网页 bytes | 内存 ArtifactStore |
| 跨 Attempt/重启的大正文与二进制 | object/content-addressed store |
| embedding/全文检索索引 | 独立索引层，PG 保存关联 metadata |

## 8. 验证证据

离线网络与 Provider/CLI 组合定向测试中，网络相关文件全部通过；单列网络结果为：

```text
network-gateway                 10 passed
network-wave4                   4 passed
network-task-scope              3 passed
network-production-adapters     3 passed
network-v1-acceptance           5 passed
live smoke                      2 passed（本轮显式联网）
```

此外 PTH 完整 lint、boundary、import cycle、config、role conservation、product boundary、TCE coverage、
docs links 均通过。

## 9. 交付与工作树状态

网络代码和生命周期文档已经进入 `origin/main` 的 `5ecdbe1`/`de69854`。但以下两份历史反馈报告在
本轮检查时仍为 untracked：

- `network-module-construction-feedback-2026-08-26.md`；
- `network-module-construction-feedback-round-2-2026-08-26.md`。

`docs/docs-manifest.json` 已引用这些路径。正式交付前应把报告纳入提交，避免 manifest 指向未随仓库
交付的文件。

## 10. 第三轮通过门槛

- [x] task/tenant/role 服务端盖章；
- [x] gateway/store 跨 Attempt 隔离明确；
- [x] production trace 与 Prometheus 聚合接线；
- [x] query/URL redaction 测试；
- [x] live search/fetch 2/2；
- [ ] Attempt 级产物不再标记为 `retentionClass: task`；
- [ ] 对应 contract/fixture/test 同步；
- [ ] untracked 历史网络报告纳入正式提交。

## 11. 最终意见

网络模块仍是三个施工类别中最成熟的一项。基础 Tool→Code→Execute 链路、隔离、安全运输、生产
观测和真实 provider 冒烟都已达到 V1 受控试运行标准。

下一步不应提前实现复杂研究 Agent；先把 `retentionClass` 与真实 Attempt 生命周期对齐，并收口
文档交付。之后再通过可配置 ProviderRegistry 与 source profiles 扩展深度和广度。
