# PTH 网络信息基础设施 V1：现状评审与实施方案

> 状态：**建议采纳（V1 基础能力范围）**  
> 日期：2026-08-26  
> 代码基线：`76ceae6`（`main`）  
> 工作类型：架构评审、领域建模与实施范围裁决；本报告不实现代码  
> 上位约束：[ADR-0004：TCE 的 C 是 Code](../../adr/0004-tce-code-layer-ptc-capability-first.md)  
> 关联设计：[TCE 网络模块整合重构设计](../design/tce-network-module-refactor-design.md)、[N26 自主知识摄入设计](../design/n26-autonomous-knowledge-intake-design.md)、[存储后端架构分析](./storage-backend-analysis.md)

## 0. 执行摘要

PTH 最终希望具备高深度、高广度的复杂网络检索能力，但本轮不应直接实现一个名为
`deepSearch` 的黑盒服务，也不应同时引入研究规划、多智能体、证据图、自动扩源和知识晋升。
当前最合适的 V1 是一层稳定、低阶、可组合的网络信息基础设施：

```text
Tool：可发现的能力投影
  ↓ 生成/选择代码
Code：engine 内 PTC orchestration runtime
  ↓ 静态审核 + 已授权 typed proxy
Execute：search / fetch / extract / policy / provider / artifact
  ↓
公开网络、搜索 API、离线解析器与受控工具容器
```

本报告作出十二项核心裁决：

1. **V1 只交付网络原语，不交付 Deep Research 产品逻辑。** 核心原语为
   `net.search`、`net.fetch`、`net.extract`；它们分别完成发现、获取和确定性解析。
2. **组合逻辑属于 Code。** 多轮搜索、查询改写、并行 fan-out、沿链接追踪和简单汇总由 LLM
   在 PTC 程序中组织；Execute 不提供隐藏的 `net.deepSearch()`。
3. **基础服务属于 Execute。** 网络连接、provider 凭据、限流、重试、解析器、外部 CLI、预算和
   artifact 管理均由 Execute 拥有；Code 只持有 typed proxy。
4. **`kernel-ts` 不迁出 engine。** 它应被明确为无环境副作用的 PTC 编排运行时，保留持久状态、
   静态审核和低开销调用；把网络实现迁出，不等于把编排核迁出。
5. **PTC host 与 Execute binding 必须分开建模。** `kernel-ts` 表示代理对象在哪个 Code runtime
   中可用；`network-broker` 等 typed Execute service，或 `tool-container:network` 等既有执行面，
   才表示能力实际发往哪里。不能用一个 `host` 字段同时表达两者。
6. **禁止通用 `exec(cmd,args)` 和任意 `httpGet(url)` 成为 Agent 能力。** 每个 provider 和外部
   工具必须通过固定的 typed adapter、固定 argv 模板与 operation policy 暴露。
7. **搜索 provider、内容发布源和处理中介必须分别留痕。** Exa/Brave/SearXNG 等是发现者，
   目标站点是发布者，Jina/Firecrawl/Trafilatura 等是处理者；三者不能合并成一个模糊的
   `source` 字段。
8. **普通 Search、预留 Research profile 与 Intake 是三种不同操作。** 它们只共享安全传输和
   审计骨架，不共享信任语义、写入权限或完成度承诺；V1 不启用 Research 产品 profile。
9. **Research 结果不能隐式进入 Intake。** 未来唯一允许的方向是
   `ResearchBundle → SourceCandidateProposal → 人类 Trust Policy → Subscription`；V1 不接通
   这条桥。
10. **PostgreSQL 是权威事务/账本平面，不是所有字节的唯一物理介质。** V1 可继续把有界、小型
    Intake artifact 存在 PG `BYTEA`；搜索内容默认不持久化，大对象和多媒体以后进入
    Artifact/Object Store，PG 保存不可变 manifest、hash 和引用。
11. **语言索引与能力索引必须是同一事实模型的两个投影。** 核心 V1 只为 TS 编排面和
    `net.*` 建最小 implementation binding/派生索引；完整多语言 CatalogSnapshot 与查询 API
    放到 V1.1，不建立两套独立注册表。
12. **现有 N29 最小可信 Intake 内环保持独立。** 本轮不重写其 policy、quarantine、revision、
    evidence、verification 或 promotion；只允许复用底层安全传输。

一句话结论：

> **先把“能安全、透明、可替换地搜、取、析”做实，再让 LLM 在 Code 层把这些原语组织成
> 深度研究；不要让 Execute 提前吞掉研究能动性，也不要让研究结果绕过 Intake 信任边界。**

## 1. 评审输入与目标解释

### 1.1 本报告使用的输入

本报告综合了三类材料：

1. PTH 当前仓库、最近提交、现有设计、契约和测试报告；
2. 前序对搜索 API、免费/付费搜索服务、爬虫与网络工具的整理；
3. 前序对 WebGPT、ReAct、IRCoT、FLARE、STORM、Self-RAG，以及当前产品化 Deep Research
   架构的综述。

前序综述给出的最重要启示不是“选择某个 Star 最高的项目”，而是必须拆开以下职责：

```text
Search API / SearXNG             → 发现候选 URL
HTTP / Scrapy / Crawlee          → 请求、队列、重试、调度
Playwright                       → 必要时执行浏览器和 JavaScript
Readability / Trafilatura        → 正文与元数据解析
Crawl4AI / Firecrawl             → 较高层的组合服务
ArchiveBox / Artifact Store      → 原始证据与历史版本
Research Agent                   → 计划、迭代、证据组织和写作
```

这些组件可以互相组合，但不能在领域模型里被压成一个“网络工具”。否则系统将无法区分究竟是
召回失败、抓取失败、渲染失败、解析失败，还是研究策略失败。

### 1.2 对“高深度、高广度”的解释

最终目标包含两个正交维度：

- **广度**：更多独立查询、更多 provider、更多平台与来源类型、并行分支、跨语言处理能力；
- **深度**：根据中间发现继续追踪实体、反例与证据缺口，读取正文和附件，解决矛盾，直到预算、
  覆盖或饱和条件触发停止。

二者都不是 `topK` 调大即可获得。V1 的责任不是直接保证深度和广度，而是确保未来扩展时不必
推翻底层契约：每次搜索、抓取和处理都应有结构化结果、来源身份、处理链、预算和错误轨迹。

### 1.3 本轮的“基础功能”定义

V1 完成后应具备以下能力：

- LLM 能从工具面和 TS 编排面的派生索引发现网络能力；
- LLM 能在 PTC Code 中组合多次 `search/fetch/extract`；
- 未授权角色无法看到或调用对应能力；
- 每次网络副作用都经 Execute 的安全、预算与 provider 策略；
- provider 可替换，输出契约保持稳定；
- 结果明确标记为公开网络中的不受信数据，并保留可审计处理链；
- 不改变现有 Intake 信任与晋升语义。

它不承诺：自动形成研究计划、自动判断证据充分、自动写长报告、自动交叉核验、自动扩源或自动
进入知识库。

## 2. 当前进度：已经有什么，缺什么

### 2.1 最近提交的真实含义

当前 `main` 的最近两次网络相关提交是：

- `c9f22ec`：新增 TCE 网络模块重构草案；
- `76ceae6`：在该草案中确认 `net.*` 命名、可配置搜索后端、`external-tool`、
  `doctor/checkUpdate` 和 `download` 等决策。

两次提交都只改动设计文档，并未实现 `net.*`。最近真正涉及网络代码的 `ca8d951` 只是为既有
`web.fetchText` 增加 DoH fallback。因此，当前状态应表述为：

> **TCE 网络方向已经形成草案，安全传输和单 URL fetch 已有实现；统一网络能力族、搜索 provider、
> Execute 路由和双索引尚未开始落地。**

### 2.2 能力成熟度矩阵

| 能力面 | 当前状态 | 事实依据 | V1 判断 |
|---|---|---|---|
| TCE 总原则 | 已接受 | ADR-0004 已规定 Tool→Code→Execute、能力契约第一性、注入+静态审核 | 直接继承，不另起架构 |
| PTC 能力单一事实源 | 已实现 | `PTC_CAPABILITIES` 已承载签名、校验、文档三要素、工具投影字段 | 扩展而非替换 |
| tool schema 单向派生 | 已实现 | `ptc/tools.ts` 从 capability `toolSchema` 派生 | `net.*` 必须走同一路径 |
| 方法级静态审核 | 已实现基础 | `surface.ts` 能检查 `root.method()` 是否超出 role capability | 增加 `net.*` 回归 |
| 任务级方法注入 | 部分实现 | 当前只对 `dev/write/debug` 做方法级裁剪 | V1 增加 `net.*` typed proxy |
| `kernel-ts` PTC runtime | 已实现 | engine 内 Node `vm`、持久状态与注入能力 | 保留在 engine，收紧副作用 |
| ExecutionTarget Matrix | 已实现基础 | 当前静态 target 主要为 `sandbox` 和 `engine-ts`，契约面向 notebook/runtime | 保持其现有语义；网络服务另建 ExecuteService binding |
| 安全 HTTP transport | 已实现且较强 | 已有协议、DNS/IP、pin、redirect、bytes/time 等保护 | 迁归 Execute 公共底座 |
| 普通网页 fetch | 已实现旧版 | 只有 `web.fetchText(): Promise<string>`，HTML 用正则剥标签 | 作为迁移兼容，不作为证据接口 |
| `net.*` family | 未实现 | PTC family 仍只有 `web`，host 也没有合适的 Execute target 表达 | V1 核心工作 |
| 真实 Web Search | 未实现 | `source-discovery` 只有骨架，PTC 无搜索能力 | V1 至少接一个 raw-hit adapter |
| provider broker | 未实现 | `agent-reach` 同时存在绕开 PTC 的 toolstore extension，以及 `hostOnly=true`、`engineVisible=false` 的 secrets CLI | 必须新增受控 mediator/adapter，并收口两条旧路径 |
| 平台搜索与下载 | 有零散工具 | toolstore `agent-reach`、secrets CLI、`gh`、`bili` 与 `yt-dlp` 分散；`yt-dlp` 已有固定 argv template | V1-B 收编，非核心主路径 |
| N29 单来源 Intake 内环 | 已实现并验收 | quarantine、policy、revision、双核验、CAS promotion 有正式报告与门禁 | 保持独立，不重写 |
| Intake 来源发现外环 | 骨架/实验 | `source-discovery.ts`、`auto-expansion.ts` 存在，但不具备生产信任语义 | V1 明确关闭 |
| 语言—能力双索引 | 未实现 | 能力表、notebook target、role grant 各自存在，但没有机器可查 join；当前实际 PTC host 只有 TS | V1 只做 TS+`net.*` 最小 binding，完整目录放 V1.1 |
| Deep Research runtime | 未实现 | 没有 ResearchSpec、frontier、ledger、claim graph 或持久 ResearchRun | 明确推迟到 V2 |

