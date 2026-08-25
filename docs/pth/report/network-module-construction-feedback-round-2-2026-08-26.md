# TCE 网络模块施工反馈报告（第二轮）

> 状态：**第一轮隔离问题已通过 `e48fca9` 修复；V1 可受控试运行，但 artifact 生命周期与生产 trace 落点仍需明确**  
> 日期：2026-08-26  
> 提交基线：`e48fca9`（`pi-triple-pth/main`，与 `origin/main` 对齐）  
> 检查范围：task-bound Execute gateway、ArtifactStore、trace identity、legacy projection、真实 provider smoke  
> 第一轮报告：[网络模块施工反馈报告](./network-module-construction-feedback-2026-08-26.md)  
> 架构报告：[网络信息基础设施 V1 架构报告](./network-information-foundation-v1-architecture-report-2026-08-26.md)  
> 关联设计：[TCE 网络模块重构设计](../design/tce-network-module-refactor-design.md)  
> TCE 约束：[ADR-0004：TCE 的 C 是 Code](../../adr/0004-tce-code-layer-ptc-capability-first.md)

## 0. 第二轮结论

第一轮报告指出两个生产边界问题：

1. `ArtifactStore` 实际是 worker scope，不同任务可共享同一内存 Map；
2. 生产默认上下文只盖 roleId，没有逐任务 taskId/tenantId。

提交 `e48fca9` 已针对这两点调整生产装配：

- `batch-process` 不再创建单一 worker 级 gateway，而是注入 `networkExecuteFactory`；
- LLM/PTC mode 按 task lease 创建 gateway；
- 每个 gateway 默认获得独立 `InMemoryArtifactStore` 和 `DefaultNetworkBudget`；
- default operation context 写入 taskId、tenantId、roleId；
- `net.search/fetch/extract` 和 legacy `web.fetchText` 都使用 task-bound client；
- trace entry 增加 task/tenant/role 字段；
- 新增 task scope 测试和 opt-in live smoke。

这说明第一轮发现确实被施工方吸收，网络模块已经从“基础链路完成但隔离不足”推进到“跨任务
隔离已收口”。不过第二轮审查发现两个更精确的边界：

> **当前 gateway 生命周期跟随一次 RoleRun/lease Attempt，而不是持久化 Task；同时生产默认 trace
> recorder 与 observability 仍是 no-op。**

因此，artifact 在同一次执行内安全可用，但任务因 retry、pause 或 required dependency 重跑后，旧
artifactRef 无法在新 gateway 中解析；trace 虽然拥有正确身份字段，生产却没有持久或可查询的 sink。

综合判断：

> **网络 V1 的 Tool→Code→Execute 基础链路和跨任务安全隔离已经达到受控试运行标准；合并已完成，
> 下一步应明确 artifact 是 attempt-scope 还是 task-scope，并把结构化 trace 接到生产观测面。复杂
> 深度研究逻辑仍应留到后续版本。**

## 1. 与第一轮反馈的对账

| 第一轮问题 | 第二轮状态 | 证据/说明 |
|---|---|---|
| worker 级 gateway 共享 ArtifactStore | 已修复跨任务共享 | `networkExecuteFactory` 每次执行创建 gateway/store |
| production 只盖 roleId | 已修复 | LLM/PTC mode 传入 taskId、tenantId、roleId |
| legacy `web.fetchText` 可能绕过 task client | 已修复 | task capability injection 重新投影到同一 task-bound client |
| trace 缺任务身份 | 已修复结构 | `NetworkTraceEntryV1` 与 `recordTrace()` 写入三方身份 |
| 无真实 provider smoke | 部分修复 | 增加 `PTH_NETWORK_LIVE_TEST=1` opt-in 测试，但本轮仍未执行 |
| acceptance 只有离线 fake | 仍存在 | 默认 CI 仍只证明 deterministic contract，不证明公网稳定性 |

第一轮报告的“artifact 隔离、task/tenant trace 盖章待收口”已不再准确，应保留为历史报告，由本
报告记录修复后的状态。

