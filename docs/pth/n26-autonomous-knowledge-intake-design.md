# N26：PTH 自主知识摄入设计

> 日期：2026-08-18
>
> 状态：**部分实施**——最小内环已由 N29 落地并验收（MIN_INNER_LOOP_GO，见 n29-minimal-intake-report.md）；本文的完整设计（外环 / 广度摄入）未实施
>
> 上位设计：[N16 角色/领域组合设计](./n16-v1.2-role-domain-composition-design.md)
>
> 术语事实源：[CONTEXT.md](../../CONTEXT.md)
>
> 可靠性基线：[v1.2 F1–F5 复验报告](./v1.2-acceptance-fix-revalidation.md)

## 0. 执行摘要

PTH 需要能够主动寻找知识来源、持续抓取和识别变化、抽取候选知识、完成核验与晋升，并在
来源发生变化时自动重算依赖知识。正常路径在来源获得人类信任后不再要求人逐步参与。

本设计作出以下裁决：

1. **不新增顶层 Intake Module。** Knowledge Intake 是既有 PTH Knowledge 能力边界内的
   write-side application service；不修改 PTH module manifest。
2. **工具与交互核是处理器，不是事实源。** 它们可以执行发现、抓取、解析、抽取和核验，
   但不拥有来源订阅、运行状态、信任策略、修订历史、CAS 或晋升状态。
3. **人类是唯一信任授予者。** LLM 可以推荐任意网页，但推荐结果只能成为不受信的
   Source Candidate。只有人类维护的版本化 Trust Policy 可以允许某个 authority/origin/path
   进入自动摄入。
4. **信任来源不等于相信来源中的每句话。** 来源准入解决“系统是否可以读取并使用这类
   内容”；事实正确性仍要经过领域核验、对抗核验、证据完整性和职责分离。
5. **自动结果先进入 draft。** KnowledgeIngestor 只接受带不可变 Source Revision 和
   Evidence Reference 的候选，并只写 Knowledge Candidate；任何抓取或 LLM 处理器都不能
   直接写 official。
6. **状态迁移必须可恢复。** Intake Run、下一次重爬时间、lease、attempt、checkpoint 和
   outbox 均以 PostgreSQL 为真相源；Trigger 只负责唤醒。
7. **保留现有角色。** spider、researcher、controller:adversarial、memory-keeper 执行不同
   阶段，不新增常驻 worker role，也不让角色拥有权威状态。
8. **先补可靠性前置条件，再开放自动晋升。** transactional outbox、严格 candidate CAS、
   Verification Plan、结构化 Evidence Reference 和 recon-doc 旁路收口是生产启用条件。

目标闭环如下：

~~~text
coverage gap
  → LLM/source processor recommends pages
  → Source Candidate
  → human-authored fetch-policy match
  → Source Subscription
  → scheduled Intake Run
  → quarantined immutable Source Revision
  → human-authored use-policy match
  → admitted immutable Source Revision
  → extracted Knowledge Candidate
  → canonicalization / dedupe proposal
  → domain + adversarial verification
  → atomic promotion of the exact verified hash
  → official knowledge
  → recrawl / change detection / stale propagation
~~~

## 1. 问题与边界裁决

### 1.1 为什么已有工具与交互核还不够

PTH 已具备定义工具、加载程序、调用 agent 和注册交互核的能力。这些能力可以完成一次函数
执行，但以下事实不能安全地只存在于工具返回值、任务 payload、worker transcript 或解释器
snapshot 中：

- 哪些来源由哪个人类策略授予信任；
- 一个逻辑来源当前订阅哪个版本、何时应重爬；
- 一次摄入运行进行到哪个阶段、由谁租借、是否已重试；
- 某次抓取实际返回的 final URI、redirect chain、原始 bytes 和内容 hash；
- 一个候选的每条声明精确引用哪一份不可变来源修订；
- 哪些核验主体对哪个 candidate hash 作出过何种 verdict；
- promotion 是否已经以同一个 expected revision 原子完成；
- 来源撤销或变化后，哪些 official 条目必须变 stale。

因此，工具与交互核只能作为 stage processor。权威状态由 Knowledge 边界内的 aggregates/
repositories 持久化，Knowledge Intake Service 负责按规则编排状态迁移。

### 1.2 为什么不拆出新的顶层 Module

N16 已把知识条目、来源、证据、版本、可见性、candidate 状态和晋升历史归属 PTH Knowledge，
并预留 KnowledgeRepository 与 KnowledgeIngestor。另建顶层 Intake Module 会把同一聚合的
来源证据与候选晋升拆成两个所有者，增加跨模块事务和重复 API，却没有独立部署、多下游消费
或独立产品 Profile 的现实需求。

本设计采用以下边界：

| 层次 | 设计裁决 |
|---|---|
| PTH module manifest | PthModuleName 保持不变，不新增 Intake 项 |
| Knowledge 能力边界 | 新增 Knowledge Intake Service 及来源/摄入 aggregates 与 repositories |
| 写入端口 | KnowledgeIngestor 校验证据与 scope，只写 draft candidate |
| 读取端口 | KnowledgeBroker 保持 grant-bound、tenant/space-bound 的只读查询 |
| 执行底座 | Task Control、ToolReg、工具、交互核与角色执行处理阶段 |
| 调度 | 持久 nextCrawlAt 为真相；Trigger 只唤醒 due-run scanner |
| 基础设施 | PostgreSQL 保存权威状态和有界 artifact；Redis/SSE 仅通知 |

以下任一条件长期成立时，才重新评估是否抽成顶层 Module：

- Intake 需要独立部署、独立安全域或独立发布节奏；
- 多个非 Knowledge 下游直接消费其 Source Revision；
- 出现稳定、公开、脱离 Knowledge 仍有意义的应用 API；
- 跨边界事务已被明确的事件一致性模型替代；
- 独立 Profile 需要启停 Intake 而不启停 Knowledge。

在这些条件出现前，不创建 AKI kernel、Intake worker role 或顶层 module。

## 2. 目标与非目标

### 2.1 目标

- 根据 Domain Catalog 和知识覆盖缺口自动生成发现任务；
- 允许 LLM、搜索适配器和 spider 推荐可能来源；
- 让人类通过一个版本化策略一次性批准来源范围，而不是逐页批准；
- 在获准范围、预算和重爬策略内完成零人工 happy path；
- 保存不可变、可重放、可定位的来源修订与证据；
- 自动抽取 draft candidate，并完成有职责分离的核验与晋升；
- 处理跨版本、来源冲突、许可变化、撤销、过期和内容漂移；
- 以生产 Broker/Context 路径验证真正可消费的知识广度；
- 保持 tenant、space、grant、principal 和 source origin 的 fail-closed 隔离。

### 2.2 非目标