### 2.3 已有 Intake 的价值与边界

[N29 最小可信 Intake 报告](./n29-minimal-intake-report.md)已经证明单来源最小内环可以完成：

```text
人类签名 policy
  → 有界抓取
  → raw quarantine
  → use admission
  → immutable revision
  → draft candidate
  → domain + adversarial verdict
  → exact-hash promotion
  → official
```

这是一项重要资产，但它不是普通搜索或 Deep Research 的实现。N29 自身也明确声明：其 GO 不包含
来源发现外环、自动扩源、多域广度与持续运营。因此本轮应复用其安全经验，而不是把 `net.search`
直接接到 Intake 状态机。

### 2.4 当前存在的四个结构矛盾

1. 旧的“engine 自身永不实现执行”表述与 engine-internal `engine-ts` 曾有张力；本轮已在
   [CONTEXT.md](../../../CONTEXT.md) 收口为：engine 可以承载无副作用的 Code orchestration
   runtime，但不拥有外部副作用型基础服务。
2. 当前网络草案把部分 `net.*` 的 host 写成 `kernel-ts`，同时又要求真实网络执行都去 Execute。
   这是把“代理注入位置”和“实现目标”混为一谈。
3. 草案用 `exec(cmd,args)` 和 `httpGet(url)` 作为 capability factory 依赖，容易让 Execute
   退化为通用逃生舱，绕过 typed operation 和固定 argv 边界。
4. `source-discovery.ts` 会生成 `enabled: true` 的候选，`auto-expansion.ts` 还存在“成功三次即
   trusted”的逻辑；这些实验骨架目前尚未进入生产主链，但若被装配就会与 N26 的“人类是唯一
   信任授予者”冲突，因此必须保持关闭。

## 3. 对现有网络重构草案的修订意见

现有草案的方向——统一 `net.*`、保留兼容别名、共享安全传输、配置化 provider——是正确的；
但按照最新产品定位，建议在实施前做以下修订。

| 当前草案 | 建议修订 | 原因 |
|---|---|---|
| `net.fetch/read/v2exHot` host=`kernel-ts` | `kernel-ts` 只作为 Code proxy host；实际 target 指向 Execute service | 基础服务必须归 Execute，避免 engine 持有 I/O |
| 给 `PtcCapabilityHost` 增加 `external-tool` 表示路由 | 将旧 `host` 明确迁移/改名为 `codeHost`，能力实现另用判别式 Execute binding | 注入位置与执行位置是两个轴，旧字段注释也必须同步 |
| 一个 `createNetworkCapability` 接受任意 `httpGet/exec` | 注入 `NetworkExecuteClient` 或具体 typed ports | 防止命令、URL、凭据策略绕过 |
| `net.read` 直接调用 Jina Reader | V1 不注册 `net.read` capability；“读取网页”只是一段显式的 `net.fetch → net.extract` Code 配方；远程 reader 是显式 provider | 避免派生授权与底层 grant 不一致，并保留可观察性和 LLM 组合能力 |
| Exa 失败后自动回退 Jina | 仅在两者声明满足同一 provider capability 时 fallback；每次 attempt 留痕 | Search 与 remote read 的语义并不等价 |
| `tool-registry/tool-translator` 增加命令对象映射 | 旧 tool-call 只投影为 PTC Code；Execute target 由 implementation registry 解析 | 避免复活 ADR-0004 已退役的 Command 双轨 |
| `source-discovery` 默认接 `net.search` | V1 不接 Intake；以后只生成 `SourceCandidateProposal` | 搜索线索不能自动获得 Intake 权限 |
| provider 品牌写入能力契约 | 契约 provider-neutral，品牌仅在 adapter registry/config 中 | 避免 API 费用、可用性变化污染语义契约 |
| 全部结果统一 `AgentToolResult` | 为 search/fetch/extract 定义版本化 discriminated result | 深度研究需要稳定、可计算、可验证的 IR |

此外，仓库中的 `agent-reach` 实际有两种形态：toolstore extension 当前通过 `ext.use` 调用
`ctx.exec/ctx.http`，没有经过 PTC 方法级静态审核；secrets-domain CLI 则
`engineVisible=false`、`hostOnly=true`。V1 不应为了“快速接通”而直接暴露其中任何一条通用执行
面。正确做法是增加一个 Execute-owned 的 `NetworkProviderGateway`：它只接受固定的
`SearchRequest`，内部可以暂时复用既有实现，但不能让 LLM 控制二进制名、argv、任意 URL 通道、
环境变量或 provider 凭据。

## 4. TCE 目标架构

### 4.1 总体结构

```text
┌──────────────────────────── Tool ────────────────────────────┐
│  net.search / net.fetch / net.extract tool schemas           │
│  language index / capability index / compatibility aliases  │
└──────────────────────────────┬────────────────────────────────┘
                               │ 投影为代码
┌──────────────────────────── Code ────────────────────────────┐
│  PTC orchestration runtime (kernel-ts, engine-internal)      │
│  static audit: called capabilities ⊆ role grants             │
│  persistent task state + typed proxies                       │
│  no ambient net/fs/process/require/import/secrets             │
└──────────────────────────────┬────────────────────────────────┘
                               │ reviewed operation + grant
┌─────────────────────────── Execute ──────────────────────────┐
│ NetworkExecuteGateway                                          │
│  ├─ OperationPolicy / Budget / Retention                       │
│  ├─ ProviderRegistry / SourcePolicy                            │
│  ├─ SearchProvider adapter                                     │
│  ├─ SafeHttpTransport / Fetch adapter                          │
│  ├─ offline Extractor adapter                                  │
│  ├─ fixed-template ExternalTool adapter                        │
│  └─ Trace / ArtifactStore / structured errors                  │
└───────────────┬──────────────────┬────────────────────────────┘
                │                  │
        public search APIs   public publishers / tool containers
```

### 4.2 Tool 层职责

Tool 层负责“让模型正确发现和选择能力”，不负责真正执行：

- schema 必须从 `PTC_CAPABILITIES` 单向派生；
- tool call 只能生成固定的 PTC Code 模板；
- 兼容名称如 `web.get`、`reach.webSearch` 也只能生成同一 `net.*` Code；
- provider 品牌、API key、CLI 名和 Execute target 不出现在 LLM 参数面；
- `run/eval` 仍是语言逃生舱，但不是能力目录，更不是网络权限来源。

### 4.3 Code 层职责

Code 是 LLM 能动性主要发生的地方：

- 把多个低层原语组合成一次任务策略；
- 根据前一次结果决定下一次查询或抓取；
- 做有限 fan-out、排序、去重和汇总；
- 维护任务内中间状态；
- 在执行前提取能力调用集并与 role grants 比对；
- 只看到已注入的具体方法，未授权即“不存在”。

Code 不拥有：

- 网络 socket、DNS、provider key；
- 任意进程或 argv；
- provider 选择规则和账单额度；
- Intake Trust Policy；
- 将公开网页标为 trusted/official 的权限。

### 4.4 Execute 层职责

Execute 对每次外部副作用负责：

- 选择可满足请求语义的 provider implementation；
- 执行 egress、SSRF、redirect、bytes、time、MIME、rate limit、并发和成本限制；
- 隔离凭据，并在日志中去除 secret 与敏感 query；
- 记录 provider attempt、publisher URL、处理中介和转换 hash；
- 产生结构化 partial/error，而不是把后端 stderr 原样交给模型；
- 根据 operation profile 决定 retention 与 artifact 存储；
- 为外部工具套固定 argv template，不接受任意命令。

### 4.5 为什么 `kernel-ts` 应继续留在 engine

把 `kernel-ts` 整体迁出 engine 会增加以下复杂度：

- 每一步编排都需要 IPC、序列化、错误映射和取消协议；
- 持久 PTC state 需要跨进程同步或复制；
- 静态审核结果、role snapshot、capability injection 与执行 session 的一致性更难保证；
- 生命周期、健康检查和恢复多出一个常驻服务；
- 对大量短小的纯计算/分支/对象操作产生没有业务收益的固定开销。

