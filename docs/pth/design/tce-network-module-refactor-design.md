# TCE 网络模块整合重构设计（Tool → Code → Execute）

> 状态：**草案待评审**
> 日期：2026-08-25
> 关联：ADR-0004（TCE = Tool→Code→Execute，PTC 能力接口第一性）、`docs/pth/plan/tce-code-model-remediation-plan.md`（W0–W5 已完成）
> 目标：把当前零散的网络访问/搜索功能统一收编为 PTC 能力族，消除平行工具面，并让 Execute 层按能力宿主统一路由。

## 1. 背景与动机

当前网络相关能力散落在多个面：

| 面 | 模块/工具 | 形态 | 问题 |
|---|---|---|---|
| 引擎能力 | `web.fetchText` | PTC 能力 + kernel-ts 实现 | 只有单 URL 抓取，无搜索/结构化阅读/平台搜索 |
| toolstore 扩展 | `web-fetch` → `web.get` | 独立 tool-call | 与 `web.fetchText` 功能重叠，未进 PTC 契约 |
| toolstore 扩展 | `agent-reach` → `reach.*` | 独立 tool-call（Exa/jina/gh/bili/v2ex） | 不经过 Code 层静态审核，能力面未契约化 |
| tool container | `network` 域 `yt-dlp` | external tool | 仅工具容器，无 PTC 契约投影 |
| tool container | `secrets` 域 `agent-reach` | hostOnly CLI | 供宿主/CLI 使用，与扩展工具面关系不清晰 |
| 知识摄入 | `fetch-broker` | 独立受信抓取 broker | 复用 `web-transport`，但未纳入统一能力模型 |
| 来源发现 | `source-discovery.ts` | 骨架 | 设计中的 search adapter 未接入真实搜索 provider |

TCE W0–W5 已经统一了 dev/write/debug 等工具面，但网络面仍未完成同一收敛。这导致：

1. **双源/多源契约**：`web.fetchText`、`web.get`、`reach.*`、yt-dlp 各自维护参数和语义，缺乏单一真相源；
2. **权限不统一**：`reach.*` 通过 `ext.use(agent-reach)` 直接执行，不走「注入 + 静态审核」单机制；
3. **执行路由不统一**：HTTP 类、CLI 类、工具容器类网络能力没有统一宿主声明；
4. **观测缺失**：网络能力调用没有统一埋点/审计入口。

## 2. 目标

- 以 **PTC 能力契约** 作为网络访问/搜索的单一真相源；
- 所有网络 tool-call 面（`web.get`、`reach.*` 等）降级为能力契约的**投影/适配**；
- 新增统一 `net.*` 能力族，覆盖：抓取、阅读、网页搜索、GitHub 搜索、B 站搜索、V2EX 热门、下载；
- Execute 层明确每个网络能力的宿主：kernel-ts / external-tool / toolstore；
- Knowledge Intake 的 `fetch-broker` 与通用网络能力共享同一安全底座，保留 Trust Policy 包裹层；
- 不破坏既有 `web.fetchText` 行为与旧工具名兼容。

## 3. 非目标

- 不重写 `web-transport.ts` 的安全语义（SSRF/DNS pin/重定向/流式上限继续作为底座）；
- 不实现新的搜索算法/爬虫；
- 不把登录态平台（twitter/reddit/xhs/facebook/instagram/linkedin）纳入 v1；
- 不改变 tool-container 内部实现；
- 不做 N26 完整外环，只把现有骨架接入可扩展的 search adapter 缝。

## 4. 现状盘点

### 4.1 PTC 契约现状

- `PTC_CAPABILITIES` 已有 `web.fetchText`（family=`web`，host 未显式声明，实为 kernel-ts）。
- `PtcCapabilityHost` 目前只有：`kernel-ts`、`loop`、`sandbox-debug`、`toolstore`。
- 没有 `external-tool` 宿主声明，因此工具容器类能力无法在契约层表达。

### 4.2 toolstore 扩展现状

- `web-fetch`：`web.get(url, maxBytes?)`，走 `ctx.http.get`。
- `agent-reach`：`reach.webSearch` / `reach.webRead` / `reach.ghSearch` / `reach.biliSearch` / `reach.v2exHot` / `reach.doctor` / `reach.checkUpdate`，走 `ctx.exec` / `ctx.http`。