- 不让 LLM 自行授予来源信任、扩大路径、解释许可例外或修改 Trust Policy；
- 不把网页排名、搜索结果或来源权威度直接等价为事实真值；
- 不新增 Web UI、外部对象存储、向量数据库或独立服务；
- 不恢复已归档的 agent-lab ingestion loop；
- 不把 pilot source registry/snapshot 变成生产 runtime registry；
- 不用现有 recon-doc 的 direct official 写入作为摄入路径；
- 不把 Task、Trigger、Tool、Interpreter snapshot 或自由形态 MemoryEntry.meta 当运行事实源；
- 不在第一阶段提供动态来源审批 API；人类先通过版本控制的 Trust Policy manifest 授权；
- 不因“自动化”降低 evidence、tenant、license、prompt-injection 或 promotion 门禁。

## 3. 总体架构

~~~mermaid
flowchart LR
    CP["Coverage Planner"] --> DP["Discovery Processor<br/>LLM / search / spider"]
    DP --> SC["Source Candidate<br/>untrusted"]
    H["Human"] --> TP["Trust Policy<br/>versioned · read-only"]
    TP --> PM{"Deterministic<br/>policy match"}
    SC --> PM
    PM -->|"fetch-authorized"| SS["Source Subscription<br/>probing / active"]
    PM -->|"unknown / exception"| AT["awaiting-trust"]
    PM -->|"deny"| RJ["rejected"]

    SS --> DS["Due-source scanner"]
    T["Trigger<br/>wake-up only"] --> DS
    DS --> TC["Task Control"]
    TC --> FB["Hardened Fetch Broker"]
    FB --> SR["Immutable Source Revision<br/>raw quarantined"]
    SR --> UM{"Deterministic<br/>use-policy match"}
    TP --> UM
    UM -->|"use-authorized"| AR["Admitted Source Revision<br/>reuses raw artifact"]
    AR --> EP["Extraction Processor"]
    UM -->|"unknown / exception"| AT
    UM -->|"deny"| UQ["quarantined / rejected"]
    EP --> KI["KnowledgeIngestor"]
    KI --> KC["Knowledge Candidate<br/>draft"]
    KC --> MKC["memory-keeper<br/>canonicalize draft"]
    MKC --> VP["Verification Plan"]
    VP --> DV["Domain verifier"]
    VP --> AV["controller:adversarial"]
    DV --> PR{"Promotion gate"}
    AV --> PR
    PR --> PS["Atomic Promotion Service<br/>no content mutation"]
    PS --> OF["Official Knowledge"]
    OF --> KB["KnowledgeBroker / Context<br/>read-only consumption"]

    SS --> RC["nextCrawlAt"]
    RC --> DS
    SR --> CD["Change detector"]
    CD -->|"material change"| ST["Mark dependent entries stale"]
    ST --> EP
~~~

### 3.1 职责矩阵

| 构件 | 拥有 | 不拥有 |
|---|---|---|
| Knowledge Intake Service | 编排 Trust Policy 匹配、幂等、CAS、审计和下一阶段 outbox | 直接保存状态、网络协议细节、LLM 推理、Task lease、official 读取 |
| Knowledge Intake aggregates/repositories | Source Candidate/Subscription、Intake Run、Source Revision 的权威状态与不变量 | processor 执行、来源授信规则的创作 |
| KnowledgeIngestor | scope/evidence/provenance 校验；draft candidate 写入 | 抓取、调度、来源授信、direct official |
| Source/Discovery/Extraction Processor | 一个阶段的计算和结构化结果 | 权威状态迁移、策略修改、晋升 |
| Hardened Fetch Broker | egress policy、DNS/IP/redirect/bytes/time/decompression 限制、artifact envelope | 来源授信、事实核验 |
| Task Control | processor task 的 publish/claim/lease/outcome | Intake aggregate 与 nextCrawlAt |
| Trigger | 唤醒 due-source scanner | 计时真相、重爬游标 |
| Verification Service | Verification Plan、verdict 与职责分离 | 来源授信、抓取 |
| Knowledge Promotion Service | 严格 revision/hash CAS、官方状态与 index outbox | 发现来源、改写已核验 content/evidence |
| KnowledgeBroker / Context | official 知识的受限读取 | Intake 写入或晋升 |
| 人类 | Trust Policy 的授予、修改和撤销 | 每次正常抓取和每条事实的手工搬运 |

## 4. 人类唯一信任源

### 4.1 两种“信任”必须分开

来源信任和事实核验是两个正交门：

1. **Source admission**：人类是否允许系统在给定租户、域、origin、path、许可和预算内抓取并
   使用内容。唯一授予者是人类维护的 Trust Policy。
2. **Claim verification**：从获准来源抽取出的具体声明是否被证据支持、是否冲突、是否过期、
   是否受到 prompt injection 或处理器偏差影响。由确定性检查和职责分离的 verifier 完成。

一个来源被批准，不代表其内容自动为真；一个 LLM 认为来源权威，也不能让来源越过 admission。

### 4.2 第一阶段 Trust Policy 载体

为减少改动，首版采用受版本控制和部署权限保护的 manifest，而不是新建来源审批服务。运行时：

- 只读加载 manifest；
- 对 schema、版本、唯一 ruleId 和内容 digest 做校验；
- 验证由受信配置发布流程生成、绑定 tenant/space/policy digest 的人类 approval proof；
- 把 manifest version、digest、匹配 ruleId、approvedBy 稳定主体写入每次 admission 和 revision；
- manifest 无效、缺失或版本回退时 fail closed；
- LLM、worker、tool、kernel 和摄入服务都没有修改接口；
- 未匹配候选停在 awaiting-trust，不阻塞其他已获准订阅。

逻辑契约如下：

~~~typescript
interface HumanPrincipalRef {
  kind: "human";
  principalId: string;
  tenantId: string;
}

interface TrustPolicyManifest {
  policyId: string;
  version: string;
  tenantId: string;
  spaces: readonly string[];
  issuedAt: string;
  validFrom: string;
  expiresAt?: string;
  approvedBy: HumanPrincipalRef;
  approvalProof: {
    method: "signed-manifest" | "reviewed-release";
    proofRef: string;
    signerPrincipalId: string;
    signedPolicyDigest: string;
  };
  rules: readonly SourceTrustRule[];
  digest: string;
}

interface SourceTrustRule {
  ruleId: string;
  effect: "allow" | "deny";
  authority: string;
  spaces: readonly string[];
  fetchScope: {
    origins: readonly string[];
    pathPrefixes: readonly string[];
    redirectOrigins?: readonly string[];
    maxBytes: number;
    budget: {
      maxRequestsPerRun: number;
      maxBytesPerRun: number;
      maxConcurrent: number;
    };
  };
  useScope: {
    domains: readonly DomainId[];
    sourceTypes: readonly SourceType[];
    allowedLicenses: readonly string[];
    licenseAssertions?: readonly {
      pathPrefix: string;
      expression: string;
      basisRef: string;
    }[];
    contentTypes: readonly string[];
  };
  recrawl: {
    minIntervalMs: number;
    maxIntervalMs: number;
    changeStrategy: "etag" | "last-modified" | "content-hash" | "always";
  };
}
~~~