因此 V1 的正确边界是：

```text
留在 engine：PTC 解析、静态审核、状态、控制流、typed proxy
迁到 Execute：网络 I/O、外部进程、凭据、provider、解析服务、artifact 副作用
```

这并不否认未来隔离 PTC 的可能性。以下条件出现时可以新增可选 isolated PTC target：

- 需要运行第三方或用户提交的非可信 Code；
- `vm` 的隔离保证不足以满足威胁模型；
- 单次程序 CPU/内存占用需要强制 cgroup 限制；
- 多租户法规要求进程或容器级隔离。

届时它应作为新的 `ExecutionTargetDefinition`，而不是删除低延迟的 engine-internal target。两种
target 可以并存，由 policy 选择。

## 5. 领域模型与类型边界

### 5.1 核心术语

| 术语 | 定义 | 明确不表示 |
|---|---|---|
| Network Primitive | 一次有界、typed、provider-neutral 的 search/fetch/extract 操作 | 研究计划或长报告 |
| Operation Profile | 一组网络、来源、预算、能力与 retention 约束 | role 本身或全局信任 |
| Discovery Provider | 返回候选链接的搜索/元搜索/垂直检索服务 | 内容发布者或事实权威 |
| Publisher Source | 实际发布目标内容的站点、机构或文档 | 发现该链接的搜索引擎 |
| Processing Intermediary | 对内容做抓取、渲染、解析、OCR 或格式转换的服务 | 原始来源 |
| Capability Definition | LLM 可理解的稳定语义契约 | 具体 provider 或二进制 |
| Orchestration Host Language | 能承载 PTC 注入、静态审核与控制流的语言；当前只有 TS | Notebook 或实现语言 |
| Execution Language | 由现有 ExecutionTarget 执行的 ts/python/bash 程序语言 | 已落地的 PTC host |
| Implementation Language | adapter/service 内部的实现语言 | LLM 的调用语言或授权 |
| Execute Service | 承载 typed operation 的服务端口，如 network gateway/extractor | Notebook ExecutionTarget |
| Capability Implementation | capability 到实现语言、provider 与判别式 Execute binding 的映射 | role 授权 |
| Artifact Ref | 指向不可变内容或表示的 hash 引用 | “内容已经可信” |
| Research Bundle | 未来研究运行的只读结果、证据与局限性集合 | Intake Evidence 或 official 知识 |
| Source Candidate Proposal | 对某发布源进入 Intake 审查的提议 | Subscription 或 Trust Policy |

### 5.2 三种操作 profile

```ts
type PublicNetworkOperationProfileId =
  | "search-public"
  | "research-public";

type NetworkTraceClassification =
  | PublicNetworkOperationProfileId
  | "intake-authorized";

interface NetworkOperationContext {
  schemaVersion: "network-operation-context/v1";
  tenantId: string;
  taskId?: string;
  executionId: string;
  roleId: string;
  profileId: PublicNetworkOperationProfileId;
  networkClass: "public-internet";
  grantId: string;
  budget: {
    maxRequests: number;
    maxBytes: number;
    maxWallTimeMs: number;
    maxConcurrent: number;
    maxBillableUnits?: number;
  };
  publicNetworkPolicyVersion: string;
  retentionPolicyVersion: string;
}

interface IntakeNetworkTraceBinding {
  classification: "intake-authorized";
  subscriptionId: string;
  runId: string;
  trustPolicyRef: {
    policyId: string;
    version: string;
    digest: string;
    ruleId: string;
  };
}
```

这里的 `profileId`、`networkClass` 不是由 LLM 自报。它们由任务类型、role grant 与服务端 policy
在 Code 执行前冻结，并随 trace 写入。`intake-authorized` 只是一种 Intake 内部 trace 分类，绝不
是通用 `net.*` 的可选权限：Intake 不接受 `NetworkOperationContext` 作为 admission 输入，只能从
内部 fetch broker 经当前已验签 Trust Policy、Subscription、Run 和 lease 进入。`trustPolicyRef`
也只由 Intake 服务写入审计，Code/LLM 不能提供。

`research-public` 在 V1 只冻结名称和安全边界，部署策略必须标记为 unavailable；核心 V1 只启用
`search-public`。等 V2 有持久 ResearchRun、预算和停止语义后，才允许选择该 profile。

### 5.3 能力与实现分离

```ts
interface CapabilityDefinition {
  id: string;                    // 例如 net.search
  contractVersion: string;
  inputSchemaRef: string;
  outputSchemaRef: string;
  effect: "pure" | "read-external" | "write-artifact" | "admin";
  discoveryChannels: {
    ptc: boolean;
    tool: "required" | "optional" | "forbidden";
    prompt: boolean;
  };
}

type OrchestrationHostLanguageId = "ts"; // V1 当前事实，不是目标态枚举

type ExecuteBindingRef =
  | { kind: "execute-service"; serviceId: string; portVersion: string }
  | { kind: "execution-target"; targetId: string };

interface ExecuteServiceDefinition {
  id: string;
  portContractVersion: string;
  operationKinds: readonly string[];
  implementationLanguageId?: string;
}

interface CapabilityImplementation {
  implementationId: string;
  capabilityId: string;
  implementationVersion: string;
  callableFrom: readonly OrchestrationHostLanguageId[];
  implementationLanguageId?: string;
  executeBinding: ExecuteBindingRef;
  providerId?: string;
  supportedProfiles: readonly PublicNetworkOperationProfileId[];
  capabilities: {
    rawHits?: boolean;
    cursor?: boolean;
    remoteFetch?: boolean;
    deterministicExtract?: boolean;
  };
}
```

`CapabilityDefinition` 是 Tool/Code 的事实源，`CapabilityImplementation` 是 Execute 路由的事实源。
这样同一个 `net.search` 可以有多个 provider 实现，也可以以后用不同语言实现，而不改变 LLM
看到的能力名称。当前 `ExecutionTargetDefinition` 只描述 notebook/runtime 语言 target，其
`languages/kind/binding` 契约不能表达 network broker 或 extractor；V1 因此新增轻量
`ExecuteServiceDefinition`，不伪造一个支持 bash/ts 的 notebook target。若未来要统一两者，应另立
泛化 target ADR，不能作为本 V1 的隐含改动。

当前 `PTC_CAPABILITIES` 也还没有 `contractVersion`、规范化 input/output schema 或完整 effect。
V1 不手写第二张 capability 表，而是扩展 `PtcCapabilityDef`（或由 contracts 中的 canonical record
单向生成它），再按以下唯一方向派生：

```text
canonical capability record
  ├─ PTC runtime definition
  ├─ tool schema / prompt docs
  ├─ role capability vocabulary projection
  └─ implementation binding validation
```

role token 只允许 exact capability ID 或已声明的 family grant；未知、歧义或 alias 冲突必须使 CI
失败，不能靠字符串“看起来相同”自动 join。

## 6. V1 功能范围

### 6.1 核心必做原语

| 能力 | 最小语义 | 典型 Execute 实现 | V1 返回 |
|---|---|---|---|
| `net.search` | 对一个 query 做一次有界的公开网或垂直检索 | raw-result Search API、受控元搜索 adapter | hits、cursor、attempts、partial、预算使用 |
| `net.fetch` | 对一个公开 URL 做一次安全 GET，保存或返回有界 raw artifact | hardened transport | final URL、redirects、headers 子集、hash、artifact ref |
| `net.extract` | 对已有 artifact 做无网络、确定性的正文/元数据/链接解析 | TS Readability 或 Python Trafilatura service | normalized document、sections、links、processor chain |

这三个操作刻意不包含 LLM 推理。`net.search` 不生成“答案”，`net.fetch` 不判断事实，
`net.extract` 不决定权威性。

### 6.2 透明组合与兼容面

V1 不注册、不注入、也不授予 `net.read` capability。所谓“read”只作为文档和生成器中的 Code
配方名存在，展开结果必须直接包含两个可审核的底层调用：

```ts
const fetched = await net.fetch({ url, representation: "raw" });
return await net.extract({
  artifactRef: fetched.artifact.ref,
  mode: "main-content",
});
```

展开必须发生在静态审核之前；静态审核因此直接看到 `net.fetch` 与 `net.extract` 两项依赖，角色也
必须同时拥有这两个 grant。运行时不存在可只授予 `net.read`、再暗中放大为两个能力的入口；trace
分别显示失败发生在哪一段。

兼容迁移建议：

| 旧入口 | V1 归宿 | 策略 |
|---|---|---|
| `web.fetchText` | 同一 Execute fetch port 的 legacy policy + 最小文本表示 | 保留一版 HTTP/HTTPS-compatible deprecation projection；新 `net.fetch` 仍为 HTTPS-only |
| `web.get` | Tool→Code 投影到 `net.fetch` | 不保留独立执行体 |
| `reach.webSearch` | Tool→Code 投影到 `net.search` | 不让扩展直接访问 CLI/HTTP |
| `reach.webRead` | Tool→Code 直接投影为 `net.fetch` 后接 `net.extract` | 要求两个底层 grant，并记录 processing intermediary |
| `reach.ghSearch` / `biliSearch` / `v2exHot` | V1-B 的垂直 provider implementation | 若暂未迁移，必须显式标记 legacy，不宣称统一完成 |
| `yt-dlp` | V1-B `net.download` | 继续固定 argv、默认不注入、显式 role grant |
| `doctor/checkUpdate` | V1-B admin/health capability | 输出去凭据；不进入普通 Research profile |

