# TCE 网络模块施工反馈报告

> 状态：**V1 基础能力已进入主干；可试运行，生产隔离与真实 provider 验收仍需收口**  
> 日期：2026-08-26  
> 提交基线：`cd40af0`（`pi-triple-pth/main`，与 `origin/main` 对齐）  
> 检查范围：`net.search`、`net.fetch`、`net.extract`、Execute 网络网关、安全传输、来源策略、artifact、trace 与 legacy 投影  
> 上位约束：[ADR-0004：TCE 的 C 是 Code](../../adr/0004-tce-code-layer-ptc-capability-first.md)  
> 关联设计：[TCE 网络信息基础设施 V1 实施设计](../design/tce-network-module-refactor-design.md)  
> 架构范围：[网络信息基础设施 V1 架构报告](./network-information-foundation-v1-architecture-report-2026-08-26.md)

## 0. 执行摘要

网络模块是本轮三个大类中成熟度最高的一项。2026-08-26 凌晨已经连续提交 Wave 0–5：

| 提交 | 内容 |
|---|---|
| `28fa3c7` | Wave 0+1：`net.*` 契约、能力目录、typed proxy |
| `e46c29e` | Wave 2：Execute gateway、安全传输、raw-hit provider、离线 extractor、artifact store |
| `3aff350` | Wave 3：legacy 投影、`web.fetchText` binding、角色迁移 |
| `2c8243d` | Wave 3 修复：capability index 与 N28 fake client |
| `1eb0dae` | Wave 4：敏感输入、redaction、observability、三方身份、类型隔离 |
| `cd40af0` | Wave 5：确定性 acceptance matrix 与设计文档状态收尾 |

当前已经形成符合 TCE 契约的基础链路：

```text
Tool schema
  → 投影为 net.* Code
  → 静态审核与按角色注入 typed proxy
  → Execute NetworkExecuteGateway
  → policy / budget / provider / safe transport / extractor / artifact / trace
```

这条实现满足此前确定的两个核心意图：

1. 网络底层能力放在 Execute 层，Code 只做组合，能够发挥 LLM 的动态规划和语言控制流；
2. V1 不把复杂研究逻辑固化为新的高级工具，为未来高深度、高广度检索保留组合空间。

定向验收共 6 个文件、32 个测试全部通过，仓库 lint 和 build 也通过。但当前仍存在两个生产边界
问题：artifact 实际是 worker scope 而不是严格 task scope；生产注入只稳定写入 roleId，没有逐任务
写入 taskId/tenantId。另有一个验收层面的限制：Wave 5 是完全离线、确定性的 fake provider 测试，
尚不能替代真实 provider 和真实网络条件下的试运行。

因此，本报告给出的状态是：

> **网络 V1 基础能力已完成并可进入受控试运行；在 artifact 隔离、task/tenant trace 盖章和真实
> provider 冒烟完成前，不宜宣称生产验收全部结束。**

## 1. TCE 分层复核

### 1.1 Tool

Tool 层负责能力发现和 schema 投影，不拥有真实网络执行：

- `net.search`
- `net.fetch`
- `net.extract`

Wave 5 acceptance 验证三项 tool schema 都来自 `PTC_CAPABILITIES`，没有第二份手写 schema。
`web.get`、`reach.webSearch`、`reach.webRead` 也只保留兼容投影，不再拥有独立 I/O 执行体。

### 1.2 Code

Code 层保留：

- TypeScript/Python 等宿主语言的循环、条件、并发与状态组织；
- capability 调用集的静态审核；
- 只包含已授权方法的 typed proxy；
- `fetch → extract`、多查询扩展、结果筛选等组合逻辑。

Code 不持有 socket、DNS、provider key、任意 `httpGet` 或任意进程执行能力。`kernel-ts` 继续作为
Engine 内部的 PTC orchestration runtime，没有迁出 Engine，也没有新建额外 package boundary。

### 1.3 Execute

Execute 层已经拥有：

- `NetworkExecuteGateway`；
- `SafeHttpTransport` 与 redirect 逐跳复核；
- provider registry 和 raw-hit provider adapter；
- offline deterministic extractor；
- policy、budget、retention、structured error；
- artifact store、trace recorder 和 observability；
- provider、publisher、processor 三方身份记录。

网络基础服务放在 Execute 而不是 Code 是正确的。未来增加 Brave、Exa、Tavily、GitHub 或垂直站点
时，应继续增加 provider adapter/config，而不是给模型增加带品牌的能力名。

## 2. V1 能力进度

### 2.1 `net.search`

已完成：

- provider-neutral 的 `SearchRequestV1/SearchResponseV1`；
- raw-hit provider；
- hits、attempts、partial、stopReason 等结构化字段；
- discovery provider 与 publisher origin 分离；
- 普通结果固定为 `public-untrusted`；
- provider 错误映射和敏感信息脱敏。

未包含：

- 自动 query expansion；
- 多 provider 并行研究策略；
- source trust 提升；
- ResearchPlanner、frontier、evidence ledger。

这些不属于 V1 缺陷，而是有意留给后续 Code/Agent 逻辑。