## 2. TCE 分层复核

### 2.1 Tool

模型能力索引继续使用：

- `net.search`；
- `net.fetch`；
- `net.extract`；
- legacy `web.fetchText` 兼容投影。

Tool 层只提供 schema、能力描述和索引入口，不直接发起网络请求，不持有 provider credential。

### 2.2 Code

Code 层通过 typed capability 组合底层动作：

```ts
const hits = await net.search({ query, limit });
const page = await net.fetch({ url: hits.hits[0].url });
const doc = await net.extract({ artifactRef: page.artifact.ref, mode: "main-content" });
```

查询展开、来源选择、循环停止、矛盾处理和报告综合继续由 LLM/Code 决定。V1 没有把固定研究流程
硬编码成 `deepResearch()` 高级工具，符合“底层服务放 Execute，Code 发挥能动性”的裁决。

### 2.3 Execute

Execute 继续集中拥有：

- OperationPolicy；
- NetworkBudget；
- ProviderRegistry；
- SafeHttpTransport；
- redirect/DNS/private-address 防护；
- raw-hit provider；
- bytes/artifact；
- offline extractor；
- redaction；
- trace entry。

这确保普通搜索、未来 intake 和未来 deep search 可以共享底层执行安全，而不必复制网络 I/O。

## 3. `e48fca9` 实际完成了什么

### 3.1 gateway/store 隔离

生产装配由：

```text
worker → one NetworkExecuteGateway
```

改为：

```text
worker
  → networkExecuteFactory(taskId, tenantId, roleId)
  → RoleRun-specific NetworkExecuteGateway
  → independent budget + InMemoryArtifactStore
```

任务 A 的 artifactRef 在任务 B 的 gateway 中读取会得到 `NET_ARTIFACT_MISMATCH`，不会因共享 Map
而发生跨任务内容泄漏。

### 3.2 身份盖章

`NetworkTraceEntryV1` 新增：

- `taskId`；
- `tenantId`；
- `roleId`。

这些字段来自 runner/task work scope，不由模型请求体自报。`recordTrace()` 在所有 search/fetch/
extract 成败路径上合并固定上下文。

### 3.3 legacy 路径收口

当角色仍持有 `web.fetchText` 时，task capability injection 会用当前 task-bound client 覆盖对应
binding，避免 legacy capability 使用另一个 worker 级 gateway。

### 3.4 live smoke

新增两个显式 opt-in 用例：

- 默认 raw-hit provider 搜索；
- 抓取 `example.com` 并保存 artifact。

测试默认跳过，只有设置 `PTH_NETWORK_LIVE_TEST=1` 时才访问真实网络。这一策略适合避免 CI 因
公网波动失败，但 release/试运行流程仍需主动执行。

## 4. 新发现：task scope 实际是 attempt scope

### 4.1 生命周期事实

factory 在 `runLlmAgentMode()` / `runPtcMode()` 中调用。一次 task 被 dependency、pause、retry 或
lease recovery 重新认领时，会再次调用 factory，并创建新的内存 store。

因此当前实际语义是：

```text
(tenantId, taskId, lease attempt) → gateway/store
```

不是：

```text
(tenantId, taskId) → store survives all task replays
```

### 4.2 影响

以下同一 Attempt 内链路正常：

```text
fetch → artifactRef → extract
```

以下跨 Attempt 链路不成立：

```text
Attempt #1 fetch
  → 任务因 dependency/pause 重跑
Attempt #2 extract(previous artifactRef)
  → NET_ARTIFACT_MISMATCH
```

这与第二轮任务逻辑的 replay-safe parent 机制直接相交：父任务可能在第一轮抓取资料、声明 child，
重跑后综合 child 结果；如果它希望复用第一轮 artifactRef，当前后端不能满足。

### 4.3 V1 可接受的两种边界

方案 A：明确命名为 attempt-scoped。

- 文档和类型不承诺跨重跑 artifact；
- Code 重跑时重新 fetch；
- 适合当前最小 V1，但网络内容可能变化，成本和确定性较弱。

