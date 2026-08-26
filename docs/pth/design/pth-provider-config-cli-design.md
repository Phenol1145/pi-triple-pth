# pth config provider 命令设计 —— PTH Provider 配置 CLI

> 状态：设计定稿待评审（v3 —— 吸收施工反馈：跨仓 contract、路径、并发、权限、网络边界；PTH 侧已开始实施）
> 范围：`pth config provider` 子命令族 + `@away_from/pth-config` provider 配置后端 + dsh ops 薄封装
> 关联代码：`src/cli/pth-cli.ts`、`packages/pth-config/src/*`、`extensions/pit-providers/*`（已从 pi-platform 迁入）、`dsh-pth-interface/preset/pth-ops/*`
> 目标版本：pth CLI v1.8+ / dsh-pth-interface v0.7+

## 1. 背景与目标

当前 LLM provider 注册配置存在 `~/.pi-triple/providers.json`，由本仓 `extensions/pit-providers` 消费（已从 pi-platform 迁入，pi-platform 停止维护）。该文件：

- 已有加载/校验逻辑（`extensions/pit-providers/registry.ts`），现已迁入本仓；
- 没有独立 CLI 管理入口；
- `pth config` 只能读 PTH 环境配置，不能写 `providers.json`；
- dsh ops preset 没有向模型暴露 provider 配置能力。

本设计在 **`pth config` 下新增 `provider` 子命令族**，作为 providers.json 的本地管理入口，并让 dsh ops preset 通过调用该 CLI 获得 provider 配置能力。

### 为什么编入 `pth config` 而不是新增顶层 `pth provider`

1. **统一配置入口**：所有“配置”都在 `pth config` 下；
2. **权限边界更清晰**：可以在 `pth config` 层统一实施只读/写入守卫、审计、备份策略；
3. **避免顶层命令膨胀**：后续 env/trust/services 等配置都挂到 `pth config` 下；
4. **兼容现有 `pth config`**：保留 `pth config` 和 `pth config export`。

## 2. 非目标

- 不管理 `auth.json` 中的 API Key 池（那是 `/login` / `/keys` 的职责）。
- 不实现 pi 扩展热加载；修改后是否生效由 pi 重启/刷新模型列表决定。
- 不实现远程/多租户 provider 管理。
- 不把 `pth config provider` 做成 PTH API 服务端接口（v1 仅本地 CLI）。
- **不实现 `provider test`**（避免模型可控的内网 HTTP/SSRF 通道；后续如需走受控 Network Execute admin profile）。
- **不向普通 PTH 任务/worker 能力面暴露 provider 配置**；只作为本地 CLI 和 dsh ops admin 能力。

## 3. 跨仓 contract（先于实现冻结）

### 3.1 事实源

`providers.json` 的格式 contract 不能靠“人工镜像”维持。V1 采用以下策略：

1. 本设计文档 + `docs/pth/contract/provider-config-contract.md` 是 **canonical contract**；
2. PTH writer（`@away_from/pth-config`）与本仓 reader（`extensions/pit-providers`）都遵守同一 contract；
3. 建立 **golden fixtures**：
   - `test/fixtures/providers/golden/*.json`
4. 本仓 CI 运行 writer/reader conformance 测试，dsh 工具测试验证薄封装：
   - writer：写入 golden fixture → 校验结果；
   - reader：用同一组 fixture 加载 → 必须全部通过；
5. 后续若条件成熟，再把 validator 抽成共享包；V1 不阻塞在代码共享上。

### 3.2 版本语义

| 概念 | 值/位置 |
|---|---|
| 文件格式版本 | 顶层 `version: 1`，固定不变 |
| schema revision | 由 contract 文档版本和 package version 记录，不写进 providers.json |
| validator 行为 | 由 contract 文档 + golden fixtures 锁定，不用 `version` 表达 |

### 3.3 未知字段策略

**保留**：backend 加载时保留 provider/model 的未知字段，保存时原样写回；validator 不拒绝未知字段。
这样避免 writer/reader 丢弃未来可能新增的字段。