旧 `web.fetchText` 当前允许 HTTP 与 HTTPS，因此不能既宣称“无差别 alias”又让新 `net.fetch` 只接受
HTTPS。兼容期内两者复用同一安全 transport/Execute port，但使用不同、服务端冻结的 policy：所有
新 role、prompt 和 Code 只获得 HTTPS-only `net.fetch`；只有既有调用可进入带 deprecation trace
的 legacy policy，下一主版本移除 HTTP 兼容。

这个兼容分支不能由模型参数选择。旧 capability definition / Code projection 在服务端固定绑定
`operationVariant=legacy-web-fetch-text`，resolver 依据该不可变 implementation binding 选择
HTTP-compatible policy，并写入 deprecation trace；`net.fetch` 的公开 request schema 中不得出现
`legacy`、`allowHttp`、`compatibilityMode` 或任何等价开关。模型即使伪造同名 JSON 字段，也会在
契约校验阶段被拒绝，不能把普通 `net.fetch` 降级成 legacy 请求。

### 6.3 明确非目标

V1 不实现：

- `net.deepSearch`、ResearchPlanner、ResearchSupervisor；
- query decomposition、动态 SearchFrontier、信息增益排序；
- EvidenceLedger、Claim–Citation Graph、矛盾检测、覆盖率和饱和停止；
- 多 Agent 主管—子 Agent 调度；
- 自动引用精确化与长报告 writer；
- 自动 Research→Intake 转换；
- 自动来源 trust、成功次数升权或 LLM authority score；
- 通用站点 crawler、全站队列、RSS 持续订阅、变化检测；
- 登录态浏览器、表单操作、社交平台私有会话；
- PDF OCR、图片、音频、视频理解；
- 对象存储迁移、全文索引、向量索引；
- provider 成本/质量的智能路由和在线学习。

这些能力不是被否定，而是明确放到后续版本，避免 V1 同时承担接口、基础设施与研究策略三种风险。

## 7. V1 契约草案

### 7.1 Search

```ts
interface SearchRequestV1 {
  schemaVersion: "net.search.request/v1";
  query: string;
  limit?: number;                 // 服务端 clamp
  cursor?: string;
  language?: string;
  timeRange?: { from?: string; to?: string };
  siteAllowlist?: readonly string[];
  siteDenylist?: readonly string[];
  sourceKinds?: readonly string[]; // hint，不是 trust
}

interface SearchHitV1 {
  rank: number;
  title: string;
  url: string;
  canonicalUrl?: string;
  snippet?: string;
  publishedAt?: string;
  language?: string;
  mediaType?: string;
  discovery: {
    providerId: string;
    providerVersion: string;
    providerRank?: number;
    retrievedAt: string;
  };
  publisher: {
    origin: string;
    identityId?: string;
    sourceKindHint?: string;
  };
  trust: "public-untrusted";
}

interface ProviderAttemptV1 {
  providerId: string;
  implementationId: string;
  startedAt: string;
  durationMs: number;
  status: "ok" | "empty" | "rate-limited" | "failed" | "skipped-policy";
  resultCount: number;
  billableUnits?: number;
  errorCode?: string;
}

interface SearchResponseV1 {
  schemaVersion: "net.search.response/v1";
  operationId: string;
  queryDigest: string;
  hits: readonly SearchHitV1[];
  attempts: readonly ProviderAttemptV1[];
  nextCursor?: string;
  partial: boolean;
  stopReason: "limit" | "provider-exhausted" | "budget" | "policy" | "timeout";
}
```

要点：

- `snippet` 只是 provider 返回的不受信摘要，不是来源正文；
- `publisher` 与 `discovery.providerId` 分开；
- 空结果、部分结果与后端失败不能统一伪装成 `[]`；
- query 原文默认不进普通审计日志，只存 digest 和经策略允许的 redacted form；
- provider 返回的 score 不转换成全局“权威分”。

V1 的 `networkClass` 由服务端固定为 `public-internet`，不出现在 LLM 请求参数中。进入 provider
前必须拒绝 URL userinfo、私网/保留地址、内部 DNS suffix 和 policy 定义的敏感 query key；
provider 返回的每个 URL 也要在后续 fetch 时重新判定。

### 7.2 Fetch

```ts
interface FetchRequestV1 {
  schemaVersion: "net.fetch.request/v1";
  url: string;
  accept?: readonly string[];
  maxBytes?: number;
  timeoutMs?: number;
  conditional?: { etag?: string; lastModified?: string };
}

interface ArtifactRefV1 {
  artifactId: string;
  storageKind: "inline-pg" | "task-artifact" | "object";
  immutableLocator: string;
  sha256: string;
  byteLength: number;
  mediaType: string;
  retentionClass: "ephemeral" | "task" | "intake-durable";
}

interface FetchResponseV1 {
  schemaVersion: "net.fetch.response/v1";
  operationId: string;
  requestedUrl: string;
  finalUrl: string;
  redirectChain: readonly string[];
  retrievedAt: string;
  status: number;
  headers: {
    contentType?: string;
    contentLength?: number;
    etag?: string;
    lastModified?: string;
  };
  artifact: { ref: ArtifactRefV1 };
  transport: {
    policyVersion: string;
    bytesRead: number;
    truncated: false;
  };
}
```

`ArtifactRefV1.retentionClass` 语义在 V1 冻结为：

- `ephemeral`：内容只存在于当前 lease Attempt 的 gateway/store 内；同一 task 的 retry/pause/requeue
  会创建新 gateway，旧 ref 不可跨 Attempt 解析，Code 需重新 `net.fetch`。**V1 的 `net.fetch` 产物统一
  返回该级别。**
- `task`：保留给可跨 Attempt、至少覆盖任务重放的 backend；V1 不提供实现。
- `intake-durable`：Intake 权威/受管内容，按 N29/N26 retention policy 管理。

`FetchRequestV1.url` 始终只是待校验输入，不能携带或覆盖 `networkClass/profile/policy`。无论 URL 来自
用户、Code 还是 SearchHit，Gateway 都在任何 socket/provider 调用前执行相同的 userinfo、scheme、
DNS/IP、internal suffix、sensitive query 和每跳 redirect 检查。

V1 不允许“截断后冒充完整 artifact”。超过上限一律返回 `NET_SIZE_LIMIT`，Intake 则按既有语义
quarantine。`preview` representation 属于未来可选能力；若以后增加，必须使用独立契约、hash、
taint 与 retention，且永远不能作为 Intake 的完整来源 artifact。

### 7.3 Extract

```ts
interface ExtractRequestV1 {
  schemaVersion: "net.extract.request/v1";
  artifactRef: ArtifactRefV1;
  mode: "main-content" | "metadata" | "links" | "structured";
  maxOutputChars?: number;
}

interface ExtractedDocumentV1 {
  schemaVersion: "net.document/v1";
  sourceArtifact: ArtifactRefV1;
  title?: string;
  canonicalUrl?: string;
  author?: string;
  publishedAt?: string;
  language?: string;
  text?: string;
  sections?: readonly { headingPath: readonly string[]; text: string }[];
  links?: readonly { url: string; text?: string; relation?: string }[];
  processingChain: readonly {
    processorId: string;
    processorVersion: string;
    implementationLanguage: string;
    inputHash: string;
    outputHash: string;
  }[];
  warnings: readonly string[];
  trust: "processed-untrusted";
}
```

Extractor 默认应无网络、无 secrets、无工具调用权限。若使用 Jina/Firecrawl 这类远程服务，它们
不是普通 extractor fallback，而是 `remote-read` 类型 implementation：需要再次经过 egress 与
数据外发 policy，并在 `processingChain` 中显式出现。

### 7.4 结构化错误

V1 至少冻结以下错误类别：

| 错误码 | 语义 |
|---|---|
| `NET_CAPABILITY_DENIED` | role 未获能力或 profile 不允许 |
| `NET_POLICY_DENIED` | URL/query/provider/source policy 拒绝 |
| `NET_PRIVATE_ADDRESS` | DNS/IP/redirect 命中非公网范围 |
| `NET_REDIRECT_DENIED` | 某一跳不符合策略 |
| `NET_SIZE_LIMIT` | 响应超过上限，未保存为完整 artifact |
| `NET_TIMEOUT` | operation 或 attempt 超时 |
| `NET_RATE_LIMITED` | provider 限流且无等价 fallback |
| `NET_PROVIDER_AUTH` | adapter 凭据不可用；不得回传 secret/stderr |
| `NET_PROVIDER_UNAVAILABLE` | 实现未装配或健康检查失败 |
| `NET_UNSUPPORTED_MEDIA` | V1 不支持该 MIME/representation |
| `NET_ARTIFACT_MISMATCH` | artifact hash、length 或 locator 不一致 |
| `NET_PARTIAL` | 返回部分数据，同时必须给出 attempts 与 stopReason |

## 8. Provider、信息源与处理链控制

### 8.1 三种身份不能混用

以“Exa 找到某公司官网，由 Jina 转成 Markdown”为例：

```text
Discovery Provider：Exa
Publisher Source：   example.com / 该公司
Processing Intermediary：Jina Reader
```

报告引用和权威判断主要围绕 Publisher Source；成本、可用性和召回偏差围绕 Discovery Provider；
格式损失、文本变换和潜在数据外发围绕 Processing Intermediary。V1 trace 必须能分别回答这三类
问题。

