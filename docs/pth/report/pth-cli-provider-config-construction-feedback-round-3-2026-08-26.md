# PTH CLI Provider 配置能力施工反馈报告（第三轮验收）

> 状态：**通过；第二轮名字空间、保真、strict、首次创建 CAS 与 dsh 路径语义门槛已全部闭环**
> 日期：2026-08-26
> PTH 验收基线：`66d67e3`（本地 `main`，尚未推送至 `origin/main`）
> pi-platform 验收基线：`03b1cc4`（本地 `main`，领先 `origin/main` 1 个提交）
> dsh-interface 验收基线：`ad8de95`（其后另有 `f2a8bb9`，本地共领先 `origin/main` 2 个提交）
> 检查范围：canonical writer、CLI、跨仓 contract/fixtures、pi-platform reader、dsh ops 只读入口、文件并发与交付状态
> 第二轮报告：[PTH CLI Provider 配置能力施工反馈报告（第二轮）](./pth-cli-provider-config-construction-feedback-round-2-2026-08-26.md)
> 跨仓契约：[Provider 配置 Contract](../contract/provider-config-contract.md)
> 关联设计：[PTH Provider 配置 CLI 设计](../design/pth-provider-config-cli-design.md)

## 0. 第三轮结论

第二轮报告列出的四个主要缺口已经全部修复：

1. PTH 和 pi-platform 都把 provider id 与全部 alias 放入同一个全局名字空间；
2. pi-platform reader 校验后保留 provider/model 未知字段；
3. invalid document 采用 strict whole-file rejection；
4. missing-file 首次创建使用 `expectedHash: null`，不会 silent overwrite；
5. dsh 配置改为 `providersDir`，legacy `providersFile` 只做兼容转换；
6. dsh 成功结果会解析 CLI JSON 为结构化对象，且继续只暴露 list/get/validate。

两仓 golden fixture 目录逐文件一致；PTH 32 个 Provider 后端/CLI 测试、pi-platform 5 个 conformance
测试和 dsh 2 个工具测试均通过。PTH 与 pi-platform 完整 lint 也全部通过。

第三轮判定：

> **Provider 配置 V1 功能验收通过，可以进入推送、代码审查和管理员试用。该能力继续属于本地主机/
> 运维控制面，不进入普通 worker 的 Tool/Code 能力索引；provider test、凭据管理与热加载仍后置。**

## 1. TCE 与控制面边界

### 1.1 普通 Tool/Code 面

普通任务 Agent 不获得 Provider CRUD、配置文件读取或任意连接测试能力。Provider 配置不属于研究、
开发或网络任务中的普通能力索引。

### 1.2 管理入口

PTH CLI 是显式管理员入口：

```text
pth config provider list|get
pth config provider add|update|remove
pth config provider validate
pth config provider backup|restore
```

CLI 只做参数解析、输出和 write guard；文件事实逻辑集中在 `@away_from/pth-config`。

### 1.3 dsh ops

dsh 只读入口仅允许：

- list；
- get；
- validate。

模型不能通过 dsh：

- add/update/remove；
- backup/restore；
- provider test；
- 任意 shell；
- 读取 API key 明文。

### 1.4 Network Execute

`pth config provider test` 在 V1 明确返回 `NOT_IMPLEMENTED`。未来若实现，必须走受控 admin network
profile，并复用 DNS/SSRF/redirect/timeout/size/credential 审计，而不是让配置 CLI 自建任意 HTTP
通道。

## 2. 第二轮合并门槛对账

| 第二轮门槛 | 第三轮状态 | 证据与判断 |
|---|---|---|
| alias 与任意 id/alias 冲突时两仓拒绝 | **通过** | 两仓统一 name Set；alias↔id、duplicate alias fixtures 通过 |
| pi reader 保留 provider/model unknown field | **通过** | validator 保留原始对象；load 后断言 `x-vendor`/`x-model-tag` |
| invalid document whole-file rejection | **通过** | 任一 provider invalid 时返回 `providers=[]` + errors |
| missing-file 首次并发不 silent overwrite | **通过** | `expectedHash: null` 表示必须仍不存在；并发测试一个成功、一个 CAS conflict |
| api/model.id/alias 非空与类型规则一致 | **通过** | 两仓共享 invalid fixtures；空值/非字符串均拒绝 |
| dsh 路径不暗示任意文件名 | **通过** | canonical 配置为 `providersDir`；legacy file path 转 dirname |
| dsh 继续只读且无 provider test | **通过** | action whitelist 固定 list/get/validate |
| PTH/pi/dsh 测试 | **通过** | 32 + 5 + 2 |
| 三仓形成可审查提交 | **通过本地提交，尚未推送** | `66d67e3`、`03b1cc4`、`ad8de95` |

## 3. canonical writer/backend

当前后端具备：

- `PI_TRIPLE_HOME/providers.json` 单一路径契约；
- typed document/provider/model/infer 定义；
- version 与 required fields 校验；
- provider id 格式与 baseUrl http(s) 校验；
- provider/model unknown field round-trip；
- 全局 id/alias 唯一；
- defaults normalization；
- get/add/update/remove；
- provider id immutable；
- lock file；
- expected hash CAS；
- missing expected state；
- temp write + file fsync + rename + directory fsync；
- symlink/非普通目标拒绝；
- exclusive backup；
- restore 前完整 validation；
- 新文件/备份 `0o600`。

## 4. 首次创建并发语义

`SaveOptions.expectedHash` 现在有三态：

```text
undefined → 不声明前置条件
string    → 当前文件 hash 必须相等
null      → 提交时文件必须仍不存在
```

当两个 writer 同时从“文件缺失”开始 add：