### 3.4 唯一性规则

全局要求：

- `provider.id` 在整个文件唯一；
- `provider.alias[]` 中的每个 alias 在整个文件唯一；
- alias 不得与任何 provider id 相同；
- 违反唯一性时 validator 拒绝整个文件，不按数组顺序“先到先得”。

### 3.5 路径解析（与 consumer 一致）

**不引入 `PTH_PROVIDERS_FILE` 公共覆盖**。CLI 路径解析与 `pit-providers` 完全一致：

```text
PI_TRIPLE_HOME/providers.json    # 若设置了 PI_TRIPLE_HOME
~/.pi-triple/providers.json      # 默认
```

测试通过以下方式隔离，不污染公共环境契约：

- 单元测试直接调用 backend 函数并传入显式 `file` 参数；
- CLI 集成测试设置 `PI_TRIPLE_HOME` 到临时目录。

## 4. 配置路径与文件格式

### 4.1 文件格式

```json
{
  "version": 1,
  "providers": [
    {
      "id": "kimi",
      "name": "Kimi",
      "alias": ["kimi"],
      "baseUrl": "https://api.moonshot.cn/v1",
      "api": "openai-completions",
      "apiKeyEnv": "KIMI_API_KEY",
      "multiKey": false,
      "refreshModels": false,
      "models": []
    }
  ]
}
```

`ProviderDef` / `ModelDef` 字段与 `pit-providers` spec v3 对齐；未知字段保留。

## 5. 数据模型（钉死）

```ts
interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface ModelDef {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: string[];
  cost?: ModelCost;
  contextWindow?: number;
  maxTokens?: number;
  compat?: Record<string, unknown>;
  thinkingLevelMap?: Partial<Record<"off"|"minimal"|"low"|"medium"|"high"|"xhigh"|"max", string | null>>;
  [key: string]: unknown;  // 未知字段保留
}

interface ProviderDef {
  id: string;                    // ^[a-z0-9-]+$
  name: string;
  alias?: string[];
  baseUrl: string;               // http(s) URL
  api: string;                   // 默认 "openai-completions"
  apiKeyEnv?: string;
  multiKey: boolean;
  refreshModels: boolean;
  compat?: Record<string, unknown>;
  models: ModelDef[];
  inferRules?: Array<{ pattern: string; contextWindow?: number; maxTokens?: number; reasoning?: boolean; cost?: Partial<ModelCost>; input?: string[]; compat?: Record<string, unknown> }>;
  inferDefaults?: Partial<Omit<ModelDef, "id" | "name">>;
  [key: string]: unknown;  // 未知字段保留
}
```

校验规则：

| 字段 | 规则 |
|---|---|
| `provider.id` | 必填，`^[a-z0-9-]+$`，全局唯一 |
| `provider.name` | 必填字符串 |
| `provider.baseUrl` | 必填，必须以 `http://` 或 `https://` 开头 |
| `provider.api` | 必填字符串，默认 `openai-completions` |
| `provider.multiKey` | 必填 boolean |
| `provider.refreshModels` | 必填 boolean |
| `provider.models` | 必填数组（可为空数组） |
| `model.id` | 必填字符串；无格式限制 |
| `alias` | 可选数组；全局唯一（见 §3.4） |
| 顶层 `version` | 必须为 `1` |
| 未知字段 | 不拒绝，保存时保留 |

## 6. 命令面（钉死）

### 6.1 总览

```text
pth config provider list [--json]
pth config provider get <id> [--json]
pth config provider add --data <json> | --file <path>
pth config provider update <id> --data <json> | --file <path>
pth config provider remove <id> [--yes]
pth config provider validate [--file <path>]
pth config provider backup [--output <path>]
pth config provider restore <file> [--yes]
```

**V1 不实现 `provider test`。**

保留旧命令：

```text
pth config                 # 环境配置列表（不变）
pth config export          # PTL 信息迁移导出（不变）
```

未知 `pth config` 子命令必须 **fail closed**，不能静默回落为 `pth config` 列表。

### 6.2 `pth config provider list`