### 8.2 Provider 能力分型

| 类型 | 能否作为核心 `net.search` | 说明 |
|---|---|---|
| Raw-result Web Search API | 是 | 返回 URL/title/snippet 等结构化 hits，最符合低层原语 |
| Self-hosted metasearch | 是，需标明上游 | 便于聚合与替换，但不等于拥有独立索引 |
| Semantic search API | 是，若仍返回 raw hits | 可作为特定任务 provider，score 不能冒充权威性 |
| Grounded answer service | 默认否 | 返回的是模型答案与引用，不是可自由组合的通用 SERP |
| Remote reader/extractor | 否 | 属于 processing intermediary，不是搜索 provider |
| Vertical API（GitHub/B 站/论文库） | 是，作为有域 provider | 需要独立 schema capability 声明与来源类型 |
| Browser agent | V1 否 | 是交互执行器，成本与攻击面远大于 search/fetch |

前序搜索服务费用整理中的具体免费额度和单价会变化，不应写入 capability contract。V1 只在
adapter config 中维护 provider、credential ref、限额和计费单位，并通过 `doctor`/监控发现变化。

### 8.3 V1 provider 组合建议

V1 不需要一次接入所有免费服务。建议最小组合是：

1. 一个能返回 raw hits 的公开 Web Search adapter，验证标准契约；
2. 一个可选的 self-hosted/metasearch adapter，验证 provider 可替换性；
3. 现有 hardened HTTP transport 作为 `net.fetch`；
4. 一个无网络确定性 HTML extractor；
5. 两种 `agent-reach` 仅可在开发期被 Execute mediator 内部复用，或保留为宿主运维入口；都不
   成为 LLM 可见通用 CLI/extension 执行面。

Provider 的选择应通过部署配置完成，契约中不硬编码“Exa→Jina”。只有当两个 implementation
都声明满足请求所需的 `rawHits/cursor/filter` 能力时，router 才可 fallback；fallback 后仍应保留
完整 attempts，不能把不同语义的结果拼成“同一次成功”。

### 8.4 SourceRegistry 与 SourcePolicy

目标态区分两个注册面：

- `ProviderRegistry`：adapter 身份、版本、能力、target、credential ref、health 和配额；
- `SourceRegistry`：publisher identity、canonical origins、aliases、source kind、ownership、许可
  元数据和已知风险。

核心 V1 只实现 provider config/registry、request-time `SourcePolicy` 和结果中的 publisher origin；
`SourceRegistry` 先是可选的版本化静态元数据，不成为新的在线权威服务，完整 identity/alias/license
治理放到 V1.1。这样不会与 N26 Trust Policy 的准入权威混淆。

`SourceRegistry` 不应有全局 `trusted: true`。同一来源能否用于某个操作由版本化
`SourcePolicy` 决定：

- Search 可以允许公开 Web，同时拒绝内网、凭据 URL、危险 MIME 和敏感 query；
- Research 可以限制/优先某些域和来源类型，但结果仍不受信；
- Intake 只能使用人类签名 policy 精确允许的 tenant/space/origin/path/license/content type。

### 8.5 服务条款、许可与保留策略

“技术上能请求”不等于“契约上允许将结果用于 PTH”。V1 的 provider admission 还应保存一份
版本化 `ProviderContractPolicy`，至少描述：

- 是否允许返回和导出 raw URL/title/snippet；
- 是否只允许展示 grounded answer 与指定引用；
- 是否允许缓存、缓存多久、是否必须定期删除；
- 是否允许继续抓取返回链接；
- 是否有署名、跳转链接或品牌展示要求；
- 是否允许用于索引、模型输入、训练或再分发；
- terms/version、reviewedAt 与配置负责人。

如果某项服务只授权“搜索 grounding”，就不能把它伪装成核心 `net.search` raw-hit provider。
同样，publisher 的 robots、访问条款和内容许可是 fetch/use policy 的输入，不由“网页无需登录”
自动推导。Search 可以保留一个线索，但后续 fetch、持久化、引用、Intake 使用仍要分别通过各自
policy。

## 9. Search、Research 与 Intake 的安全边界

### 9.1 三模式对照

| 维度 | 普通 Search | 预留 Research profile（V1 不启用） | Intake |
|---|---|---|---|
| 目的 | 快速发现相关页面 | 未来为任务做多轮只读调查 | 生产可进入知识系统的受控修订 |
| V1 实现形态 | 单次或少量 Code 组合 | 仅冻结 ID/边界并返回 unavailable，不是 Research runtime | 复用既有 N29 内环 |
| 来源范围 | policy 允许的公开 HTTPS | 目标态为公开 HTTPS + site scope | 人类 Trust Policy 精确允许的来源 |
| 完整性承诺 | 无，只返回 provider 所得 | 目标态必须有 partial/stopReason，且仍不保证穷尽 | 对已订阅 revision 的流程完整性负责 |
| 权威性 | `public-untrusted` | 目标态可保留多源记录与 limitations；V1 不做冲突检测、解析或权威排序 | source admission 与 claim verification 双门 |
| 网络内容权限 | 只作为数据 | 目标态仍只作为数据，不能变成系统指令 | raw 先 quarantine，processor 严格隔离 |
| 写入 | 不写 knowledge | 不写 official/Intake | 只走 draft→verification→CAS promotion |
| 凭据/私有源 | V1 禁止 | 首次启用时仍默认禁止 | V1 只做已实现的公开 HTTPS 单来源路径 |
| 结果保留 | 默认调用期/任务期 | 未来 Research ledger | PG 权威状态与不可变 revision |

### 9.2 Prompt injection 与内容 taint

所有来自搜索 snippet、网页正文、页面脚本、PDF 文本和远程处理服务的输出都必须带
`public-untrusted` 或 `processed-untrusted` taint。V1 不尝试实现完整动态信息流追踪，但至少执行
以下硬边界：

- Search/Research role 不注入 secrets、policy admin、任意 external exec 或 Intake write；
- extractor 无二次网络、无 secrets、无 shell、无工具；
- 网页中的“忽略之前指令”“运行命令”“上传文件”等文本只作为内容返回；
- provider 返回的 URL 在 fetch 前重新做 canonicalization、policy 和 SSRF 检查；
- 远程内容不得决定 provider、预算、grant 或 retention policy；
- 由网络材料驱动的外部行动需要另一个显式授权阶段，不能在研究读取阶段自动发生。

这条边界也意味着“同时给 researcher 任意 shell、secrets 和全网访问”不是 V1 的合理默认能力集。

### 9.3 Intake 的严格单向边界

未来允许的流程是：

```text
SearchHit
  → ResearchBundle（公开、不受信）
  → SourceCandidateProposal（仅提议）
  → Trust Policy / 人类授权
  → SourceSubscription
  → QuarantinedRevision
  → admitted / verified
  → official
```

禁止的捷径包括：

- `SearchHit → SourceSubscription`；
- `Research citation → Intake EvidenceReference`；
- `三次抓取成功 → trusted`；
- `LLM authority score 高 → 自动准入`；
- `Jina/Firecrawl 输出 → official`。

V1 不实现上面的合法桥，只冻结类型边界并确保没有隐式转换函数。现有来源发现与自动扩源骨架
应保持 feature-off，不能纳入 V1 完成度。

## 10. 存储方案

### 10.1 裁决：PG 是真相平面，不是唯一字节仓

[存储后端架构分析](./storage-backend-analysis.md)已经确认 PTH 的数据形态适合
PG + Redis + 文件/Artifact 的分平面方案。本报告进一步将网络信息数据分配如下：

| 数据 | V1 存储 | 原因 |
|---|---|---|
| task、role/grant snapshot、policy version、operation trace | PostgreSQL | 事务、审计、关联查询 |
| provider attempt、预算、错误、hash、处理链 manifest | PostgreSQL 或既有持久审计面 | 可恢复、可归因，不存 secret |
| SearchResponse | 默认不持久化全文；随 task result 或短期 trace | 避免把所有搜索结果变成永久知识 |
| 普通 Search/Research raw page | lease-attempt-scoped ephemeral ArtifactStore；必要时只在 PG 存 manifest | 大量网页不是权威状态 |
| Intake 小型有界 raw HTML/text | 继续使用现有 PG `BYTEA` | N29 已实现、减少 V1 新基础设施 |
| 大 PDF、扫描、图片、音视频、provider raw dump | V1 拒绝/延后；未来 Object Store | 不适合行内存储与数据库备份 |
| derived FTS/vector index | V1 不做；未来可重建索引 | 不是事实源 |
| 热缓存、限流 token、短期锁 | Redis/内存 | 可丢、低延迟语义 |
| 人类可编辑工作产物 | task workspace/files | 不是系统权威账本 |

> **R2/R3 裁决**：V1 artifact 为 **lease attempt scope**——同一 task 的 retry/pause/requeue 会创建新
> gateway/store，旧 `artifactRef` 不可跨 Attempt 解析；Code 在重跑时需重新 `net.fetch`。R3 起
> `net.fetch` 返回的 typed `ArtifactRefV1.retentionClass` 统一标记为 `ephemeral`，不再使用 `task`。
> 若后续 persistent child delegation 需要跨 Attempt 复用网络产物，再引入最小 durable
> artifact port（key 至少 tenantId/taskId/artifactId，并配 retention policy）。

### 10.2 ArtifactRef 从 V1 起稳定