digest 由移除 digest 与 approvalProof 后的 canonical manifest 计算；approvalProof 绑定该 digest。
approvedBy 只是显示字段，不能代替 proof 校验。signer 必须由认证系统证明为同 tenant 的
human principal；service/worker principal 即使拥有部署能力也不能成为来源信任授予者。首版
可以复用受控配置发布/镜像签名流程，不要求新建在线审批 API。

proof 校验还必须满足 signerPrincipalId = approvedBy.principalId、signedPolicyDigest = digest，
且当前时间位于 policy 有效期内。

### 4.3 确定性匹配规则

准入分成两道独立决定：

1. **fetch authorization** 只根据人类规则中的 tenant/space/origin/path/redirect/budget 允许一次
   有界抓取；抓回的 raw artifact 仍是 quarantined，不得进入语义 parse/extract。此时只允许
   无网络、无工具、确定性的 admission inspector 读取响应头和许可元数据。
2. **use authorization** 在真实 response contentType、license 和 source identity 可验证后，
   再匹配 domain/sourceType/license/contentType。只有 use-authorized revision 能进入 parse、
   extract、verification 和 promotion。

具体规则：

1. URI 先进行 scheme、host、port、path 的严格 canonicalization；只允许 HTTPS，除非人类规则
   明确提供更严格的本地 connector。
2. candidate 的 tenant/space 必须同时命中 manifest 与 rule scope；policy 不跨 tenant 复用。
3. deny 优先于 allow；多个 allow 同时命中时取交集最窄的权限，不做权限并集。
4. authority 名称只是标签，真正网络边界由 exact origin 和 path prefix 决定；不根据 LLM
   生成的“官方网站”文字自动匹配。
5. redirect 的每一跳都重新做网络安全检查和 fetch policy match；未获准跳转立即 quarantine。
6. 实测 license/contentType 必须通过 use policy；未知、冲突或发生变化时进入
   awaiting-trust/quarantined。
7. 请求的 domain、sourceType、contentType、bytes、频率或并发超出对应 fetch/use rule 时拒绝
   或 quarantine；
   处理器不能自行降级规则后继续。
8. 所有 admission 决定记录 tenant、space、policyId、version、digest 和 ruleId。Policy 变化
   不会改写历史决定。
9. 历史 PolicyDecisionRef 是审计证据，不是永久授权。fetch claim/revision store 重新确认
   fetch decision；parse/candidate creation/promotion 重新确认 use decision。任一当前 policy
   已过期、撤销或不再覆盖同一 tenant/space/scope 时，终止或 quarantine。

LLM 提议的 sourceType/license 只作 hint。use matcher 只接受响应元数据、确定性 inspector 结果，
或人类 policy 中绑定 path 与 basisRef 的明确 license assertion。

### 4.4 何时必须重新请求人类

- 新 authority、origin 或 path scope；
- 未知许可、许可变化或再分发/训练用途不明确；
- redirect 到未获准 origin；
- 需要提高 bytes、频率、并发或总预算；
- 来源出现隐私、法律、认证或访问控制例外；
- 信任撤销、来源 takedown 或 policy 冲突；
- 处理器建议使用 robots/terms 明确禁止的路径。

其他正常抓取、内容更新、抽取、核验、晋升和重爬不要求人类逐步参与。

未来 Human Interaction 可以展示 awaiting-trust、收集解释并生成 policy diff proposal，但单个
Human Response/Approval Decision 不能直接把 Source Candidate 改为受信。只有经过同一人类
proof 与配置发布门的新版 Trust Policy 才能产生准入决定。

## 5. 核心数据契约

下列契约表达领域不变量，不预先锁定最终目录或 SQL 列布局。

来源类型使用 machine-readable 枚举，不用任意标签代替多样性：

~~~typescript
type SourceType =
  | "standard"
  | "official-documentation"
  | "government-dataset"
  | "reference-database"
  | "peer-reviewed-paper"
  | "institutional-repository"
  | "book"
  | "archive";
~~~

新增类型必须经人类 policy 与 Catalog 版本化，不由 LLM 临时造词。

~~~typescript
interface PolicyDecisionBase {
  tenantId: string;
  space: string;
  policyId: string;
  policyVersion: string;
  policyDigest: string;
  ruleId: string;
  approvedByPrincipalId: string;
  effectiveScopeDigest: string;
  effectiveFrom: string;
  effectiveUntil?: string;
  decidedAt: string;
}

type FetchPolicyDecisionRef = PolicyDecisionBase & {
  phase: "fetch";
  effectiveScope: {
    origin: string;
    pathPrefix: string;
    redirectOrigins: readonly string[];
    maxBytes: number;
    budgetHash: string;
  };
};

type UsePolicyDecisionRef = PolicyDecisionBase & {
  phase: "use";
  effectiveScope: {
    domains: readonly DomainId[];
    sourceTypes: readonly SourceType[];
    contentTypes: readonly string[];
    allowedLicenses: readonly string[];
    licenseAssertionRefs: readonly string[];
    recrawlPolicyHash: string;
  };
};

type PolicyDecisionRef = FetchPolicyDecisionRef | UsePolicyDecisionRef;

interface PrincipalExecutionRef {
  principalId: string;
  executionId: string;
  roleId?: string;
  grantId?: string;
}
~~~

PolicyDecisionRef 只记录确定性 matcher 对人类 policy 的应用结果，不是新的信任授予行为。

### 5.1 Source Candidate

LLM、搜索适配器和 spider 只能提交 Source Candidate。提交者的 authority score 是建议值，不是
信任结论。

~~~typescript
interface SourceCandidate {
  id: string;
  tenantId: string;
  space: string;
  proposedUri: string;
  canonicalUri?: string;
  targetDomains: readonly DomainId[];
  proposedSourceType?: SourceType;
  discovery: {
    query: string;
    coverageGapIds: readonly string[];
    proposedBy: PrincipalExecutionRef;
    discoveredAt: string;
  };
  status:
    | "proposed"
    | "fetch-authorized"
    | "subscribed"
    | "awaiting-trust"
    | "rejected";
  fetchPolicyDecision?: FetchPolicyDecisionRef;
  rowVersion: number;
}
~~~

不变量：

- tenant + canonical URI + target scope 具有确定性去重键；
- proposedBy 必须是服务端签发的 principal/execution，不接受 body 自报；
- 任何 recommendation 文本都按不受信数据保存，不参与 policy 代码执行；
- 只有 fetch-authorized 才能创建 status=probing 的 Source Subscription；
- probing 只允许一次有界 acquisition；use authorization 成功后才可转 active/subscribed。

### 5.2 Source Subscription

Source Subscription 表示一个可做初始有界探测、并在 use-authorized 后持续重爬的逻辑来源，
不等价于某次 HTTP 响应。