列出所有 provider。

输出（人类可读）：

```text
ID           NAME            API                 MODELS  MULTIKEY  REFRESH
kimi         Kimi            openai-completions  4       no        no
ustc-llm     USTC LLM        openai-completions  23      yes       yes
```

`--json`：

```json
{ "ok": true, "providers": [ { ...ProviderDef } ], "count": 2 }
```

### 6.3 `pth config provider get <id>`

按 `id` 或 alias 查找单个 provider。

成功输出完整 ProviderDef（JSON）：

```json
{ "ok": true, "provider": { ...ProviderDef } }
```

不存在时：

```json
{ "ok": false, "error": { "code": "PROVIDER_NOT_FOUND", "message": "provider `xxx` 不存在" } }
```

### 6.4 `pth config provider add`

新增 provider。两种入参：

- `--data '<ProviderDef JSON>'`：完整 ProviderDef 字符串（机器接口，dsh ops 用）；
- `--file <path>`：从 JSON 文件读取完整 ProviderDef。

规则：

- 若文件不存在，自动创建 `{ version: 1, providers: [] }`；
- `id` 或 alias 重复时报 `PROVIDER_EXISTS`；
- 写入前做全量校验，校验失败不落盘；
- 写前自动备份。

示例：

```bash
pth config provider add --data '{
  "id": "ollama-local",
  "name": "Ollama Local",
  "baseUrl": "http://127.0.0.1:11434/v1",
  "api": "openai-completions",
  "multiKey": false,
  "refreshModels": false,
  "models": [
    { "id": "qwen2.5-coder:14b", "name": "Qwen2.5 Coder 14B", "reasoning": false, "input": ["text"], "contextWindow": 32768, "maxTokens": 8192 }
  ]
}'
```

### 6.5 `pth config provider update <id>`

更新 provider。入参为 `--data '<部分 ProviderDef>'` 或 `--file <path>`。

合并语义：

- 顶层标量字段（`name` / `baseUrl` / `api` / `apiKeyEnv` / `multiKey` / `refreshModels` / `compat`）如果出现在入参中，则替换；
- `alias`：如果出现，整体替换；
- `models`：如果出现，整体替换（**不做深度合并**）；
- `inferRules` / `inferDefaults`：如果出现，整体替换；
- `id` 不可更新（报 `PROVIDER_ID_IMMUTABLE`）；
- 入参中未出现的字段保持原值；
- 未知字段同样保留。

示例：

```bash
pth config provider update ollama-local --data '{
  "baseUrl": "http://127.0.0.1:1234/v1",
  "models": [ { "id": "local-model", "name": "Local Model" } ]
}'
```

### 6.6 `pth config provider remove <id>`

删除 provider。

- 必须 `--yes` 确认；非交互/无 `--yes` 直接拒绝（`CONFIRM_REQUIRED`）；
- 删除前自动备份；
- 删除后重新校验整个文件。

### 6.7 `pth config provider validate [--file <path>]`

校验 providers.json（默认路径，或 `--file` 指定）。

输出人类可读问题列表；`--json` 输出：

```json
{ "ok": true, "valid": true, "errors": [], "warnings": [] }
```

校验失败时退出码 1，但不修改文件。

### 6.8 `pth config provider backup [--output <path>]`

把当前 providers.json 复制为备份文件。

- 默认输出：`<providers.json>.bak-<YYYYMMDD-HHmmss>-<random>`；
- 使用 exclusive create，避免备份名冲突；
- 成功输出备份路径；
- 在 `PTH_CONFIG_READONLY=1` 下允许（见 §8）。

### 6.9 `pth config provider restore <file> [--yes]`

从备份文件恢复 providers.json。

- 必须 `--yes` 确认；非交互/无 `--yes` 直接拒绝（`CONFIRM_REQUIRED`）；
- 恢复前先校验备份文件，非法则拒绝；
- 覆盖前自动备份当前文件；
- 在 `PTH_CONFIG_READONLY=1` 下拒绝。

## 7. 输出与退出码

所有命令遵循统一结构：