方案 B：提供可跨 Attempt 的 task artifact backend。

- key 至少包含 tenantId/taskId/artifactId；
- Task 终态后按 retention policy 回收；
- 进程重启仍可恢复时需要 object store 或受限持久后端；
- 不建议把任意网页大正文全部塞进 PG。

当前版本可以先选择 A，但必须把注释中的“task-scoped”改成真实语义；如果 persistent child
delegation 要在 V1 中与网络 artifact 组合，则应优先选择 B 的最小实现。

## 5. 新发现：生产 trace 没有落点

### 5.1 当前行为

`NetworkExecuteGateway` 在未注入依赖时使用：

- `createNoopNetworkTraceRecorder()`；
- `NoopNetworkObservability()`。

生产 `networkExecuteFactory` 只传 `defaultContext`，没有传 recorder/observability。因此：

- operationId 和身份字段会在内存对象中构造；
- 测试注入 `InMemoryNetworkTraceRecorder` 时可以查询；
- 默认生产执行不会将 trace 送到日志、metrics、PG 或 observation timeline。

### 5.2 影响

目前无法从生产观测面回答：

- 某个 task 发起了哪些 search/fetch；
- 使用了哪个 provider implementation/version；
- 哪次操作被 policy、budget 或 SSRF 防护拒绝；
- 某个 artifact 是由哪个 operation 产生；
- provider 失败率和 latency 如何。

身份盖章已经正确，但只有接入 sink 后才形成完整审计链。

### 5.3 建议

V1 不必引入复杂研究数据库。可以先：

1. 将 trace entry 写入现有 structured logger/timeline；
2. 将低基数字段汇总进 Prometheus；
3. 对 query 继续只保存 redacted/hash 版本；
4. artifact 正文不进入 trace；
5. provider、implementation、task、tenant、role、duration、errorCode 形成最小可查询面。

## 6. 安全与信息源控制

### 6.1 当前 V1 的信任语义

raw-hit provider 返回的公开网页统一标记：

```text
trust = public-untrusted
```

discovery provider 与 publisher origin 分离，避免把“搜索服务返回了该链接”误解成“搜索服务为
网页内容背书”。这一点应保持。

### 6.2 Search / Intake / Deep Search 边界

当前只实现基础 Search/Fetch/Extract，不实现三类流程的高层策略：

| 模式 | V1 当前能力 | 后续额外要求 |
|---|---|---|
| 普通搜索 | raw hits + fetch/extract | 低成本、快速停止、public-untrusted 默认 |
| Intake | 尚未实现流程 | allowlist、内容隔离、schema 验证、人工/策略门 |
| Deep Search | 尚未实现流程 | 多轮规划、来源多样性、权威等级、交叉验证、证据绑定 |

三者可以共享 Execute 安全底座，但不能共享完全相同的 source policy。V1 继续不实现复杂研究逻辑是
正确的；后续应由 profile/policy 参数化，而不是复制三个网络执行器。

### 6.3 当前 provider 广度

默认只有 DuckDuckGo HTML raw-hit adapter。它适合作为无 key 的 V1 冒烟源，不足以支撑高广度、
高可靠的复杂检索：

- 单一上游故障无真正 fallback；
- HTML 页面结构变化会影响解析；
- 反自动化、地区和语言覆盖不可控；
- 没有官方 API/垂直学术/新闻/监管源组合；
- 没有 source profile 与 authority policy。

这些属于后续 provider 扩展，不阻断基础 V1，但“复杂网络检索”不能基于当前单源实现宣称完成。

## 7. 存储后端意见

继续不建议“所有网络信息都进 PG”。推荐边界：

| 数据 | V1/后续后端 |
|---|---|
| task、operation metadata、trace index | PG 或现有 observation store |
| bounded summary、provenance、artifact manifest | PG |
| 同一 Attempt 的临时网页 bytes | 内存 ArtifactStore |
| 跨 Attempt/重启的大正文和二进制 | object store/内容寻址存储 |
| embedding/检索索引 | 独立索引层，PG 只存关联 metadata |