### 4.3 工具容器现状

- `network` 域：`yt-dlp`，`network=default`（可出网），engineVisible=true，默认关闭。
- `secrets` 域：`agent-reach`、`chatgpt-share`，`network=default`，engineVisible=false，hostOnly=true。

### 4.4 知识摄入现状

- `src/pth/execution/knowledge-intake/fetch-broker.ts`：Trust Policy 约束的抓取 broker。
- `source-discovery.ts` / `auto-expansion.ts`：来源发现/自动扩源骨架，尚无真实 search adapter。
- `web-transport.ts`：被 `web.fetchText` 与 fetch-broker 共用。

## 5. 目标能力模型

### 5.1 新增 `net` family

在 `PTC_CAPABILITIES` 中新增 `net` 能力族，同时保留 `web.fetchText` 作为兼容别名：

| 能力 | 签名 | 宿主 | 后端 | 说明 |
|---|---|---|---|---|
| `net.fetch` | `(url, opts?)` | `kernel-ts` | `web-transport` | 受限只读 HTTP(S) GET，HTML 剥标签；取代 `web.fetchText` / `web.get` |
| `net.read` | `(url)` | `kernel-ts` | `web-transport` → `https://r.jina.ai/<url>` | 通用网页阅读 → Markdown；保留 jina reader 语义 |
| `net.search` | `(query, n?)` | `external-tool` / `kernel-ts` | Exa（mcporter）→ jina 搜索兜底 | 网页搜索；n 默认 5，范围 1–20 |
| `net.githubSearch` | `(query, sort?, limit?)` | `external-tool` | `gh search repos` | GitHub 仓库搜索；结构化 JSON |
| `net.biliSearch` | `(query, n?)` | `external-tool` | `bili search` | B 站搜索 |
| `net.v2exHot` | `(n?)` | `kernel-ts` | V2EX 官方 API | 热门话题 |
| `net.download` | `(url, opts?)` | `external-tool` | `yt-dlp`（network 域） | 视频/音频下载；默认按角色能力关闭 |
| `net.doctor` | `()` | `external-tool` / toolstore | `agent-reach doctor` | 后端体检（运维面，可暂不进 agent 能力） |
| `net.checkUpdate` | `()` | `external-tool` / toolstore | `agent-reach check-update` | 版本检查（运维面，可暂不进 agent 能力） |

> `net.doctor` / `net.checkUpdate` 偏向运维，是否进入 agent 能力面由后续评审决定；本设计先保留为扩展工具或 CLI 面。

### 5.2 `PtcCapabilityHost` 扩展

```ts
export type PtcCapabilityHost =
  | 'kernel-ts'       // ts 核内 vm 对象（web-transport 等）
  | 'loop'            // agent loop / session 宿主
  | 'sandbox-debug'   // sandbox debug API
  | 'toolstore'       // toolstore 扩展代码
  | 'external-tool';  // 新增：tool-container / 外部 CLI
```

`external-tool` 表示该能力最终由 tool container 或宿主 CLI 执行；PTC 静态审核仍只审核能力调用本身，不透入 argv/命令内容。

### 5.3 兼容投影

- `web.fetchText`：保留为 `net.fetch` 的别名（`asAction` 指向 `net.fetch`，或继续直接实现）。
- `web.get`：tool-call schema 保留，但实现投影为 `net.fetch`。
- `reach.webSearch` → `net.search`
- `reach.webRead` → `net.read`
- `reach.ghSearch` → `net.githubSearch`
- `reach.biliSearch` → `net.biliSearch`
- `reach.v2exHot` → `net.v2exHot`
- `yt-dlp` → `net.download`

## 6. 统一能力实现

### 6.1 `createNetworkCapability`

新增 `packages/pth-kernel-execution/src/execution/ptc/capabilities/network.ts`：