即使 V1 暂不部署对象存储，也应从第一版返回 `ArtifactRefV1`，而不是在契约中固定
`rawBytes: Buffer` 或 `storage: "postgres"`。这样未来可以把大对象迁到 S3/MinIO/CAS，而不改变
`FetchResponse`、SourceRevision 或 EvidenceReference 的语义。

推荐的不变量：

- artifact content-addressed，保存前重算 hash 和 byteLength；
- immutable locator 不允许覆盖；
- PG manifest 与 payload 的 hash 必须可复核；
- retention 删除 payload 时保留必要 tombstone、hash、policy 和依赖关系；
- Intake 的 evidence locator 只能引用可重放 representation；
- Search 的临时 artifact 不因为被读取过就自动变成 durable evidence。

### 10.3 对现有 PG schema 的判断

当前 `knowledge_source_artifacts` 已有 tenant-scoped raw hash、raw `BYTEA` 和 append-only 保护；
`knowledge_source_revisions` 保存 raw/normalized hash、normalized text、policy decisions 与不可变
关联。这对单来源小对象 Intake V1 足够。它不应被误读为“以后所有网页、PDF、媒体和研究轨迹
都必须塞进 PG”。

## 11. 工具—语言混合范式与双索引

### 11.1 问题

只给模型 `ts.run`、`python.run`、`bash.run`，模型只能知道“可以运行一种语言”，却不知道：

- 哪个语言表面提供哪些领域能力；
- 某能力是否有多个语言/target 实现；
- 当前 role 是否有权使用；
- implementation 是否可用、需要批准或缺少 provider；
- 应优先使用 typed capability 还是语言逃生舱。

反过来，只给一张 capability list，也会丢失不同语言在数据分析、文本解析、系统工具和高性能服务
上的优势。因此需要“同一模型，两种索引”。

### 11.2 单一模型，两个投影

```text
OrchestrationSurfaceDefinition
          │ callableFrom
CapabilityDefinition ── CapabilityImplementation ── ExecuteBindingRef
          │                         │                    ├─ ExecutionTargetDefinition
          │                         │                    └─ ExecuteServiceDefinition
          │                         └─ implementationLanguage metadata
          └─ RoleCapabilityGrant

派生投影 A：by-language   → 某编排表面能调用什么；某实现内部使用什么语言
派生投影 B：by-capability → 某能力有哪些实现、provider 与 Execute binding
```

不能分别手写 `language-index.json` 和 `capability-index.json`。两个索引必须由同一
`CatalogSnapshot` 生成，否则 description、授权和实际路由会漂移。

### 11.3 四个语言/目标轴

| 轴 | 当前实例 | 它回答的问题 |
|---|---|---|
| Orchestration host language | TS | LLM 的 PTC 控制流在哪个语言中被注入和静态审核？ |
| Execution language | TS / Python / Bash | `ExecutionTarget` 实际执行哪种代码？ |
| Implementation language | TS / Python / shell / future Go/Rust | 某 adapter/service 内部用什么实现？ |
| Execute binding | notebook `ExecutionTarget` 或 typed `ExecuteService` | 副作用或代码最终发往哪里？ |

当前只有 TS 是实际 PTC orchestration host。Python/Bash 是 `python.run/eval`、`bash.run/eval`
背后的 execution language；它们尚未拥有与 TS 等价的能力注入和方法级静态审核。现有
`NotebookLanguage` 只证明 execution target 支持 ts/python/bash，不能被当作 PTC host registry。

### 11.4 Catalog 的目标模型与一致性边界

```ts
interface OrchestrationSurfaceDefinitionV1 {
  id: "ts"; // V1 当前事实
  codeHost: "kernel-ts";
  strengths: readonly string[]; // 仅发现提示，不参与授权
}

interface CapabilityInvocationBindingV1 {
  capabilityId: string;
  orchestrationSurfaceId: "ts";
  invocation: "host" | "typed-proxy" | "tool-projection";
  implementationId: string;
}

interface DeploymentCapabilityCatalogSnapshotV1 {
  schemaVersion: "deployment-capability-catalog/v1";
  version: string; // canonical caps + bindings + services + execution targets 的 hash
  orchestrationSurfaces: readonly OrchestrationSurfaceDefinitionV1[];
  capabilities: readonly CapabilityDefinition[];
  implementations: readonly CapabilityImplementation[];
  bindings: readonly CapabilityInvocationBindingV1[];
  executeServices: readonly ExecuteServiceDefinition[];
  executionTargetIds: readonly string[];
}

interface EffectiveCapabilityCatalogSnapshotV1 {
  schemaVersion: "effective-capability-catalog/v1";
  version: string;
  deploymentCatalogVersion: string;
  taskId: string;
  roleId: string;
  roleRevision: string;
  profileId: "search-public";
  grantId: string;
  authorizedCapabilityIds: readonly string[];
  eligibleImplementationIds: readonly string[];
  availabilityDecisionRef: string;
  observedAt: string;
}
```

Deployment snapshot 只描述静态、可部署事实；per-task Effective snapshot 才绑定 role、revision、
grant、profile 和一次 availability policy 决定。这样同一 deployment version 不会因为 `roleId`
不同而产生含义不明的授权结果，trace 也能重放“当时为什么选择/拒绝这个 implementation”。

当前 RuntimeCatalogSnapshot 只保存 role capability 字符串，完整 `roleRevision` 与有效 grant join
仍是实现缺口；V1 必须显式补齐或在任务冻结时计算，而不能在报告里假设已经存在。

### 11.5 核心 V1 的最小切片

为避免网络基础 V1 膨胀，本轮只实现：

- 一个 TS orchestration surface；
- `net.search/fetch/extract` 的 capability implementation/binding；
- capability-index 中由同一事实源生成的 `by-capability` 与“TS 可调用能力”小节；
- task trace 中的 `{deploymentCatalogVersion, effectiveCatalogVersion, capabilityId,
  implementationId, executeBinding}`；
- exact capability/family grant 的确定性展开与 CI 冲突检查。

本轮不发布通用 `listLanguages/resolveCapability` API，不把 Python/Bash 宣称为网络能力宿主，也不
做语言成本排序。完整双索引产品面进入 V1.1。

### 11.6 V1.1 查询接口

在更多 orchestration surface 真正满足注入/静态审核条件后，再提供只读查询：

```ts
listLanguages({ effectiveCatalogVersion })
  → [{ surface, status, reason, executionLanguages, implementationLanguages }]

listCapabilities({ effectiveCatalogVersion, orchestrationSurfaceId? })
  → [{ capability, authorized, implementationCandidates, discoveryChannels }]

resolveCapability({ effectiveCatalogVersion, capabilityId, preferredImplementationLanguage? })
  → { candidates, authorizationRequirements, availabilityDecisionRef }
```

`resolveCapability` 不执行代码、不签发 grant、不自动修改 role，也不允许 LLM 通过指定语言绕过
capability 授权。语言偏好只排序已授权候选，不能改变 grant、profile 或 provider policy；真正执行
仍走 TCE。

### 11.7 事实源与派生策略

- 扩展后的 canonical PTC capability record 是 capability source；
- `ExecutionTargetRegistry.list()` 只提供 notebook/runtime execution target；
- `ExecuteServiceDefinition` 单独提供 network gateway/extractor 等 typed service；
- role vocabulary 必须从 capability ID/family 规则派生或经 CI 做双向完整性校验；
- deployment snapshot 与 per-task effective snapshot 分层冻结；
- 现有 capability-index 继续生成，TS 小节由 binding 派生；
- V1 不建 catalog PG 表、不做向量检索、不做 LLM 自动选语言和成本优化。

### 11.8 与网络 V1 的结合

可以用以下初始映射验证范式：

| Capability | Orchestration host | Execution/implementation language | Execute binding |
|---|---|---|---|
| `net.search` | TS typed proxy | adapter-defined | `execute-service:network-broker` |
| `net.fetch` | TS typed proxy | TS secure transport | `execute-service:network-broker` |
| `net.extract` | TS typed proxy | TS Readability 或 Python Trafilatura | `execute-service:extractor` |
| `python.run/eval` | TS typed proxy/tool projection | Python execution language | `execution-target:sandbox` |
| `bash.run/eval` | TS typed proxy/tool projection | Bash execution language | `execution-target:sandbox` |
| `net.download`（V1-B） | TS typed proxy | external tool | `execute-service:tool-gateway` → network container |

这张表说明“能力的实现语言”“被执行代码的语言”和“LLM 的编排语言”可以不同。LLM 通过
capability 选择语义，通过派生索引理解实现/运行表面，但不会接触底层命令。

## 12. 实施分期

### 12.1 Wave 0：文档与边界校正

目标：实施前先消除互相矛盾的事实源。

- 将 `kernel-ts` 定义为 PTC orchestration runtime，而不是网络服务 host；
- 将旧 `PtcCapabilityHost` 字段迁移/改名为 `codeHost`，另建判别式 Execute binding；
- 冻结 `search-public`、预留但禁用的 `research-public`，以及独立 Intake trace 分类；
- 将 `source-discovery/auto-expansion` 标为“尚未进入生产装配的实验骨架”，并保持关闭；
- 明确 toolstore `agent-reach` 的 `ext.use` 路径需要收口，secrets CLI 也不能直接成为
  engine-visible Agent 工具。

完成标准：架构文档、CONTEXT 术语、PTC/Execute ownership 没有相反描述。