### 2.2 `net.fetch`

已完成：

- 受控公开 URL GET；
- scheme、userinfo、DNS/IP、internal suffix 和敏感 query 检查；
- redirect chain 逐跳校验；
- 大小限制和结构化错误；
- final URL、media type、hash、byteLength 和 raw artifact ref；
- legacy `web.fetchText` 复用同一安全传输 ownership。

新 `net.fetch` 默认 HTTPS-only，兼容行为由服务端 implementation binding 决定，LLM 参数面不能
自报 legacy 或绕过模式。这一点符合 fail-closed 原则。

### 2.3 `net.extract`

已完成：

- 对已有 artifact 的离线解析；
- 不发起二次网络；
- 正文、元数据和链接提取；
- processing chain 和 output hash；
- 相同 artifact/hash/processor 的确定性结果；
- 处理后仍标为 `processed-untrusted`。

### 2.4 来源控制

当前来源模型已经区分：

| 身份 | 含义 | 不能替代什么 |
|---|---|---|
| provider | 通过哪个检索或抓取实现发现内容 | 不代表内容发布者 |
| publisher | 原始 URL/域名对应的发布主体 | 不代表内容已经可信 |
| processor | 哪个解析器/版本加工内容 | 不代表来源权威性 |

这是后续复杂研究所需的正确底座。搜索结果数量、provider fallback 次数或抓取成功率不能提升
`trust`。权威性判断应由未来研究 Code 根据任务目标、来源类型、时效、独立性和交叉证据完成。

### 2.5 Search / Research / Intake 边界

本轮正确保持了三者隔离：

- 普通 Search 使用 `search-public`，目标是相关性和有界低成本；
- Deep Search/Research 未来可以多轮调用相同底层能力，但需要更高覆盖、交叉验证和停止条件；
- Intake 仍走人类签名 Trust Policy、subscription、quarantine、revision、双核验和 CAS promotion；
- Search/Research 的类型不能直接传给 Intake EvidenceReference；
- `source-discovery` 和 `auto-expansion` 保持 feature-off。

这意味着“找到了网页”不会被误写成“已摄入可信知识”。安全性、全面性和权威性要求不是靠一个
统一 search API 隐式切换，而是靠不同上层流程和独立授权边界实现。

## 3. 存储边界复核

网络信息不应全部塞入 PostgreSQL。当前设计方向合理：

| 数据 | V1 目标存储 |
|---|---|
| task、role、grant、policy、trace、artifact manifest | PostgreSQL |
| 普通 search response | 随任务结果或短期 trace，不默认长期存全文 |
| 普通 raw HTML/text | task-scoped ephemeral artifact store |
| Intake 的小型有界原文 | PostgreSQL `BYTEA` |
| 大 PDF、图片、音视频 | V1 拒绝或延后；未来对象存储 |

PostgreSQL 是统一元数据、关系、审计和小型有界对象后端，不应被当成所有大型二进制和临时网页
内容的唯一物理存储。`ArtifactRefV1` 应作为稳定逻辑接口，底层可以从内存换成 PG-inline 或对象
存储，而不改变 Code 契约。

## 4. 验证证据

### 4.1 定向 acceptance

执行：

```bash
npm test -- \
  test/pth-contracts/network-information.test.ts \
  test/pth-execution/network-gateway.test.ts \
  test/pth-execution/network-wave4.test.ts \
  test/pth-execution/network-v1-acceptance.test.ts \
  test/pth-kernel-execution/tce-w1-network-inject.test.ts \
  test/pth-kernel-execution/tce-w3-projection.test.ts
```

结果：6 个测试文件通过，32 个测试全部通过。

覆盖内容包括：

- wire contract 和类型校验；
- static audit 与 method-level injection；
- search/fetch/extract gateway；
- legacy projection；
- 敏感输入拒绝和 redaction；
- provider/publisher/processor identity；
- Search/Research → Intake 类型隔离；
- deterministic extraction；
- trace 字段；
- Wave 5 离线 acceptance matrix。

### 4.2 仓库门禁

本轮审计中：

- `npm run lint` 通过；
- TCE coverage 报告为 37 tools、69 capabilities、28 executors；
- boundary、cycle、config、role conservation、product boundary、docs links 检查通过；
- `npm run build` 通过；
- `git diff --check` 通过。

### 4.3 验证限制

Wave 5 acceptance 明确是“确定性无网络”测试。测试中的 search provider、fetch transport 和
artifact store 均为本地 fake/in-memory 实现。因此它证明契约、组合和安全分支，但尚未证明：

- 默认 DuckDuckGo HTML raw-hit provider 在真实网络中的稳定性；
- DNS、redirect、超时、限流和页面变化的实际行为；
- provider 长时间运行时的成本与延迟基线；
- 多任务并发下的 artifact 隔离；
- task/tenant 维度的完整 trace 关联。

## 5. 主要问题与优先级

### P0-1：ArtifactStore 名义上 task-scoped，生产上实际 per-worker

`batch-process.ts` 在创建 worker 时构造一个默认 `NetworkExecuteGateway`；
`InMemoryArtifactStore` 则把 artifact 保存在 gateway 内的单个 `Map` 中。注释写“通常 per task”，
但生产装配实际是每 worker 一个 gateway。