~~~typescript
interface SourceSubscription {
  id: string;
  tenantId: string;
  space: string;
  canonicalRoot: string;
  authority: string;
  sourceType: SourceType;
  domains: readonly DomainId[];
  connectorId: string;
  fetchPolicyDecision: FetchPolicyDecisionRef;
  usePolicyDecision?: UsePolicyDecisionRef;
  recrawlPolicy: RecrawlPolicy;
  nextCrawlAt: string;
  lastSuccessfulRevisionId?: string;
  status:
    | "probing"
    | "active"
    | "paused"
    | "awaiting-trust"
    | "revoked"
    | "retired";
  rowVersion: number;
}
~~~

不变量：

- probing 订阅只能抓取并保存 quarantined raw revision，不能 parse/extract；
- usePolicyDecision 生效后，订阅才转 active，Source Candidate 才转 subscribed；
- nextCrawlAt 是 PostgreSQL 中的权威调度游标；
- policy version 或 source identity 改变时必须创建新 revision/decision，不原地伪装历史；
- revoked/retired 订阅不能生成新 run；
- connector 只是协议 adapter，不得扩大 policy scope。

### 5.3 Intake Run

Intake Run 是一次持久、幂等、可租借和恢复的摄入尝试。

~~~typescript
interface IntakeRun {
  id: string;
  tenantId: string;
  subscriptionId: string;
  reason: "initial" | "scheduled" | "manual-retry" | "policy-refresh";
  status:
    | "queued"
    | "leased"
    | "fetched"
    | "raw-revision-stored"
    | "use-authorized"
    | "admitted-revision-stored"
    | "extracted"
    | "completed"
    | "quarantined"
    | "failed"
    | "dead-letter";
  stage:
    | "fetch"
    | "store-raw-revision"
    | "admission-inspect"
    | "store-admitted-revision"
    | "extract"
    | "verify-handoff";
  attempt: number;
  lease?: {
    token: string;
    principal: PrincipalExecutionRef;
    lockedUntil: string;
  };
  policyDecisions: readonly PolicyDecisionRef[];
  budget: IntakeBudgetSnapshot;
  checkpoint?: IntakeCheckpoint;
  sourceRevisionId?: string;
  rowVersion: number;
  createdAt: string;
  updatedAt: string;
  lastError?: StructuredIntakeError;
}
~~~

不变量：

- run 创建使用 tenant-qualified idempotency key；
- claim 是 queued/due → leased 的原子 CAS，并签发 token + lockedUntil；
- complete/fail 必须携带同一个 token、stage、attempt 和 expected rowVersion；
- stale worker 不能覆盖新 attempt；
- 状态迁移和下一阶段 outbox 行在同一 PostgreSQL transaction 内提交；
- retry 使用 availableAt + 有界 backoff；超过阈值进入 dead-letter，不静默丢弃。

### 5.4 Source Revision

Source Revision 是某次 acquisition 的不可变事实记录，也是本设计中的 canonical snapshot。
不再另建含义重叠的 Source Snapshot 实体。

~~~typescript
interface SourceRevision {
  id: string;
  tenantId: string;
  subscriptionId: string;
  previousRevisionId?: string;
  acquiredAt: string;
  requestedUri: string;
  finalUri: string;
  redirectChain: readonly string[];
  response: {
    status: number;
    contentType: string;
    contentLength: number;
    etag?: string;
    lastModified?: string;
  };
  artifact: {
    storage: "postgres";
    rawHash: string;
    byteLength: number;
    bytesRef: string;
    representations: readonly {
      name: "raw" | "normalized-text" | "structured-json";
      hash: string;
      parserId?: string;
      parserVersion?: string;
    }[];
    reusesArtifactFromRevisionId?: string;
  };
  fetchPolicyDecision: FetchPolicyDecisionRef;
  usePolicyDecision?: UsePolicyDecisionRef;
  licenseDecision:
    | {
        status: "allowed";
        expression: string;
        basis: "observed-metadata" | "human-policy-assertion";
        basisRef: string;
        checkedAt: string;
      }
    | {
        status: "unknown" | "conflict";
        observedExpressions: readonly string[];
        checkedAt: string;
      };
  status: "stored" | "unchanged" | "quarantined";
}
~~~

首版以有界 PostgreSQL artifact storage 减少新基础设施。超过 policy maxBytes 的对象不截断后冒充
完整来源，而是 quarantine；未来可把 bytesRef 换成对象存储 adapter，不改变 Source Revision
与 Evidence Reference 语义。

每次成功 acquisition 都创建不可变 revision。HTTP 304 或相同 rawHash 可以通过
reusesArtifactFromRevisionId 复用 artifact，并跳过无意义的重新抽取，但仍保留本次抓取事实。
后续 license revocation、source withdrawal 和 takedown 以 append-only disposition event 记录，
不修改历史 Source Revision。

status=quarantined 的 revision 只有 fetchPolicyDecision；只有绑定同 tenant/space 的有效
usePolicyDecision 才能成为 stored/unchanged 并送入 extractor。人类发布新 policy 后，不原地
修改旧 revision，而是创建一个复用原 artifact 的新 revision 并记录新的 use decision。

### 5.5 Evidence Reference

~~~typescript
interface EvidenceReference {
  sourceRevisionId: string;
  artifactHash: string;
  representation: "raw" | "normalized-text" | "structured-json";
  locator:
    | { kind: "page"; page: number }
    | { kind: "section"; headingPath: readonly string[] }
    | { kind: "byte-span"; start: number; end: number }
    | { kind: "json-path"; path: string }
    | { kind: "fragment"; value: string };
  quoteHash: string;
}
~~~

不变量：

- locator 必须对 artifactHash 指向的 representation 可重放；
- artifactHash 等于所选 representation 的 hash；representation=raw 时等于 rawHash；
- quoteHash 必须由 locator 对应的精确内容计算，不能由 LLM 自报；
- evidence 缺 locator、hash 不匹配或 parser version 不可得时，candidate 只能 quarantine；
- Evidence Reference 从 DB、Candidate、Verification Plan、Broker、Knowledge Context 到用户引用
  保持同一结构，不再回退为自由文本 sourceRefs。

### 5.6 Knowledge Candidate 与 Verification Plan

Knowledge Candidate 继续使用 Knowledge 的 draft entry/revision 语义，不新建第二套知识库。
其 canonical hash 必须覆盖：

- normalized content；
- domains、kind、valid time；
- 全部 Evidence Reference；
- producer principal、execution、role；
- 按 sourceRevisionId 排序的完整 fetch/use policy bindings；
- extraction processor/version；
- canonicalization processor/version、dedupe proposal 与 supersedes target；
- candidate content revision。

memory-keeper 必须在 Verification Plan 创建前完成 canonicalization。任何 content、domain、
evidence、dedupe 或 supersedes 变化都产生新的 draft revision/hash；不能在核验后静默改写。

每个 canonical candidate 创建一个持久 Verification Plan：

~~~typescript
interface VerificationCheckRequirement {
  checkId: string;
  kind: "domain" | "adversarial";
  domainId?: DomainId; // kind=domain 时必填
  quorum: number;
  eligiblePrincipals: readonly PrincipalRule[];
  separationFrom: readonly ("producer" | "other-verifier" | "promoter")[];
  evidenceRequirements: EvidenceRequirements;
}