### 12.2 Wave 1：契约与 Catalog

目标：先定义稳定语义，不接真实网络。

- 在 contracts 增加版本化 Search/Fetch/Extract/Artifact/Trace/Error 类型；
- 在 `PTC_CAPABILITIES` 增加 `net` family 和三个核心能力；
- 为旧 `reach.webRead` 定义静态展开为 `net.fetch + net.extract` 的透明 Code projection，且不注册
  `net.read` capability；
- 增加 `CapabilityImplementation`、`ExecuteServiceDefinition` 与 TS invocation binding；
- 从同一事实源生成 by-capability 与“TS 可调用能力”文档；
- 用 fake Execute client 完成 contract、projection、static audit 和 injection 测试。

完成标准：没有 provider 也能完整验证 Tool→Code→typed Execute request，未授权调用的 backing
call 数为 0。

### 12.3 Wave 2：Execute 网络基础服务

目标：接通一个最小真实主路径。

- 把安全传输的逻辑 ownership 移到 Execute 公共网络底座，保留旧 import barrel 兼容；
- 实现 `NetworkExecuteGateway`、OperationPolicy、Budget 与 ProviderRegistry；
- 接一个 raw-hit SearchProvider；
- 实现 `net.fetch` 的 public profile；
- 接一个无网络 deterministic extractor；
- 实现 lease-attempt-scoped ArtifactStore adapter 和结构化 trace；
- provider secrets 仅在 Execute 可见。

完成标准：真实公开 HTTPS 的 `search → fetch → extract` 可以由一段 PTC Code 串联，任何一步失败
都能独立归因。

### 12.4 Wave 3：兼容投影与零散能力收编

目标：消除平行工具面。

- `web.get/reach.webSearch/reach.webRead` 变为 Code projection，其中 `reach.webRead` 直接展开为
  两个底层调用；`web.fetchText` 通过服务端冻结的 `legacy-web-fetch-text` implementation binding
  进入同一 Execute fetch port 的限时 legacy policy；
- 修改 role/prompt，从模糊 `web + ext` 转为精确 `net.*` grants；
- 将旧入口调用写入 deprecation trace；
- 评估并迁移 GitHub、B 站、V2EX adapter；
- `yt-dlp` 继续走现有 network container 的固定 argv；
- `doctor/checkUpdate` 作为 admin capability，不混入普通 Research profile。

完成标准：同一语义只有一个 capability definition 和一个授权路径；legacy 名称没有独立 I/O
实现。

### 12.5 Wave 4：策略、来源与可观测

目标：使 V1 可安全运行、可诊断、可计量。

- `search-public` 的 provider/source/egress/budget/retention policy，并冻结 disabled
  `research-public` 与独立 Intake trace 分类；
- provider、publisher、processor 三方身份与版本留痕；
- query redaction、敏感输入拒绝、凭据泄漏回归；
- attempts、partial、stopReason、bytes、latency、billable units 观测；
- provider health 与配置错误不暴露 secret；
- Search/Research 到 Intake 的类型隔离测试。

### 12.6 Wave 5：验收与文档收尾

- TCE coverage 纳入所有 `net.*` 和 legacy projection；
- 更新 concepts、architecture、module ownership、execution topology；
- 对照本报告运行 V1 acceptance matrix；
- 记录基准：Code proxy 固定开销、provider 延迟、extract 吞吐、artifact 大小；
- 不因为 V1 完成而打开 Intake 自动扩源或声明 Deep Research 可用。

### 12.7 建议文件落点

| 责任 | 建议位置 | 备注 |
|---|---|---|
| wire/domain contracts | `packages/pth-contracts/src/network-information.ts` | 无运行时/provider 依赖 |
| PTC capability definitions | `packages/pth-kernel-interpreter/src/ptc/contract.ts` | Tool/Code 单一事实源 |
| capability binding contracts | `packages/pth-contracts/src/capability-catalog.ts` | V1 仅 TS+`net.*`；完整双索引 API 在 V1.1 |
| Code typed proxy | `packages/pth-kernel-execution/src/execution/ptc/capabilities/network-proxy.ts` | 不包含 socket/credential |
| Execute gateway | `src/pth/execution/network/gateway.ts` | policy、budget、routing |
| provider adapters | `src/pth/execution/network/providers/*` | 每个 adapter typed、可替换 |
| secure transport | `src/pth/execution/network/safe-http-transport.ts` | 旧 kernel 路径保留兼容再导出 |
| extractor adapters | `src/pth/execution/network/extractors/*` | 默认离线、无二次网络 |
| artifact adapters | `src/pth/execution/network/artifacts/*` | V1 task + PG-inline，未来 object |
| task injection | `src/pth/runner/exec-modes/task-capability-inject.ts` | method-level grant |

目录名是实施建议，不是新的上位事实源；实际提交前仍应按 package boundary 检查器确认依赖方向。

## 13. V1 验收矩阵

### 13.1 TCE 与授权

1. `net.*` tool schema 全部从 `PTC_CAPABILITIES` 派生，不存在第二份手写 schema。
2. tool-call 与 PTC program 最终进入同一 Code capability；legacy `web.fetchText` 复用同一 typed
   Execute fetch port，但其 HTTP-compatible policy 只能由服务端冻结的 implementation binding
   选择，与新能力明确分离并带 deprecation trace；公开请求中不存在兼容模式开关。
3. role 未声明 `net.search` 时，静态审核失败，Execute/provider 调用数为 0。
4. role 只有 `net.fetch` 时不能调用 `net.search` 或 `net.extract`。
5. Code 环境无 ambient `fetch/net/process/require/import/secrets`。
6. Execute binding 不能由 LLM 以字符串随意指定；resolver 只从已登记 implementation 选择。

### 13.2 功能与契约

1. 一个真实 raw-hit provider 能返回符合 `net.search.response/v1` 的结果。
2. provider 空、限流、超时、认证失败分别有可区分 attempt/status。
3. fallback 只发生在语义兼容 implementation 间，并保留全部 attempts。
4. `net.fetch` 保存 final URL、redirect chain、media type、hash 和 byteLength。
5. 超限响应不产生完整 artifact；V1 不提供 preview representation。
6. `net.extract` 对同一 artifact hash、extract request、processor version/config 产生相同 output
   hash，且不发起网络。
7. `reach.webRead` 投影在静态审核前展开为 `net.fetch + net.extract`，缺少任一 grant 都失败；trace
   可见独立 fetch/extract 两步，Catalog 中不存在独立 `net.read` grant。

### 13.3 安全

1. `file:`、`ftp:`、localhost、私网、link-local、metadata、特殊 IP 和 credential URL 在 provider/
   transport 实际调用前被拒绝。
2. 每次 redirect 重新校验 scheme、origin、DNS/IP 和 policy。
3. DNS rebinding、压缩炸弹、chunked 超限、慢响应与异常 MIME 有负向测试。
4. 敏感 query 或 URL 被 policy 拒绝时，第三方 provider 调用数为 0。
5. provider error、doctor 和 trace 中不出现 key、Authorization、cookie 或完整敏感 query。
6. 恶意网页中的工具指令不会产生 shell、secret、Intake write 或第二次隐式网络操作。

### 13.4 来源与处理链

1. 每个 SearchHit 同时记录 discovery provider 和 publisher origin。
2. 远程 reader/extractor 必须作为 processing intermediary 留痕。
3. 任意 provider score、source kind hint 都不能写成 `trusted=true`。
4. Search/Research 类型不能传给 Intake EvidenceReference 校验器。
5. 当前 `auto-expansion` 的 success-count trust 逻辑不在生产装配中。

### 13.5 存储与恢复

1. V1 的 operation-level trace 通过既有持久审计/任务轨迹关联 task、role/grant、profile、effective
   catalog snapshot 和 attempts；它是未来 Research ledger 的输入，不新建或冒充研究账本。
2. task artifact hash/length 可重算；payload 丢失时返回明确 tombstone/missing，不伪造内容。
3. Intake 现有 artifact/revision append-only、tenant、policy 和 CAS 门禁全部回归通过。
4. V1 不因搜索而无限增长 PG raw payload；retention 行为有测试。
5. Object Store 未部署时，大对象得到显式 `unsupported/size-limit`，不悄悄落任意文件路径。

### 13.6 双索引与可发现性

1. 核心 V1 只发布 TS orchestration surface；Python/Bash 不显示为 PTC host。
2. TS 小节与 by-capability 投影中的同一 `net.*` binding 数量、ID 和版本一致。
3. implementation 必须引用真实 capability 和判别式 Execute binding；悬空引用 CI 失败。
4. role grant 与 PTC 点形 ID/family 的展开规则唯一；未知、歧义或 alias 冲突使 CI 失败。
5. Execute service unavailable 时保留 capability 并显示 unavailable + reason，不假称可执行。
6. 新 capability 缺 implementation/binding/tool projection 时，只按其 `discoveryChannels` 声明的
   required 项触发 CI。

### 13.7 性能与结构

V1 不设未经测量的绝对延迟数字，但必须产出基线：

- engine-internal PTC 空程序与 typed proxy 固定开销；
- Execute gateway 本地 IPC 开销；
- provider 网络延迟与 retry 放大；
- extractor 吞吐和峰值内存；
- artifact inline 与 task store 的大小分布。

验收要求不是“网络一定快”，而是 **没有把每一步 Code 控制流外置**，且能区分编排开销、IPC、
provider 延迟和解析开销。若以后考虑隔离 `kernel-ts`，必须用这份基线证明收益大于复杂度。