后果：

- artifact 生命周期可能覆盖多个任务；
- artifact ref 如果被错误复用，store 本身不校验 task/tenant；
- retention class 为 `task` 只是标签，不是实际隔离机制；
- worker 长生命周期会造成内存持续增长。

建议优先选择以下一种实现：

1. 每次 RoleRun 创建 task-bound gateway/store，RoleRun 结束即销毁；或
2. artifact key 写入 tenantId/taskId，并在 put/get 强制匹配 namespace，同时增加 TTL/eviction；或
3. 引入 task-scoped artifact service，内存只做带 namespace 的缓存。

无论选择哪一种，`ArtifactRefV1` 不需要变化。

### P1-1：生产 trace 没有逐任务盖章

`NetworkOperationContextV1` 已支持 taskId/tenantId，但当前默认 gateway context 只写入 roleId；
`buildContext()` 只是把固定 `defaultContext` 合入每次 operation。

应在任务能力注入或 RoleRun wrapper 中传入：

```text
tenantId + taskId + roleId + traceId/attemptId
```

这些值必须来自 Engine 已签发的任务上下文，不能由 LLM 参数自报。否则多租户审计、按任务计费、
问题追踪和 artifact namespace 都无法可靠关联。

### P1-2：缺少真实 provider 冒烟和基准

设计 Wave 5 要求记录 Code proxy 固定开销、provider 延迟、extract 吞吐和 artifact 大小；当前提交
主要增加确定性 acceptance matrix，没有看到真实 provider 冒烟与基准产物。

建议在不让 CI 依赖公网的前提下增加单独的 opt-in 检查：

```text
PTH_NETWORK_LIVE_TEST=1 npm test -- test/pth-execution/network-live-smoke.test.ts
```

live smoke 只做小配额、固定查询、固定域名、结构校验和 redaction 检查，不进入默认 CI。

### P2-1：设计状态应与提交事实保持一致

最新提交名为“Wave 5 acceptance matrix 与设计文档状态收尾”，但设计头部仍写“Wave 5 验收/文档
收尾中”。当前这个状态是合理的，因为上述生产隔离和 live smoke 尚未完成。后续不要仅因测试文件
存在就改成“全部完成”，应先满足本报告的收口条件。

## 6. 对高深度、高广度目标的支持程度

V1 没有实现复杂研究逻辑，但并没有封死未来能力：

```ts
for (const query of expandedQueries) {
  const response = await net.search(query, limits);
  // 根据中间结果生成新查询、选择页面、继续 fetch/extract
}
```

未来深度和广度应来自：

- Code 层动态 query expansion 和路径调整；
- 任务逻辑提供的持久化子任务委派；
- 多种 provider adapter 和垂直来源；
- 来源身份、证据冲突、覆盖缺口和停止条件；
- 成本、时间和安全预算。

不应通过增加一个黑盒 `net.deepSearch` 或把 provider 品牌直接暴露给模型实现。底层能力保持窄而
正交，复杂逻辑留在 Agent/Code，正是当前架构的优势。

## 7. 建议收口顺序

1. 把 task/tenant/trace context 从 Engine 任务上下文盖章到每次网络 operation；
2. 让 artifact store 获得真实 task namespace、生命周期和清理策略；
3. 增加多任务/多租户 artifact 隔离测试；
4. 增加 opt-in 真实 provider smoke 和最小性能基准；
5. 核对 trace、日志和 provider error 中不泄露 query、header、cookie 和凭据；
6. 更新 Wave 5 状态与验收记录；
7. 试运行稳定后，再进入 provider 扩展和研究层设计。

## 8. 完成判据

- [x] `net.search/fetch/extract` contract、catalog、projection 和 typed proxy 落地主干；
- [x] Execute gateway、安全 transport、provider、extractor、artifact 和 trace 基础实现落地主干；
- [x] legacy projection 和精确 role grant 落地主干；
- [x] 敏感输入、redaction、三方身份和 Intake 类型隔离测试通过；
- [x] 定向 acceptance 32/32 通过；
- [ ] artifact 在真实生产装配中严格 task/tenant scoped；
- [ ] 每次 operation 都带服务端盖章的 taskId/tenantId/roleId；
- [ ] 多任务隔离与清理策略测试通过；
- [ ] 真实 provider opt-in smoke 通过；
- [ ] Wave 5 性能与容量基线完成记录；
- [ ] 设计状态更新为与验收事实一致。

## 9. 最终反馈

网络 V1 的核心架构是正确的：基础服务在 Execute，能力契约 provider-neutral，Code 用宿主语言
组织查询、抓取和解析，复杂研究逻辑后置；Search、Research 与 Intake 也没有因追求功能数量而
混成一条不安全的管道。

当前不需要重构 `kernel-ts` 归属，也不需要提前实现 Deep Research。优先把 artifact 与 task/tenant
context 两个生产边界补齐，再通过真实 provider 小规模试运行验证网络条件，便可以把本模块从
“基础功能完成”推进到“V1 生产验收完成”。