interface VerifiedSourceBinding {
  sourceRevisionId: string;
  authority: string;
  fetchPolicyDecision: FetchPolicyDecisionRef;
  usePolicyDecision: UsePolicyDecisionRef;
}

interface VerificationPlan {
  id: string;
  tenantId: string;
  candidateId: string;
  candidateRevision: number;
  candidateHash: string;
  checks: readonly VerificationCheckRequirement[];
  sourceBindings: readonly VerifiedSourceBinding[]; // 按 sourceRevisionId 排序
  sourceBindingsDigest: string;
  status: "open" | "satisfied" | "rejected" | "invalidated";
  rowVersion: number;
}
~~~

checks 必须为 candidate 的每个 domain 建立至少一个 domain requirement，并另建 adversarial
requirement；quorum 和 eligible principals 按 check 独立计算，不能用“任意一个 domain pass”
替代。任一 content、domain、evidence、source revision、policy binding、dedupe/supersedes 或
canonicalization 变化，旧 plan/verdict 立即失效。每个 verdict 绑定 checkId 与
sourceBindingsDigest。

## 6. 状态机与不变量

### 6.1 Source Candidate

~~~text
proposed
  ├─ fetch-policy match → fetch-authorized → probing subscription
  │    ├─ use-policy match → subscribed / active
  │    ├─ unknown / exception → awaiting-trust
  │    └─ deny → rejected / quarantined
  ├─ no matching human rule → awaiting-trust
  └─ deny / invalid / duplicate → rejected
~~~

awaiting-trust 只有在新的人类 Policy version 生效后才能重新评估；LLM 不能通过重写 URL、
authority label 或 sourceType 绕过原决定。fetch-authorized 只允许 admission probe，不等于
source content 已获准用于知识生产。

### 6.2 Intake Run

~~~text
queued → leased → fetched → raw-revision-stored
           │          │              │
           │          │              ├→ use-authorized
           │          │              │    → admitted-revision-stored
           │          │              │    → extracted → completed
           │          │              └→ quarantined / awaiting-trust
           └──────────┴────────────────────────────→ failed → retry
failed + attempts exhausted → dead-letter
~~~

状态不能倒退。重试创建新 attempt/lease，不擦除旧 attempt 记录。

### 6.3 Knowledge

~~~text
draft → canonicalized draft → verifying → promotable → official
  │             │               │             │
  ├─────────────┴───────────────┴─────────────┴→ rejected
official + material source change/revocation → stale
stale + successful re-extraction/reverification → superseded by new official revision
~~~

默认 authoritative retrieval 只返回当前有效 official。stale 仍可历史读取和审计，但不进入默认
Knowledge Context；asOf 查询按 version/valid time 显式读取。

### 6.4 全局不变量

1. 未同时通过人类 fetch/use policy 的 source revision 产生 official 条目数必须为 0。
2. processor 不能直接写 Source Revision、candidate verdict 或 official 状态。
3. 生产者不能核验自己的 candidate；domain verifier、adversarial verifier 与 promoter 使用不同
   server principal/execution。
4. verdict 必须严格绑定 plan checkId、candidateRevision、candidateHash 和
   sourceBindingsDigest；每个 candidate domain 的 quorum 独立满足。
5. promotion 必须在一个 transaction 内完成 expected-revision/status CAS、决定写入、official
   revision、supersedes 和 index/outbox，且不得修改已核验的 content/domain/evidence/hash。
6. 每个 official 断言都能沿 Evidence Reference 回放到不可变 artifact。
7. tenant/space/source policy 的任何一层不匹配都 fail closed。

## 7. 处理器、工具与交互核

### 7.1 统一 Processor Contract

工具、agent 或交互核都通过同一个受限 processor adapter 参与 Intake：

~~~typescript
interface IntakeProcessorRequest<TInput> {
  runId: string;
  stage: string;
  attempt: number;
  leaseToken: string;
  tenantScope: TenantScope;
  grant: ExecutionGrant;
  input: TInput;
  inputHash: string;
  deadline: string;
}

interface IntakeProcessorResult<TOutput> {
  runId: string;
  stage: string;
  attempt: number;
  inputHash: string;
  processorId: string;
  processorVersion: string;
  output: TOutput;
  outputHash: string;
  observations: readonly StructuredObservation[];
}
~~~

服务端在接受结果时重新校验 run/stage/attempt/token/inputHash/result schema 和预算，再做 CAS。
处理器拿不到 repository、Trust Policy 写权限或 promotion capability。

### 7.2 阶段映射

| 阶段 | 推荐执行者 | 输入 | 输出 |
|---|---|---|---|
| coverage planning | 确定性统计 + researcher | Catalog、当前官方覆盖、source utilization | Discovery Brief |
| discovery | spider/search tool/LLM | Discovery Brief、允许的搜索预算 | Source Candidate proposals |
| fetch | hardened fetch broker | probing/active Subscription + fetch decision | quarantined raw Source Revision |
| admission inspect | deterministic sandboxed inspector | quarantined revision、headers、policy | measured metadata + use decision/admitted revision |
| parse | protocol-specific tool/kernel | use-authorized immutable revision | normalized representation + parser metadata |
| extract | researcher/LLM | normalized representation、domains、schema | candidate claims + exact spans |
| canonicalize | memory-keeper | draft candidate + evidence | new canonical draft revision + dedupe/supersedes proposal |
| domain verify | domain-qualified worker/rules | candidate + evidence + plan | bound domain verdict |
| adversarial verify | controller:adversarial | candidate + tainted source + plan | bound adversarial verdict |
| promote | Knowledge Promotion Service | satisfied plan + exact verified hash | official/supersedes/index event without mutation |

### 7.3 禁止的实现捷径

- 不创建 stateful AKI custom kernel；
- 不让 ToolReg tool 拥有数据库连接并自行推进状态；
- 不让 agent failure 仅成为 observation 后继续到下一阶段；
- 不调用安全等级较弱的任意 ext HTTP 作为 canonical fetch；
- 不把网页文本直接拼入拥有工具权限的 agent prompt；
- 不让 recon-doc 或 memory.write 接受 processor 自报 status=official；
- 不把 task completed 当作 Intake stage 已提交；必须由 Intake Service CAS 接受结果。

## 8. 抓取、安全与不受信内容

### 8.1 单一 egress broker

canonical Intake acquisition 只能通过 hardened fetch broker：

- HTTPS only；
- 每次 DNS 解析检查 loopback、link-local、private、metadata 和保留地址；
- DNS pin 或等价的连接目标绑定；
- 每次 redirect 重新校验 network 与 Trust Policy；
- GET/HEAD allowlist，不接受 arbitrary method/body；
- connect、headers、body、total time 分层 timeout；
- compressed 与 decompressed bytes 双重上限；
- content type、状态码、redirect 数、并发、域速率和总预算限制；
- final URI、redirect chain、allowlisted headers、raw bytes 与 hash 全量回传；
- 不保存 cookie、authorization 或敏感响应头；
- ETag/Last-Modified conditional request 只是优化，不替代 content hash。