```ts
export interface NetworkCapabilityDeps {
  // HTTP 类统一走安全底座
  fetchText?: (url: string, opts?: { maxBytes?: number; timeoutMs?: number }) => Promise<string>;
  httpGet?: (url: string, opts?: { timeoutMs?: number; maxBytes?: number }) => Promise<{ ok: boolean; text?: string; status?: number; error?: string }>;
  // 外部 CLI / tool-container 通道
  exec?: (cmd: string, args: string[], opts?: { timeoutMs?: number; maxOutputBytes?: number }) => Promise<{ ok: boolean; stdout?: string; stderr?: string; error?: string }>;
  // yt-dlp 等 external tool 路由（按工具容器域）
  download?: (url: string, opts?: { timeoutMs?: number }) => Promise<unknown>;
}

export interface NetworkCapability {
  fetch(input: { url: string; maxBytes?: number; timeoutMs?: number }): Promise<AgentToolResult>;
  read(input: { url: string }): Promise<AgentToolResult>;
  search(input: { query: string; n?: number }): Promise<AgentToolResult>;
  githubSearch(input: { query: string; sort?: string; limit?: number }): Promise<AgentToolResult>;
  biliSearch(input: { query: string; n?: number }): Promise<AgentToolResult>;
  v2exHot(input?: { n?: number }): Promise<AgentToolResult>;
  download(input: { url: string; opts?: Record<string, unknown> }): Promise<AgentToolResult>;
}
```

实现要点：

- `fetch`：直接复用 `createWebCapability().fetchText` 或 `web-transport`，行为与现状一致；
- `read`：调用 `https://r.jina.ai/<url>`，走同一安全 HTTP 通道；
- `search`：优先 `exec("mcporter", [...])` 调 Exa；失败后走 `https://s.jina.ai/<query>`；
- `githubSearch` / `biliSearch`：走 `exec` 通道（gh / bili CLI）；
- `v2exHot`：走安全 HTTP 通道；
- `download`：走 tool-container `network` 域路由（yt-dlp），默认不注入。

### 6.2 注入点

- 在 `buildCapabilities` 中，`web` 对象改为 `net` 的别名或同时注入 `net`；
- 在 `task-capability-inject.ts` 中，按角色 `capabilities` 注入 `net` 对象的具体方法：
  - `allowed(caps, 'net.search')` 才注入 `search`；
  - `allowed(caps, 'net.download')` 才注入 `download`；
  - 缺省不注入 = 角色无网络搜索能力。

### 6.3 静态审核

- `PTC_CAPABILITIES` 注册 `net.*` 后，`ptc/surface.ts` 自动识别 `net.search()` 等调用；
- 角色 `capabilities` 白名单控制可调用子集；
- 参数级约束（如 `net.download` 默认关闭、`net.search` n 范围）在能力实现层和契约 validate 层双重校验。

## 7. Execute 层路由

| 能力 | Execute 目标 | 说明 |
|---|---|---|
| `net.fetch` / `net.read` / `net.v2exHot` | kernel-ts（`web-transport`） | 进程内安全 HTTP |
| `net.search` | external-tool（`agent-reach` / mcporter / jina） | 优先 CLI/工具容器，失败回退 HTTP |
| `net.githubSearch` | external-tool（gh CLI） | 需要 gh 登录态，hostOnly 或工具容器 |
| `net.biliSearch` | external-tool（bili CLI） | 需要 bili CLI |
| `net.download` | external-tool（`network` 域 yt-dlp） | 按 tool-manifest 路由 |

`tool-registry.ts` / `tool-translator.ts` 增加 `net.*` 到工具容器/CLI 的映射；`scripts/check/check-tce-coverage.ts` 扩展为所有 `net.*` 必须存在契约声明。

## 8. Knowledge Intake 整合

- `fetch-broker` 继续保留 Trust Policy / admission / raw artifact 语义，但底层传输统一调用 `web-transport`（现状已如此）；
- 新增可选 `lookup` / `request` 注入缝已存在；未来可让 `net.fetch` 与 fetch-broker 共用同一安全传输模块；
- `source-discovery.ts` 增加 `SearchAdapter` 端口：

```ts
export interface SearchAdapter {
  search(query: string, opts?: { limit?: number }): Promise<Array<{ title: string; url: string; snippet?: string }>>;
}
```

- 默认实现可先接 `net.search`；在未配置真实 provider 时返回空并保持 `EVALUATION-INCOMPLETE`，不伪造来源。