### 13.8 非目标防膨胀门禁

V1 代码中不应出现以下产品级对象的伪实现：

- `DeepSearchService`；
- 自动 `ResearchPlanner`；
- 多 Agent research supervisor；
- success-count source trust；
- SearchResult 直接转 official/candidate；
- 未实现语义的 `coverageScore=1` 或 `complete=true`；
- 用 provider fallback 数量冒充“来源交叉验证”。

## 14. 后续版本路线

### V1：网络信息基础设施

本报告范围：typed primitives、Execute adapters、TCE injection、source/processor trace、operation
profiles、ArtifactRef、TS+`net.*` 最小索引 binding 和兼容收口。

### V1.1：更多基础实现

在不改变语义契约的前提下增加：

- GitHub、论文库、新闻、B 站等垂直 provider；
- 完整 Deployment/Effective CatalogSnapshot、语言—能力双索引查询 API；
- Python/Bash 在满足 PTC 三条件后的 orchestration surface（如确有需要）；
- 第二 search provider 与可选静态 SourceRegistry；
- RSS/变化检测 adapter；
- 必要时的 Playwright browser-fetch Execute service/binding；
- PDF 文本与 page locator；
- 对象存储 adapter；
- provider 成本和质量基准。

V1.1 仍然不是 Deep Research。

### V2：单 Agent、可恢复的 Deep Research

先实现结构化单 Agent 研究运行，而不是直接多 Agent：

```text
ResearchRequest
  → ResearchSpec
  → ResearchPlan / TaskGraph
  → PTC Research Supervisor
      ↔ SearchFrontier
      ↔ EvidenceLedger
      ↔ Claim–Citation Graph
      ↔ Coverage / Budget / Stop Policy
  → Citation verification
  → ResearchBundle
```

关键状态进入 PG，使研究可以 checkpoint、恢复和审计。V2 才引入查询改写、迭代搜索、证据缺口、
矛盾处理和停止条件。`PTC Research Supervisor` 必须是可版本化、可静态审核的 PTC Code
程序/任务模板；服务端 runtime 只持久化 checkpoint、budget、lease 和 audit，不能在 Execute
内部自行决定 query、扩源、评分、反证或停止。否则它会重新退化为本报告明确拒绝的隐藏
`deepSearch` 后端。

### V2.1：动态多 Agent fan-out

只有独立分支、来源类型或媒体维度确实可并行时才派生子 Agent。子 Agent 返回结构化 evidence refs、
claims 和 limitations，不把自由文本结论当成已验证事实。主 Agent 负责合并与停止。

### V3：Research 到 Intake 的人工治理桥

V3 才实现：

```text
ResearchBundle
  → SourceCandidateProposal
  → policy diff / human review
  → signed Trust Policy
  → SourceSubscription
```

即使到了 V3，Research citation 也不能直接成为 Intake EvidenceReference；Intake 仍要重新抓取、
生成不可变 revision、核验 locator/hash、执行 admission 与 verification。

## 15. 风险与缓解

| 风险 | 影响 | V1 缓解 |
|---|---|---|
| provider API、费用和免费额度变化 | 绑定品牌后频繁改契约 | provider-neutral contract + config registry + doctor |
| toolstore/secrets 两种 `agent-reach` 被直接复用 | 绕过 PTC 或造成命令/secret 越权 | 两条路径都收口到 Execute mediator + typed request + 固定 adapter |
| 把搜索摘要当事实 | 错误引用与虚假权威 | snippet 标记 untrusted，fetch publisher 原文 |
| 远程 reader 隐藏第二次网络访问 | 数据外发、处理链不可追踪 | remote-read 独立 implementation + processing trace |
| Tool/Code/Execute 再次双轨 | 授权和观测漂移 | tool 单向投影为 Code，implementation registry 唯一 |
| `kernel-ts` 继续持有网络实现 | engine 边界与安全混乱 | 仅 typed proxy，I/O 全进 Execute |
| 所有数据塞进 PG | 备份膨胀、表 bloat、媒体不适配 | PG truth plane + ArtifactRef + future object store |
| 过早实现多 Agent | token/协调成本、难评测 | V2 先单 Agent，按独立性动态 fan-out |
| Search 自动接 Intake | 信任边界失效 | 类型隔离、feature-off、人工 policy 唯一准入 |
| “基础版”名义下伪造 completeness | 产品误导 | partial/attempts/stopReason，V1 不声明 deep research |

## 16. 最终建议

建议批准以下 V1 方案：

1. 保留 `net.*` 作为统一网络能力族；
2. 将核心范围收敛为 `search/fetch/extract`，`read` 为透明 Code 组合；
3. 保留 engine-internal `kernel-ts`，但去除其网络实现职责；
4. 新建 Execute-owned `NetworkProviderGateway`，不直接暴露 toolstore 或 secrets 两种
   `agent-reach` 执行面；
5. 拆分 orchestration host、execution language、implementation language 与
   ExecutionTarget/ExecuteService binding；
6. V1 只用同一事实源派生 TS+`net.*` 最小索引，完整语言—能力 Catalog 放 V1.1；
7. 为 provider、publisher、processor 建立独立追踪；
8. Search/Research/Intake 只共享底层安全传输，不共享信任和写入路径；
9. V1 延用 PG 内有界 Intake artifact，同时从契约上预留 ArtifactStore；
10. 把 ResearchSpec、TaskGraph、SearchFrontier、EvidenceLedger、Claim–Citation Graph、多 Agent 与
    Research→Intake 桥全部列入 V2/V3。

这条路线能以最少的新基础设施建立正确边界，又不会牺牲最终的深度与广度：广度以后来自更多
provider、平台和并行分支，深度以后来自 Code 层的持续研究循环；V1 的每个原语和 trace 都可以
原样被后续 Research Runtime 复用。

## 17. 参考材料

### 17.1 仓库事实源

- [ADR-0004：TCE 的 C 是 Code](../../adr/0004-tce-code-layer-ptc-capability-first.md)
- [TCE 网络模块整合重构设计](../design/tce-network-module-refactor-design.md)
- [N26 自主知识摄入设计](../design/n26-autonomous-knowledge-intake-design.md)
- [N29 最小可信知识摄入报告](./n29-minimal-intake-report.md)
- [存储后端架构分析](./storage-backend-analysis.md)
- [PTC 能力契约注册表](../../../packages/pth-kernel-interpreter/src/ptc/contract.ts)
- [PTC 工具投影](../../../packages/pth-kernel-interpreter/src/ptc/tools.ts)
- [方法级静态审核](../../../packages/pth-kernel-interpreter/src/ptc/surface.ts)
- [任务级能力注入](../../../src/pth/runner/exec-modes/task-capability-inject.ts)
- [engine-ts 解释器](../../../src/pth/impls/kernels/ts-interpreter.ts)
- [安全 Web transport](../../../src/pth/impls/kernels/web-transport.ts)
- [Intake fetch broker](../../../src/pth/execution/knowledge-intake/fetch-broker.ts)
- [ExecutionTarget 契约](../../../packages/pth-contracts/src/execution-target.ts)
- [ExecutionTarget Matrix](../../../deploy/executor-matrix.json)
- [Runtime Catalog](../../../src/pth/catalog/runtime-catalog.ts)
- [Role Definition Vocabulary](../../../src/pth/catalog/role-definition-v1.ts)
- [工具容器 manifest](../../../deploy/tool-containers/tool-manifest.json)

### 17.2 Deep Research 方法

- [WebGPT: Browser-assisted question-answering with human feedback](https://arxiv.org/abs/2112.09332)
- [ReAct: Synergizing Reasoning and Acting in Language Models](https://arxiv.org/abs/2210.03629)
- [IRCoT: Interleaving Retrieval with Chain-of-Thought Reasoning](https://arxiv.org/abs/2212.10509)
- [FLARE: Active Retrieval Augmented Generation](https://arxiv.org/abs/2305.06983)
- [STORM: Synthesis of Topic Outlines through Retrieval and Multi-perspective Question Asking](https://arxiv.org/abs/2402.14207)
- [Self-RAG: Learning to Retrieve, Generate, and Critique](https://arxiv.org/abs/2310.11511)

这些工作共同支持“研究是可持续的检索—观察—更新循环，而不是单次搜索调用”的判断；但本报告
只吸收它们对 V1 契约和后续演进的启示，不在 V1 实现其研究策略。

### 17.3 工具分层参考

- [SearXNG](https://github.com/searxng/searxng)：元搜索与统一发现入口
- [Crawl4AI](https://github.com/unclecode/crawl4ai)：面向 LLM 的抓取与内容转换
- [Scrapy](https://github.com/scrapy/scrapy)：队列、调度、重试与批量爬取
- [Crawlee](https://github.com/apify/crawlee)：TypeScript 爬取框架与浏览器集成
- [Playwright](https://github.com/microsoft/playwright)：动态网页与浏览器执行
- [Trafilatura](https://github.com/adbar/trafilatura)：正文和元数据抽取
- [Readability](https://github.com/mozilla/readability)：确定性主内容抽取
- [Firecrawl](https://github.com/firecrawl/firecrawl)：一体化 Web context 服务参考
- [ArchiveBox](https://github.com/ArchiveBox/ArchiveBox)：网页证据与历史归档参考

这些项目是可替换的 Execute implementations 或产品对照，不应成为 PTH 的语义契约本身。