现有 web.fetchText 的 DNS/IP/redirect/流式上限逻辑可以复用，但其 string-only/HTML-regex 输出
不能作为 Source Revision。需要在同一安全底座上增加内部 artifact envelope。

### 8.2 Prompt injection 隔离

所有来源内容标记为 tainted：

- parser/extractor 运行时不拥有 credentials、任意工具或二次网络访问；
- 来源中的“system prompt”“执行命令”“访问链接”等只能作为数据；
- 抽取输出受固定 JSON schema 约束，并引用可验证 locator；
- 确定性代码从 artifact 计算 quoteHash，拒绝模型伪造 span；
- adversarial verifier 检查指令注入、隐藏文本、证据替换、跨域污染和治理绕过；
- raw/normalized artifact 与 prompt template/version 一并留痕，支持重放。

### 8.3 License、隐私与来源撤销

- license 是 policy decision，不是自由文本备注；
- 未知或冲突 license 不进入自动抽取/晋升；
- 含个人敏感信息、认证内容或访问控制内容按 policy quarantine；
- source takedown/revocation 不删除历史审计，但撤出默认检索并标记 dependent knowledge stale；
- artifact retention 按 policy 执行；删除 artifact 时保留 tombstone、hash、决定和受影响关系。

## 9. 可靠执行、事务与幂等

### 9.1 Transactional outbox

每个关键 transition 使用同一 PostgreSQL client/transaction：

~~~text
lock aggregate row
  → validate tenant + expected rowVersion + status + lease token
  → insert immutable transition/attempt record
  → update aggregate state
  → insert tenant-qualified outbox key
  → commit
~~~

outbox claim 必须原子完成 pending/due → processing，并写 claimToken、lockedUntil、attempt；
complete/fail 只能以相同 token 和 processing 状态 CAS。支持 lease expiry recovery、
availableAt/backoff、lastError 和 dead-letter。

现有 commit 后 observer enqueue 和无 processing lease 的 outbox 不满足本设计，不能作为自动
摄入启用依据。

### 9.2 幂等键

| 操作 | 建议幂等身份 |
|---|---|
| candidate proposal | tenant + canonicalUri + targetScope + discoveryBriefHash |
| subscription create | tenant + canonicalRoot + policyVersion + ruleId |
| scheduled run | tenant + subscriptionId + scheduledWindow |
| fetch result | runId + stage + attempt + inputHash |
| source revision | subscriptionId + acquisitionId；artifact 按 rawHash 去重 |
| extracted candidate | sourceRevisionId + claimHash + extractorVersion |
| verdict | planId + candidateHash + verdictKind + principalId |
| promotion | tenant + candidateId + candidateRevision + candidateHash |

幂等重放返回既有结果；同一 key 不同 payload/hash 是 conflict，不覆盖旧记录。

### 9.3 Trigger 与重启恢复

- scanner 从 PG 查询 nextCrawlAt <= now 且 active 的订阅；
- 使用 SKIP LOCKED/CAS 原子生成 scheduled run 并推进 nextCrawlAt；
- Trigger 可按固定频率或外部事件唤醒 scanner，但其内存 fireCount 不参与正确性；
- 进程重启后 expired lease 被恢复，未完成 outbox 被重新 claim；
- repair job 可根据 transition log 找到“状态已迁移但预期 outbox 缺失”的异常；正常路径仍要求
  同事务，不以 repair 替代原子性。

## 10. 自动发现与覆盖规划

### 10.1 Coverage Planner

Coverage Planner 使用生产 Catalog、official Knowledge、Source Subscription 和评测 manifest，
按以下维度找缺口：

- category / discipline / sub-discipline 覆盖；
- concept / definition / method / constraint / data 等知识 kind；
- sourceType、独立 authority 与 source utilization；
- 单一来源依赖；
- 缺少跨版本、冲突来源、跨域关联或同域 no-answer；
- stale/withdrawn/低证据完整度；
- 语言覆盖和 retrieval failure。

它输出 Discovery Brief，不直接生成 Trust Policy：

~~~typescript
interface DiscoveryBrief {
  id: string;
  domains: readonly DomainId[];
  missingKnowledgeKinds: readonly string[];
  missingSourceTypes: readonly SourceType[];
  authorityDiversityTarget: number;
  querySeeds: readonly string[];
  exclusions: readonly string[];
  budget: DiscoveryBudget;
  corpusFingerprint: string;
}
~~~

### 10.2 LLM 推荐网页的边界

LLM 可以：

- 根据 brief 生成搜索词；
- 比较候选页面的主题相关性；
- 提议 authority/sourceType/domain；
- 解释为什么该来源可能填补缺口；
- 发现同一 source family 的新版本或替代来源。

LLM 不可以：

- 把“官方”“权威”“开放”等文字变成 trust decision；
- 修改 canonical URI 后绕过 origin/path；
- 自行接受未知 license、robots 或登录内容；
- 因已有来源不足而扩大预算；
- 将推荐页面直接送入 official Knowledge。

Discovery 使用的搜索 provider 本身是预先配置的系统 adapter；搜索结果 URL、标题和 snippet
仍按 tainted hint 处理。系统在 Source Candidate 获得 fetch authorization 前不得主动抓取目标
URL 正文；在 use authorization 前不得把正文或 snippet 当作 Knowledge evidence。

## 11. 抽取、核验与晋升

### 11.1 抽取

Extraction processor 只接收 use-authorized immutable Source Revision representation，输出最小
原子声明：

- normalized content；
- kind、domains、valid time；
- one or more Evidence Reference；
- conflict/version hints；
- extractor/version；
- confidence 仅作排序信号，不作晋升条件。

无精确 evidence、内容超出来源支持范围或需要跨来源推断的声明进入 quarantine/needs-evidence。

### 11.2 Canonicalization

memory-keeper 在 draft 状态完成内容归一、别名、去重和 supersedes proposal。只要结果与输入
candidateHash 不同，就写新的 candidate revision/hash；随后才创建 Verification Plan。计划创建
后，任何 canonicalization 变更都必须 invalidated → new revision → reverify，不能在 promotion
事务内顺手修正。

### 11.3 核验

Verification Plan 至少要求：

1. 每个 candidate domain 都有独立 check/quorum；跨域 verifier 也必须明确满足哪些 check；
2. controller:adversarial 独立检查投毒、prompt injection、证据断裂和 policy bypass；
3. producer、各 verifier 与 promoter 的 server principal/execution 满足 separation rule；
4. 每个 verdict 严格绑定 checkId、candidateHash、revision、sourceBindingsDigest 和 evidence；
5. 冲突来源必须显式解析为 authority/time-scoped 结论，或标记 unresolved/abstain；
6. 按 sourceRevisionId 排序的全部 fetch/use bindings、许可、tenant、space、status、valid time
   和 source revocation 均通过。

### 11.4 自动晋升

在来源根已由人类 Trust Policy 批准、Verification Plan 满足且所有确定性门通过时，
memory-keeper 可以自动请求 promotion。Promotion Service 在同一事务：