- 人类模式：成功打印可读文本；失败打印 `error: <message>` 到 stderr；
- `--json` 模式：stdout 始终输出结构化 JSON；
- **成功退出 0；业务失败退出 1；CLI 用法错误退出 2**。

| 场景 | 退出码 |
|---|---|
| 成功 | 0 |
| 业务失败（provider 不存在、校验失败、写守卫拒绝等） | 1 |
| CLI 用法错误（未知子命令、缺参） | 2 |

JSON 模式下业务失败仍输出 `{ "ok": false, ... }` 到 stdout，**同时退出码为 1**。调用方（dsh wrapper、CI）必须同时检查 JSON 与 exit code，不能只依赖其中一个。

## 8. 写操作安全模型

### 8.1 原子写与并发

所有写命令（add/update/remove/restore）遵循：

1. 获取同目录 lock file（`<providers.json>.lock`，`wx` exclusive create，超时/陈旧处理）；
2. 读取当前文件，记录内容 hash 作为 revision；
3. 在内存中修改；
4. 全量校验；
5. 若 `PTH_PROVIDER_BACKUP` 未显式设为 `0`，先创建备份（exclusive create）；
6. 写临时文件 `<dir>/.providers.json.<pid>.<random>.tmp`；
7. `fsync` 临时文件；
8. `rename` 覆盖原文件；
9. `fsync` 父目录；
10. 释放 lock；
11. 任一步失败：删除临时文件、释放 lock，原文件保持不变。

### 8.2 并发 lost update 防护

- 保存前执行 compare-and-swap：当前文件 hash 必须等于读取时的 hash；
- 若不一致，报 `CONCURRENT_MODIFICATION`，不覆盖；
- 备份名包含时间戳 + 随机后缀，并使用 exclusive create。

### 8.3 文件安全

- 对 symlink 和非普通文件 **fail closed**（拒绝读写）；
- 新文件权限沿用现有 providers.json 权限；不存在时按 `0o600` 创建；
- 备份文件权限同样 `0o600`；
- 不跟随符号链接，路径先 `realpath`/`lstat` 校验。

### 8.4 写守卫语义

| 环境变量 | 行为 |
|---|---|
| `PTH_CONFIG_READONLY=1` | 禁止修改 authoritative config：add/update/remove/restore 全部拒绝；list/get/validate/backup 允许 |
| `PTH_PROVIDER_WRITE=0` | 只禁止 provider 写操作（add/update/remove/restore） |
| `PTH_PROVIDER_WRITE=1` | dsh ops 模型写操作的显式 opt-in（见 §9） |

`backup` 在 `PTH_CONFIG_READONLY=1` 下允许，因为它只创建时间戳副本，不修改 authoritative config。
`restore` 会覆盖 authoritative config，因此被 read-only 拒绝。

## 9. dsh ops 集成设计

### 9.1 目标

在 `dsh-pth-interface/preset/pth-ops/pth-ops.mjs` 增加模型面工具 `pth_config_provider`，内部通过 `execFile` 调用 `pth config provider ...`，**不复制 provider 逻辑**。

### 9.2 配置项

在 `agent.cordis.yml` 的 `pth-ops.config` 增加：

```yaml
config:
  pthBin: pth                  # 可执行名；也可写 node /path/to/dist/cli/pth-cli.js（路径不含空格）
  providersDir: ~/.pi-triple   # providers.json 所在目录，不是文件路径
```

`pthBin` 缺省 `pth`；如果 pth CLI 不在 PATH，可配置为 `node <repoDir>/dist/cli/pth-cli.js`。
兼容旧配置项 `providersFile`（文件路径）：wrapper 会自动取其目录作为 `providersDir`，但不承诺自定义文件名。

### 9.3 工具签名

```text
pth_config_provider(action, id?, json?, file?, yes?)
```

- `action`: `list | get | validate`（V1 只读）
- 后续阶段在显式管理员 opt-in 后开放：`add | update | remove | backup | restore`
- 成功时 wrapper 解析 CLI 的 JSON stdout 为结构化结果（如 `providers`/`provider`/`errors`）；解析失败才回退 `output` 字符串；
- 失败返回 `{ ok:false, error }`；
- wrapper 必须检查 exit code。

