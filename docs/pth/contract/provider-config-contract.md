# Provider 配置 Contract（providers.json）

> 状态：第三轮验收通过；reader 已迁入本仓
> 范围：`~/.pi-triple/providers.json` 的格式 contract
> 消费方：`extensions/pit-providers`（reader，已从 pi-platform 迁入）、`@away_from/pth-config`（writer/CLI）、dsh ops（薄封装）
> 关联设计：`docs/pth/design/pth-provider-config-cli-design.md`
> 关联计划：`docs/pth/plan/pth-provider-config-cli-implementation-plan.md`

## 1. 目的

本文件是 `providers.json` 的 **canonical contract**。PTH writer 与本仓 reader（`extensions/pit-providers`）都必须遵守；
pi-platform 已停止维护，不再作为独立消费方。任何修改都必须同步 golden fixtures，并让 writer/reader conformance 测试通过。

## 2. 文件位置

```text
PI_TRIPLE_HOME/providers.json    # 若设置了 PI_TRIPLE_HOME
~/.pi-triple/providers.json      # 默认
```

不引入 `PTH_PROVIDERS_FILE` 公共覆盖。测试通过 `PI_TRIPLE_HOME` 或显式 backend `file` 参数隔离。

## 3. 文件格式版本

```json
{
  "version": 1,
  "providers": []
}
```

- `version` 只表示 **文件格式版本**，当前固定为 `1`；
- schema revision 由本 contract 文档版本和 package version 记录，不写入文件；
- validator 行为由本 contract + golden fixtures 锁定。

## 4. ProviderDef

```ts
interface ProviderDef {
  id: string;                    // 必填，^[a-z0-9-]+$，全局唯一
  name: string;                  // 必填
  alias?: string[];              // 可选，全局唯一，不得与任何 id/alias 冲突
  baseUrl: string;               // 必填，http(s)://
  api: string;                   // 必填，默认 "openai-completions"
  apiKeyEnv?: string;            // 环境变量名，不是密钥本身
  multiKey: boolean;             // 必填
  refreshModels: boolean;        // 必填
  compat?: Record<string, unknown>;
  models: ModelDef[];            // 必填，可为空数组
  inferRules?: Array<{
    pattern: string;
    contextWindow?: number;
    maxTokens?: number;
    reasoning?: boolean;
    cost?: Partial<ModelCost>;
    input?: string[];
    compat?: Record<string, unknown>;
  }>;
  inferDefaults?: Partial<Omit<ModelDef, "id" | "name">>;
  [key: string]: unknown;        // 未知字段保留
}
```

## 5. ModelDef

```ts
interface ModelDef {
  id: string;                    // 必填，无格式限制
  name?: string;
  reasoning?: boolean;
  input?: string[];
  cost?: ModelCost;
  contextWindow?: number;
  maxTokens?: number;
  compat?: Record<string, unknown>;
  thinkingLevelMap?: Partial<Record<"off"|"minimal"|"low"|"medium"|"high"|"xhigh"|"max", string | null>>;
  [key: string]: unknown;        // 未知字段保留
}

interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
```

## 6. 校验规则

| 规则 | 行为 |
|---|---|
| 顶层必须是对象，`version === 1` | 否则拒绝 |
| `providers` 必须是数组 | 否则拒绝 |
| `provider.id` 正则 `^[a-z0-9-]+$` | 否则拒绝 |
| `provider.id` 全局唯一 | 否则拒绝 |
| `provider.name` 必须非空字符串 | 否则拒绝 |
| `provider.alias[]` 全局唯一 | 否则拒绝 |
| alias 元素必须非空字符串 | 否则拒绝 |
| alias 不得与任何 id/alias 相同（含同 provider 的 id） | 否则拒绝 |
| `baseUrl` 必须 http(s) | 否则拒绝 |
| `api` 必须非空字符串 | 否则拒绝 |
| `multiKey` / `refreshModels` 必须 boolean | 否则拒绝 |
| `models` 必须数组 | 否则拒绝 |
| `model.id` 必须非空字符串 | 否则拒绝 |
| 未知字段 | 不拒绝，保存时保留 |

## 7. 唯一性语义

- `id` + 全部 `alias` 构成一个全局唯一名字空间；
- 冲突时 validator 拒绝整个文件，不按数组顺序“先到先得”。

## 8. Update / Merge 语义

`update` 只允许：

- 标量字段（`name` / `baseUrl` / `api` / `apiKeyEnv` / `multiKey` / `refreshModels` / `compat`）按出现与否替换；
- `alias` / `models` / `inferRules` / `inferDefaults` 整体替换；
- `id` 不可更新；
- 未出现的字段保持原值；
- 未知字段保留。

## 9. 写操作安全

- 所有写操作必须先全量校验，校验失败不落盘；
- 原子写：临时文件 + `fsync` + `rename` + 父目录 `fsync`；
- 并发保护：lock file + compare-and-swap（hash）；`expectedHash` 为 `null` 时表示“提交时文件仍必须不存在”，防止首次并发创建 lost update；
- 备份：时间戳 + 随机后缀，exclusive create；
- symlink / 非普通文件 fail closed；
- 新文件/备份权限 `0o600`。

## 10. Conformance

本仓必须维护同一组 golden fixtures：

```text
test/fixtures/providers/golden/*.json
```

每个 fixture 必须同时满足：

- PTH writer：读取 → 修改 → 保存后仍通过校验；
- reader（`extensions/pit-providers`）：`loadProviders()` 能成功加载且不丢字段；
- dsh ops：通过 `pth config provider` 薄封装保持同一路径语义。

## 11. 变更流程

1. 修改本 contract；
2. 同步更新本仓 golden fixtures；
3. writer/reader conformance 测试与 dsh 工具测试全部通过；
4. 更新关联设计与计划文档。