- 校验 expected draft revision/hash/status；
- 校验 plan satisfied 且 verdict 未失效；
- 重新确认 candidateHash、sourceBindingsDigest 和当前 fetch/use policy 均未变化；
- 写 official revision 与 supersedes；
- 记录 promotion principal、plan、policy 和 evidence；
- 写 index refresh/依赖更新 outbox。

Promotion Service 对 content、domains、evidence、dedupe target 和 supersedes target 是只读的。
唯一性冲突或目标变化使 plan invalidated，而不是在事务内改写后继续晋升。

这仍符合“人类是唯一信任源”：自动化是在人的稳定 policy scope 内执行，不是 LLM 自授信。

## 12. 重爬、版本变化与 stale 传播

1. active Subscription 按 nextCrawlAt 创建新 Intake Run；
2. fetch 使用 conditional headers，但始终记录 acquisition；
3. artifact hash 未变时创建 unchanged revision，复用 artifact，不重新抽取；
4. material change 时生成新 representation，并计算 section/record 级 diff；
5. 通过 Evidence Reference 反向找到依赖 candidate/official revisions；
6. 受影响 official 标记 stale，并立即退出默认 authoritative retrieval；
7. 自动重抽取、核验并生成 superseding official revision；
8. 未受影响 evidence 可继续有效，但必须有确定性证明；
9. source revoked/withdrawn 时所有相关 evidence 失效，dependent entries stale/quarantined；
10. 历史 asOf 查询仍可读取旧 revision 和当时 policy/verdict，不改写过去。

## 13. 初始领域批次与信息源广度

首个 broad acceptance 覆盖五大门类、十个 evaluated domains：

| Category | Evaluated domains |
|---|---|
| formal-science | programming-languages、mathematics |
| natural-science | physics、chemistry |
| applied-science | materials-science、electrical-engineering |
| social-science | economics、psychology |
| humanities | philosophy、literature |

现有 programming-languages/materials-science pilot 继续作为回归 fixture；新增数学及其他领域不再
靠手工扩充静态 PILOT_SOURCES 作为生产证明，而由 Trust Policy + Intake runtime 生成
Source Subscription、Revision 和 Candidate。

每域最低语料约束：

- 至少 6 条 effective official knowledge，十域合计不少于 60 条；
- 至少 6 个获准 sources；
- 至少 3 种 machine-readable sourceType；
- 至少 4 个独立 authorities；
- source registry utilization 100%，不存在永远未被 evidence 使用的获准 source；
- 至少包含 definition/method/constraint/data 等非 fact 类型，非 fact 合计不低于 25%；
- 至少 50% official entries 由两个独立 authority 支持；
- 至少 2 组冲突来源；
- 至少 2 个 source families 各保留 2 个以上 versions；
- 每域包含同域 no-answer、近邻域干扰、许可/版本异常样本。

## 14. 不变验收条件

本轮边界调整不降低既定验收条件。

### 14.1 功能与自动化

| 指标 | 门槛 |
|---|---|
| Category coverage | 5/5 |
| Evaluated domain coverage | 上述 10 个 domain |
| Effective official knowledge | 每域不少于 6 条、总计不少于 60 条；评测时可被默认 authoritative retrieval 命中 |
| End-to-end automation | 人类 Trust Policy 生效后，approved happy path 从发现到重爬为零人工步骤 |
| Unauthorized-origin promotion | 0 |
| Use-policy bypass promotion | 0 |
| Official evidence completeness | 100% official entries 绑定 use-authorized Source Revision + Evidence Reference + sourceBindingsDigest |
| Multi-authority support | 不少于 50% official entries 由至少 2 个独立 authorities 支持 |
| Source utilization | 100% 已纳入验收的 source 至少支持一个被测 entry |
| Crash/retry correctness | 重启、超时、重复结果和 stale worker 不丢失、不重复晋升、不回退状态 |
| Tenant/space isolation | 正向命中与跨 tenant/space 负向测试全部通过 |

### 14.2 检索与评测

- holdout query 不少于总题集 30%，与 source/knowledge/alias 生成流程隔离并冻结 digest；
- 100% official entries 至少被两条 holdout 查询覆盖：一条 direct、一条 compositional；
- evaluator 调用生产 KnowledgeBroker/KnowledgeContext 端口，不手工复制排序；
- 每域至少 8 个 no-answer，其中至少 4 个能正确解析到该域但 corpus 不支持；
- abstention precision/recall 均不低于 0.95，同域 no-answer recall 为 1.0；
- 每域至少 2 组 conflict cases：一组能按 authority/time 解析，一组必须 unresolved/abstain；
- 每域至少 4 个 asOf/change cases，覆盖 old/latest/changed/removed-or-future-leak；
- 五个 category 两两组合的 10 个 pair 全覆盖，每 pair 至少 2 题，至少一题必须引用双方 evidence；
- mutation score 不低于 0.9：删除/破坏被测 entry、evidence、source 或 trust binding 必须使相应用例失败；
- 插入无关高分项、改变输入顺序或替换无意义文本不得改善指标；
- 报告必须列 category/discipline/sub-discipline、entry、source、authority、version、conflict、
  no-answer 和 cross-domain coverage，禁止只报 query count 或聚合 recall。

### 14.3 证据与安全负向验收

以下任一情况必须 fail closed 或 quarantine：

- origin/path 未被当前人类 policy 授权；
- 只有 fetch authorization、没有 use authorization；
- redirect 越界；
- license unknown/conflict/revoked；
- artifact hash、locator 或 quoteHash 不匹配；
- candidate revision/hash 与 verdict 不一致；
- producer/verifier/promoter principal 不满足职责分离；
- stale lease 或重复 processor result；
- source 内容试图注入指令、工具调用或二次网络访问；
- tenant、space、status、valid time 或 grant 不匹配；
- source revision withdrawn/stale 却被默认 Context 当作 authoritative。

### 14.4 生产组合验收

最终必须在真实 PostgreSQL/Redis、多 batch process 环境通过：

~~~text
coverage gap
  → discovery
  → fetch-policy match
  → probing subscription
  → scheduled run
  → safe fetch
  → quarantined raw revision
  → deterministic admission inspection
  → use-policy match
  → admitted immutable revision
  → extraction
  → candidate
  → canonicalization/dedupe proposal
  → verification plan
  → domain/adversarial verdicts
  → atomic promotion
  → Broker/Context retrieval
  → recrawl
  → material change
  → stale withdrawal
  → superseding official revision
~~~

测试必须注入 commit/outbox 间崩溃、双 drainer 并发、lease 过期、重复结果、policy 更新、source
撤销和跨租户读取；只跑 offline fixture 或 direct PgMemoryStore smoke 不算生产验收。

## 15. 现有实现的复用与迁移

### 15.1 可复用