### 9.4 权限默认值

- **本地 CLI：默认可写**，受文件权限和 read-only 环境变量控制；
- **dsh ops：默认只开放 list/get/validate**；
- 模型 add/update/remove/restore 要求：
  - `PTH_PROVIDER_WRITE=1` 显式开启；
  - remove/restore 还需管理员批准态（不能仅由模型传 `yes=true` 自行越过）；
- `test` 不进入 dsh V1。

### 9.5 安全边界

- 模型不能指定任意文件路径；`file` 参数只允许 `providersDir/providers.json` 或其备份路径；
- `execFile` 固定 binary、固定 argv 前缀、固定 cwd；
- `file`/`output` 先 canonicalize/realpath，再检查是否在允许路径内，防 symlink 逃逸；
- 不向模型暴露 API key（providers.json 本身不含明文 key）；
- dsh ops 继承宿主的 `PTH_CONFIG_READONLY` / `PTH_PROVIDER_WRITE` 守卫。

## 10. 决策记录

| 编号 | 决策 |
|---|---|
| D1 | provider 配置后端放在 `@away_from/pth-config`；reader 迁入 `extensions/pit-providers`；contract 以文档 + golden fixtures 锁定，不靠人工镜像 |
| D2 | `pth config provider` 是本地文件 CLI，不依赖 PTH server |
| D3 | `--data` 是机器接口的首选；`--file` 为人类/脚本便利；`--json` 仅表示输出 JSON |
| D4 | `update` 的 `models` 整体替换，不做深度合并 |
| D5 | `id` 不可更新 |
| D6 | 写操作自动备份 + 原子写 + 锁/CAS + 校验失败不落盘 |
| D7 | JSON 模式业务失败输出 `{ok:false}` 且退出码 1；用法错误退出码 2 |
| D8 | dsh ops 只做薄封装，调用 `pth config provider`，不复制逻辑 |
| D9 | V1 不实现 `provider test`，避免模型可控 SSRF/内网探测 |
| D10 | provider 配置编入 `pth config` 子命令；旧 `pth config` 行为不变 |
| D11 | `pth config` 层统一写守卫：`PTH_CONFIG_READONLY` 全禁 authoritative 写，`PTH_PROVIDER_WRITE` 控制 provider 写 |
| D12 | 路径解析与 `pit-providers` 完全一致，不引入 `PTH_PROVIDERS_FILE` 公共覆盖 |
| D13 | 未知字段保留，不拒绝 |
| D14 | `id + alias` 全局唯一，冲突拒绝整个文件 |
| D15 | dsh 默认只读；写操作需显式 opt-in 和批准态 |

## 11. 验收标准

1. `pth config provider list` / `get` / `add` / `update` / `remove` / `validate` / `backup` / `restore` 全部可用；
2. 对 `~/.pi-triple/providers.json` 的修改可被 `pit-providers` 正常读取（通过 golden fixtures conformance 验证）；
3. 非法 provider 写入被拒绝，原文件不变；
4. 并发写入不会 lost update；
5. symlink/非普通文件被拒绝；
6. `PTH_CONFIG_READONLY=1` 时 add/update/remove/restore 拒绝，list/get/validate/backup 允许；
7. `PTH_PROVIDER_WRITE=0` 时 provider 写操作拒绝；
8. 未知 `pth config` 子命令 fail closed；
9. dsh ops 默认只读；写操作需显式 opt-in；
10. `npm run lint`、`npm test`、`npm run build` 全绿；
11. 现有 `pth config` / `pth config export` 行为零变化。

## 12. 开放问题

- 后续是否抽共享 validator 包，消除 golden fixtures 的复制成本；
- 是否需要 `pth config provider model` 子命令族（models 增删改查）；
- `provider test` 未来是否通过受控 Network Execute admin profile 实现；
- 其他配置（env/trust/services）是否统一编入 `pth config`。