统一事实模型不等于统一物理存储。PG 适合事务和索引，不适合承载所有网页原始内容。

## 8. 测试与证据

本轮定向测试结果：

```text
7 test files passed
1 test file skipped
34 tests passed
2 live tests skipped
```

覆盖：

- net contract；
- gateway search/fetch/extract；
- Wave 4 redaction/observability；
- V1 acceptance matrix；
- 独立 gateway artifact 隔离；
- trace task/tenant/role 字段；
- typed capability projection；
- legacy `web.fetchText` binding。

未覆盖：

- `networkExecuteFactory` 从 TaskLoop 到 LLM/PTC 的真实装配集成；
- 同一 task 跨 retry/requeue 的 artifact 生命周期；
- production trace sink；
- 真实 DuckDuckGo/provider smoke；
- 真实 DNS、redirect、rate limit 和地区网络条件；
- 多 provider fallback 与来源多样性。

此外，PTH 完整 `npm run lint`、boundary、import cycle、TCE coverage、docs links 和
`git diff --check` 均通过。

## 9. 建议施工顺序

### P1：冻结 artifact 生命周期语义

1. 增加“同 task 不同 lease Attempt”的回归测试；
2. 明确 V1 是 attempt-scope 还是 task-scope；
3. 若保持 attempt-scope，修正文档、类型注释和错误提示；
4. 若需要与 persistent delegation 组合，提供最小 durable artifact port；
5. 无论选择哪种，都保留 tenant/task 隔离测试。

### P1：接入生产 trace

1. 为 batch production factory 注入 recorder/observability adapter；
2. 将 network operation 送入现有 timeline/logger；
3. 为 provider/error/latency 增加聚合指标；
4. 验证 query redaction 后再启用持久记录；
5. 增加生产装配测试，而不是只手工构造 gateway。

### P1：执行 live smoke

1. 在显式联网环境运行 `PTH_NETWORK_LIVE_TEST=1`；
2. 记录 provider、地区、成功率和耗时；
3. 将 smoke 纳入 release checklist，不放入每次离线 CI；
4. 失败时区分 provider 不可用、DNS、SSRF policy、timeout 与解析变化。

### P2：后续 provider 广度

1. 将 ProviderRegistry 接入可配置 provider；
2. 增加官方 API 和垂直源 adapter；
3. 为普通 search/intake/deep search 定义不同 source profile；
4. 等底层多源稳定后再实现复杂研究循环。

## 10. 合并与试运行门槛

`e48fca9` 本身已进入主干；下一阶段试运行至少应满足：

- [x] 不同任务不共享内存 ArtifactStore；
- [x] taskId/tenantId/roleId 由服务端上下文盖章；
- [x] legacy `web.fetchText` 使用 task-bound gateway；
- [x] 离线 deterministic acceptance 通过；
- [ ] artifact scope 文档与真实生命周期一致；
- [ ] 有生产 trace/observability sink；
- [ ] factory 装配有集成测试；
- [ ] live provider smoke 至少成功一次并留有记录；
- [ ] 与 persistent child delegation 的跨 Attempt artifact 行为已裁决。

本轮仍不要求：

- Deep Research planner；
- 多 Agent 研究编排；
- 自动权威性裁判；
- 长报告生成器；
- 全量网页归档；
- 将所有内容存入 PG。

## 11. 最终意见

网络模块继续是三个施工大类中成熟度最高的一项。第一轮指出的跨任务隔离和身份盖章已经得到
直接修复，证明当前 TCE 分层能够支撑快速迭代。

第二轮应避免把“新建 gateway”简单等同于“持久化 task scope”，也不要把“trace entry 含身份”
等同于“生产 trace 已可观测”。把这两个语义说清、接通最小生产观测，并完成一次真实 provider
smoke 后，网络 V1 就可以作为后续高深度、高广度检索的可靠 Execute 底座。