- lock 保证物理写串行；
- 第一个 writer 创建文件；
- 第二个 writer 拿到 lock 后发现文件已存在；
- 第二个返回 `CONCURRENT_MODIFICATION`，不会覆盖第一个文档。

这已经满足 V1 的防 lost update 要求。CLI 可以让用户重新读取后重试，不需要在 writer 内自动做
不可审计的 merge。

## 5. 跨仓 contract 一致性

### 5.1 名字空间

PTH 和 pi-platform 都按以下集合检查：

```text
provider.id + provider.alias[] → one global namespace
```

同 provider 内 alias 重复、alias 等于自身 id、alias 与其他 id/alias 冲突都会拒绝。

### 5.2 unknown field

PTH writer 使用对象 spread 保留未知字段；pi reader 校验后直接保留完整对象，只做类型收窄。Provider
级 `x-vendor` 与 Model 级 `x-model-tag` 已进入 conformance assertions。

### 5.3 strict 文档

pi reader 不再返回“前半有效 providers + errors”的半健康状态。任一 contract error 会拒绝整个文件，
避免调用方忽略 errors 后继续运行不完整路由。

### 5.4 fixtures

本轮 `diff -ru` 比较两仓 `test/fixtures/providers/golden`，无差异。fixture matrix 覆盖：

- valid defaults；
- valid unknown fields；
- bad provider id；
- bad base URL；
- empty api/name/model id/alias；
- alias non-string；
- duplicate alias；
- alias 与 id 冲突。

## 6. dsh ops 适配

dsh `pth_config_provider`：

- 通过 `execFile` 调用 PTH CLI；
- 用 `PI_TRIPLE_HOME=providersDir` 指定 canonical 目录；
- `providersFile` 只作为 legacy compatibility，自动转为 dirname；
- 成功 stdout 是 CLI JSON 时直接解析并返回 `{ok:true, providers/provider/...}`；
- 解析失败才回退 raw output；
- action 非白名单时 fail closed；
- get 缺 id 时返回 INVALID_ARGS；
- 写操作、restore、test 不在 tool schema 和实现中。

## 7. 安全复核

### 7.1 文件安全

- 目标必须为普通文件；
- symlink 目标拒绝；
- 临时文件用 `wx`；
- backup 用随机后缀和 `wx`；
- rename 前写入并 fsync；
- rename 后 directory fsync；
- lock 有超时和 stale 回收；
- CAS 在持锁后检查。

### 7.2 权限与自动化

- `PTH_CONFIG_READONLY=1` 拒绝 add/update/remove/restore；
- `PTH_PROVIDER_WRITE=0` 拒绝写操作；
- remove/restore 需要 `--yes`；
- JSON 业务失败 exit code 非零；
- usage error 使用 exit code 2；
- 未知 config/provider action fail closed。

### 7.3 凭据边界

providers.json 只保存 `apiKeyEnv` 等引用，不由 CLI 输出实际环境变量值或 auth.json 明文。dsh 只读
查询可能看到环境变量名，但不会得到 secret。

## 8. 验证证据

### 8.1 PTH

```text
test/pth-config/provider-config.test.ts   22 passed
test/pth-cli/provider-command.test.ts     10 passed
```

合计 32/32。

### 8.2 pi-platform

```text
test/pit-providers/golden-fixtures.test.ts  5 passed
```

### 8.3 dsh-interface

```text
npm test                                   2 passed
node --check lib/index.js                  passed
node --check preset/pth-interface/...      passed
node --check preset/pth-ops/...            passed
npm pack --dry-run --json                  passed
```

### 8.4 全量静态检查

- PTH 完整 lint：通过；
- pi-platform 完整 lint：通过；
- 两仓 boundary/config/product/docs checks：通过；
- PTH import cycle/TCE coverage/role conservation：通过；
- 两仓 fixture `diff -ru`：无差异；
- 三仓 `git diff --check`：通过。

## 9. 非阻断后续项

### 9.1 validator 共享方式

两仓当前仍各自实现 validator，以 contract + golden fixtures 保持一致。V1 已足够；后续若规则继续
增长，可以抽取只含 types/validator 的小型共享包，但不应把完整 PTH config backend引入
pi-platform。

### 9.2 `pthBin` argv

dsh 仍用空白拆分支持 `node /path/to/cli.js`，不能完整表达带空格/引号的复杂命令。当前默认 `pth`
与常规绝对路径可用；后续可把配置改成 argv 数组。

### 9.3 provider test

继续后置。实现时必须先形成 admin network profile、credential 使用审计和明确的审批/超时/响应上限。

### 9.4 热加载与凭据管理

provider hot reload、多 key 管理、remote/multi-tenant config service 均不是 V1 验收范围。

## 10. 交付状态

功能与测试已通过，但三个提交仍只在本地：

| 仓库 | 本地提交 | 相对 origin |
|---|---|---:|
| pi-triple-pth | `66d67e3` | 本地 `main` 总计领先 2 个提交 |
| pi-platform | `03b1cc4` | 领先 1 个提交 |
| dsh-pth-interface | `ad8de95` | 当前 HEAD 含后续修复，共领先 2 个提交 |

因此“功能验收通过”不等于“远端交付完成”。下一步应按跨仓依赖顺序审查并推送，避免只推 writer
而未推 consumer/dsh 适配。

## 11. 最终意见

Provider 配置 V1 已达到预期边界：PTH 是 canonical writer 和管理员 CLI，pi-platform 是严格保真的
reader，dsh ops 是只读观察入口；普通任务 Agent 不获得配置写入或任意网络测试能力。

第三轮不再建议修改总体架构。完成跨仓推送与审查后即可进入管理员试用；后续扩展应优先考虑
受控 provider test 和运行时 reload，而不是把 Provider CRUD 下放给 Code/普通 Tool 面。