## 9. Wave 实施计划

### Wave A — 契约与类型（Contract）

- `PtcCapabilityHost` 增加 `external-tool`；
- `PTC_CAPABILITIES` 新增 `net.*` 条目（含 `toolSchema`、`asAction`、validate）；
- `web.fetchText` 保留兼容，标记为 `net.fetch` 别名；
- 新增 `ptc-network-contract.test.ts`：契约存在性、参数校验、asAction 投影。

### Wave B — 统一能力实现（Implementation）

- 新增 `network.ts` capability factory；
- `buildCapabilities` / `task-capability-inject` 接入 `net`；
- 新增 `network-capability.test.ts`：fake exec/http 后端覆盖全部方法；
- 行为与现有 `web.fetchText` / `reach.*` 保持一致（输出/错误文案尽量不变）。

### Wave C — 工具面投影（Adapter）

- `web-fetch` 扩展改为 `web.get` → `net.fetch` 的薄投影；
- `agent-reach` 扩展改为 `reach.*` → `net.*` 的薄投影；
- AGENT_TOOLS 中旧工具保留兼容 shim，但实现指向 `net` 能力对象；
- 新增 tool-call 投影测试：旧工具名调用后实际走 `net.*` 能力。

### Wave D — Execute 路由与覆盖检查

- `tool-registry` / `tool-translator` 增加 `net.download` → `network` 域、`net.githubSearch`/`net.biliSearch` → 对应 CLI；
- `check-tce-coverage.ts` 纳入 `net.*`；
- 工具容器 manifest 如需新增 bili/gh 等工具再评估（当前可先走宿主 CLI / agent-reach）。

### Wave E — Knowledge Intake / 来源发现

- `source-discovery.ts` 增加 `SearchAdapter` 端口；
- 默认 adapter 接 `net.search`（或保留未配置空实现）；
- 补充来源发现骨架测试。

### Wave F — 文档与收尾

- 更新 `docs/pth/concepts.md` / `docs/pth/architecture.md` / `docs/pth/module-ownership.md`；
- 更新 `docs/fracta-engine-execution-topology.md` 网络工具矩阵；
- 更新 release notes / plan inventory；
- 全量 lint + test + build 绿。

## 10. 验收标准

1. `PTC_CAPABILITIES` 中所有 `net.*` 均有契约、`toolSchema`、`asAction`；
2. `web.get`、`reach.*` 旧工具名仍可调用，但内部路由到 `net.*`；
3. `web.fetchText` 行为不变；
4. 角色未声明 `net.*` 时，ts 程序调用 `net.search` 被静态审核拒绝；
5. `net.download` 默认不注入，只有显式 capability 才可用；
6. Knowledge Intake 仍使用 hardened fetch broker，未因重构放宽 SSRF/Trust Policy；
7. `npm run lint`、`npm test`、`npm run build` 全绿；
8. TCE coverage 检查包含 `net.*`，无未契约网络工具。

## 11. 风险与对策

| 风险 | 对策 |
|---|---|
| 旧工具名/行为回归 | Wave C 保留兼容 shim + 全量回归 + golden 测试 |
| `net.search` 后端（Exa/jina/gh/bili）依赖外部登录态/网络 | 失败时返回结构化错误并提示 `net.doctor`；不阻断非网络任务 |
| `external-tool` 宿主扩展影响静态审核 | 只新增宿主声明，不改变“不透入字符串参数”边界 |
| 知识摄入被错误复用为普通网络能力 | fetch-broker 保持独立 Trust Policy 包裹层，只共享传输底座 |
| 范围膨胀 | 非目标明确排除登录态平台、爬虫算法、完整 N26 外环 |

## 12. 待确认决策点

1. 能力命名用 `net.*` 还是 `web.*` 扩展？（本设计倾向 `net.*` + `web.fetchText` 兼容别名）
2. `net.doctor` / `net.checkUpdate` 是否进入 agent 能力面，还是保留为 CLI/运维工具？
3. `net.search` 的默认后端顺序：Exa → jina，是否保持不变？
4. `net.download`（yt-dlp）是否需要进入 engine 能力面，还是继续仅 pth CLI/工具容器？