- N16 的 KnowledgeSource/Evidence/Candidate/Context 方向；
- PgMemoryStore 的 tenant-scoped storage 与 revision 基础；
- TaskRepository 的 claim/lease/generation/CAS 设计方法；
- web.fetchText 的 SSRF、redirect、timeout 与流式限制底座；
- ToolReg program/agent、Interpreter/Kernel 的单阶段计算能力；
- spider、researcher、controller:adversarial、memory-keeper 角色；
- Trigger 的 wake-up/action 机制；
- KnowledgeBroker/Context 的 grant-bound official 读取；
- audit/activity/SSE 作为通知和可观测 adapter。

### 15.2 必须替换或收口

- pilot source registry/snapshot：只保留为 fixture，不作为 runtime truth；
- recon-doc：改为提交 Source Candidate/Intake Run，移除 direct official；
- memory.write：禁止外部内容通过非 domain kind 绕开 promotion；
- free-form sourceRefs：迁移为 Evidence Reference；
- commit 后 best-effort observer：关键下一阶段改为 transactional outbox；
- 无 lease 的 outbox claim：改为 processing token + CAS；
- in-memory trigger cursor：改为 Subscription.nextCrawlAt；
- stale verdict 宽松比较：改为严格 revision/hash/plan binding；
- Knowledge Context：贯通同一结构化 Evidence Reference。

### 15.3 历史 ingestion loop

archive/agent-lab 的 source adapter、hash/change detection 思路可作为历史参考，但其 PTL/SQLite/
setInterval/direct-official 模型已归档且不进入当前编译。不得恢复为生产入口。

## 16. 最小实施面

本设计有意避免先创建新的产品层。预计必要改动面如下：

1. 在现有 Knowledge contracts 中加入 Source Candidate、Subscription、Intake Run、Source Revision、
   Evidence Reference、Verification Plan 与窄 repository/service ports；
2. 在 Knowledge 边界内实现 PG repository 和 Knowledge Intake Service；
3. 扩展 hardened fetch 为内部 artifact envelope；
4. 把现有 Task/Tool/Kernel/角色包装为 processor adapters；
5. 修正通用 transactional outbox、claim lease/token 和 CAS；
6. 修正 verdict/promotion 的严格 revision/hash transaction；
7. 让 KnowledgeIngestor 只写 draft，并让 Context/Broker 返回结构化 evidence；
8. 增加 Trust Policy manifest loader、fetch/use 两阶段 matcher 与 admission inspector；
9. 增加 due-source scanner；复用 Trigger 做 wake-up；
10. 增加独立 holdout/e2e/mutation suite。

明确不改：

- 不新增 PthModuleName 或 module-manifest 项；
- 不新增常驻 worker role；
- 不新增独立进程、外部数据库、对象存储或向量库；
- 不新增动态来源审批 API/UI；
- 不改变 PTL/PTH 产品边界；
- 不把 KnowledgeBroker 改成写端口；
- 不扩大 Interpreter/Kernel 对领域状态的所有权。

## 17. 实施顺序与启用门

### Phase 0：关闭现有正确性阻塞

- 关闭复验报告剩余 Gate A/B/C，不以 Intake 设计替代既有修复；
- revision/version 确定性；
- strict candidate revision/hash CAS；
- stable human/service principal 与 execution-bound identity；
- persistent Verification Plan 与 service-level authorization；
- true transactional outbox + multi-process lease；
- raw query 的 tenant/status/space 数据面隔离；
- delegate Domain subset/binding 一致性；
- Domain/evidence 全链一致；
- recon-doc/direct-official 旁路收口。

**门：**Phase 0 未通过前，自动化最多到 private draft/quarantine，禁止自动 official。

### Phase 1：来源与 artifact 基座

- Trust Policy manifest；
- Source Candidate/Subscription/Intake Run/Source Revision；
- hardened artifact fetch；
- quarantined raw revision、admission inspector 与 use-authorized revision；
- PG artifact limit、hash、conditional recrawl；
- due-source scanner。

### Phase 2：processor 自动化

- coverage/discovery/fetch/parse/extract processors；
- result schema、budget、lease、idempotency；
- candidate/evidence handoff；
- failure/backoff/dead-letter。

### Phase 3：验证、晋升与 stale

- pre-verification canonicalization/dedupe/supersedes proposal；
- Verification Plan；
- domain/adversarial verdict；
- atomic promotion；
- dependency graph、stale withdrawal、supersedes；
- policy revocation/takedown。

### Phase 4：十域广度与生产评测

- 5 categories / 10 domains / 60+ effective official；
- source diversity、conflict、cross-version、cross-domain、no-answer；
- independent holdout、mutation、multi-process/crash/tenant tests；
- 自动 happy path 与 unauthorized-origin=0 证明。

## 18. 可观测性与运维

最低指标：

- source candidates by status/policy rule/domain；
- active/paused/revoked subscriptions 与 overdue nextCrawlAt；
- runs by stage/status/attempt/latency/error class；
- fetch bytes/redirects/content types/rate-limit/quarantine；
- revisions new/unchanged/material-change/withdrawn；
- extracted/rejected/promoted/stale candidates；
- evidence completeness、multi-authority ratio、source utilization；
- outbox lag、processing lease expiry、dead-letter；
- Trust Policy version/digest、unknown license、unauthorized-origin blocks；
- category/domain coverage、no-answer、mutation 和 production retrieval metrics。

审计事件至少包含 tenant、stable principal/execution、run/subscription/revision/candidate/plan ID、
before/after rowVersion、policy version/rule、idempotency key、outbox key 和 correlation/trace ID。

运维查询必须能回答：

- 为什么这个 URL 被允许、拒绝或等待人类；
- 哪次抓取生成了哪个 artifact hash；
- 哪条 official 知识依赖哪些来源修订；
- 哪些主体对哪个 candidate hash 作出了 verdict；
- 为什么某条知识被标 stale 或撤出 Context；
- 崩溃后哪一步被恢复、是否发生过重复提交；
- 当前十域验收缺少哪些 source/entry/query 类型。

## 19. 完成定义

本设计只有在以下条件全部满足时才算实施完成：

1. Phase 0–4 的代码、migration、真实 PG/Redis 测试和运行手册全部进入受支持路径；
2. 不存在 processor/recon/memory.write 绕过 draft/verdict/promotion 的 official 写入；
3. Trust Policy 只能由人类治理路径发布，LLM/runtime 为只读；
4. approved-source happy path 零人工完成且可在重启后继续；
5. 未获 fetch/use authorization 的来源、跨租户、stale evidence 和旧 verdict 的负向用例均
   fail closed；
6. 所有 official 条目可重放到不可变 Source Revision 与精确 Evidence Reference；
7. 5/5 categories、10 domains、60+ effective official 以及第 14 节全部评测门槛通过；
8. 生产 Broker/Context 端口和真实多进程组合验收通过；
9. 文档、CONTEXT 术语、framework contracts、API/CLI（如实现）与运行状态一致；
10. 不以 pilot fixture 的自洽满分、query 数量或 direct store smoke 替代上述证据。

在实施前，本文件是设计约束，不表示当前代码已经具备自主摄入或自动晋升能力。
