# PTH CLI Provider 配置能力施工反馈报告

> 状态：**设计定稿待评审；尚未实施**  
> 日期：2026-08-26  
> PTH 提交基线：`cd40af0`（`pi-triple-pth/main`）  
> pi-platform 参考范围：`extensions/pit-providers/types.ts`、`registry.ts`  
> 检查范围：`pth config provider`、`@away_from/pth-config` provider 配置后端、dsh ops 薄封装  
> 关联设计：[PTH Provider 配置 CLI 设计](../design/pth-provider-config-cli-design.md)  
> 关联计划：[PTH Provider 配置 CLI 实施计划](../plan/pth-provider-config-cli-implementation-plan.md)  
> TCE 约束：[ADR-0004：TCE 的 C 是 Code](../../adr/0004-tce-code-layer-ptc-capability-first.md)

## 0. 执行摘要

这项任务目前只有未提交的设计和实施计划，没有实现代码。仓库事实是：

- `packages/pth-config/src/provider-config.ts` 不存在；
- `packages/pth-config/test/` 不存在；
- `src/cli/provider-command.ts` 不存在；
- `src/cli/pth-cli.ts` 仍只支持 `pth config` 和 `pth config export`；
- dsh `preset/pth-ops` 尚未出现 provider 配置改动；
- 设计状态为“设计定稿待评审”，计划状态为“待实施”。

设计的总体方向是合理的：把命令编入 `pth config provider`，把配置读写逻辑集中在
`@away_from/pth-config`，CLI 和 dsh ops 只做薄适配；不管理 API key，不依赖 PTH server，也不把
provider 品牌和凭据带进普通任务能力面。

但在进入 P0 实现前，仍有五个必须冻结的问题：

1. PTH 与 pi-platform 分别镜像 schema 会形成两份事实源；
2. CLI 新增的 `PTH_PROVIDERS_FILE` 路径优先级没有被实际 consumer 识别；
3. `provider test` 若直接由 dsh 模型调用，会形成绕过 Network Execute 的 SSRF/内网探测通道；
4. JSON 模式业务失败退出码 0 会让自动化和 `execFile` 容易误判成功；
5. 原子 rename 只能防 torn write，不能解决并发 lost update、symlink、备份冲突和 read-only 语义矛盾。

因此，本报告建议：

> **先把跨仓 schema、路径、写入并发和模型网络边界钉死，再实现 CLI。V1 保留 provider
> list/get/add/update/remove/validate/backup/restore；`test` 不进入模型工具面，最好整体后置。**

## 1. 能力边界与 TCE 复核

### 1.1 这是配置管理能力，不是模型推理 provider 路由

本任务管理的是 `providers.json` 中的 provider 声明：名称、base URL、API 类型、模型清单和
`apiKeyEnv` 名称。它不管理：

- `auth.json` 中的实际 key；
- 多 key 池的登录和轮换；
- 当前 LLM 请求的 provider 选择；
- Engine 内部 model router；
- pi 扩展热加载；
- 远程多租户配置服务。

这一范围应继续保持。Provider 配置工具不能演变成“让普通 worker 随意更换底层模型或读取密钥”
的运行时控制面。

### 1.2 三层映射

| 层 | 正确职责 | 禁止行为 |
|---|---|---|
| Tool / CLI | 暴露结构化 action、参数、JSON 输出与人工帮助 | 暴露任意 shell、任意文件写入 |
| Code / adapter | 选择 list/get/add/update/remove 等明确动作，构造 typed request | 拼接任意命令字符串、复制 validator |
| Execute / config backend | 路径解析、校验、锁、备份、原子写、审计 | 决定模型何时改配置、执行任意网络请求 |

本地 `pth` CLI 本身不是 LLM Tool→Code 路径，可以直接调用配置后端；但一旦 dsh ops 把它暴露给
模型，就必须限制成结构化 admin action。不能因为底层使用 `execFile`，就允许模型控制二进制、
cwd、任意 argv 或任意文件路径。

### 1.3 外部接口边界

dsh ops 只应作为运维应用：

```text
dsh structured tool
  → 固定 pth binary
  → 固定 config provider action
  → @away_from/pth-config canonical backend
```

它不应该复制 ProviderDef 校验、直接编辑 JSON 或向普通 pth-interface 用户任务 Agent 暴露。
模型写操作应当是显式 opt-in 的 admin 能力，而不是安装 preset 后默认开放。

## 2. 当前仓库状态

### 2.1 PTH CLI 当前行为

`src/cli/pth-cli.ts` 的 `config` 分支当前只有：

```ts
case "config":
  if (rest[0] === "export") return configExport();
  return configList();
```

这意味着在实现新命令前，执行：

```bash
pth config provider list
```

不会报“尚不支持 provider”，而是忽略额外参数并打印普通 PTH 环境配置列表。P1 实现时必须先修正
dispatch，使未知 `config` 子命令 fail closed，避免用户误以为 provider 操作已经成功。

### 2.2 pth-config 当前能力

当前 `packages/pth-config/src` 只有：

- `config-center.ts`
- `env-file.ts`
- `index.ts`
- `schema.ts`

没有 provider 文件格式、validator、atomic writer、backup、restore 或跨仓兼容测试。因此计划中的
P0 尚未开始。

### 2.3 实际 consumer

`providers.json` 的当前 consumer 位于 `pi-platform/extensions/pit-providers`：

- `types.ts` 定义 `ProviderDef/ModelDef`；
- `registry.ts` 解析路径、校验并加载；
- 默认路径只识别 `PI_TRIPLE_HOME`，再拼接 `providers.json`；
- `registry.ts` 注释称规则为 spec v3，`types.ts` 注释仍称 spec v2；
- 文件顶层 `version` 则固定为数字 `1`。

这里已经存在“格式版本 1、schema 说明 v2/v3”三个不同版本概念。新实现必须先统一术语，不能继续
用一个 `version` 同时表示文件格式、类型定义修订和 validator 行为。

## 3. 设计中值得保留的部分

### 3.1 命令空间

使用：

```text
pth config provider ...
```

优于增加新的顶层 `pth provider`。它保持配置操作集中，也方便未来在 `pth config` 层统一实施
read-only、备份和审计策略。

### 3.2 后端单点实现

把 load/validate/save/backup/restore 放入 `@away_from/pth-config`，CLI 和 dsh 都调用同一个实现，
方向正确。不要在 `provider-command.ts` 或 dsh preset 中复制 JSON schema 和 merge 语义。

### 3.3 更新语义

以下规则清晰且适合 V1：

- provider `id` 不可修改；
- 标量字段按出现与否替换；
- `alias/models/inferRules/inferDefaults` 整体替换；
- 不做 model 数组的隐式深度合并；
- 写入前全量校验；
- restore 前先校验备份。

### 3.4 凭据边界

`providers.json` 只保存 `apiKeyEnv` 名称，不保存实际 key。配置 CLI 不读取和回显环境变量值，也
不接管 `/login`、`/keys` 或 auth.json。这一点必须保持。

## 4. 实施前必须修正的问题

### P0-1：跨仓 schema 不能靠人工镜像成为单一事实源

设计 D1 要求在 `@away_from/pth-config` 镜像 `pit-providers` schema，并称前者为未来唯一实现；但
实际 consumer 仍会继续使用 pi-platform 自己的 `types.ts/registry.ts`。只要两边独立修改，就会
出现：

```text
CLI 校验通过
  → 写入 providers.json
  → pit-providers 使用另一套规则拒绝或静默丢字段
```

推荐顺序：

1. 将文件格式 contract/JSON Schema 放入两仓都能消费的中立契约位置；
2. PTH writer 与 pi-platform reader 从同一 schema 生成或共享 validator；
3. 如果 V1 暂时不能抽共享包，至少建立一组跨仓 golden fixtures，两个仓库 CI 都必须验证；
4. 文件内明确 `formatVersion: 1` 的语义，另用 package/version 记录 schema revision；
5. 未知字段策略必须一致：拒绝、保留或丢弃只能选一种。

仅复制接口定义而没有双向 conformance test，不足以支撑“schema 兼容”验收条件。

### P0-2：路径覆盖与实际 consumer 不一致

设计规定路径优先级：

```text
PTH_PROVIDERS_FILE
  → PI_TRIPLE_HOME/providers.json
  → ~/.pi-triple/providers.json
```

但当前 `pit-providers` 只读取 `PI_TRIPLE_HOME/providers.json`。如果用户设置
`PTH_PROVIDERS_FILE`，CLI 会修改一个 consumer 根本不读取的文件，却仍然报告成功。

必须选择并钉死一种行为：

- consumer 同时支持 `PTH_PROVIDERS_FILE`；或
- 该变量只允许测试使用，生产命令显式警告目标文件不是当前 consumer 路径；或
- 删除该覆盖，测试通过传入显式 backend path 完成，而不是污染公共环境契约。

### P0-3：`provider test` 会绕过网络 Execute 安全边界

设计中的 `test` 会直接请求 `GET {baseUrl}/models`。同时 dsh 模型工具允许 add/update provider。
这两项组合后，模型可以：

```text
add provider(baseUrl = http://127.0.0.1:... 或内网地址)
  → test provider
  → 通过宿主 CLI 探测本机或内网服务
```

这相当于新增一个绕过 `SafeHttpTransport`、DNS/IP 检查和 Network Execute trace 的 SSRF 通道。

V1 建议：

- 不实现 `test`；至少不把 `test` 暴露给 dsh 模型；
- 后续若需要，调用受控 Network Execute admin profile；
- 本地服务探测必须有独立 allowlist/批准态，不能复用公开网络 profile；
- 凭据、URL 和响应内容仍要进入 redaction 与 trace。

### P1-1：JSON 业务失败退出码 0 容易制造假成功

设计规定 JSON 模式下 provider 不存在、校验失败等业务错误输出 `{ok:false}`，但退出码仍为 0。
这要求每个 shell、CI 和 dsh `execFile` 调用方都记得解析 JSON，否则会把失败当成功。

更稳妥的约定是：

- stdout 始终输出结构化 JSON；
- 成功退出 0；
- 业务失败退出 1；
- CLI 用法错误退出 2；
- dsh wrapper 同时解析 stdout/stderr 和 exit code。

如果坚持业务失败退出 0，实施计划必须明确 dsh 对 `{ok:false}` 做二次判定，并为这一点增加回归
测试，不能只依赖 `execFile` 是否 reject。

### P1-2：atomic rename 不解决并发 lost update

计划中的“读 → 内存修改 → fsync → rename”能防止半文件，但两个并发 writer 仍可能都读到旧版本，
后写者覆盖先写者。

后端至少需要：

- 同目录 lock file 或 advisory file lock；
- 读取时记录原始 hash/revision，保存前 compare-and-swap；
- 备份名加入高精度时间或随机后缀并使用 exclusive create；
- rename 后 fsync 目录；
- 对 symlink 和非普通文件 fail closed；
- 明确原文件权限、新文件权限和备份权限。

### P1-3：read-only 与 backup 语义矛盾

设计称 `PTH_CONFIG_READONLY=1` “禁止所有 `pth config` 写操作”，但实施计划又把 `backup` 列为不受
影响的读操作。backup 会创建新文件，restore 还会覆盖原文件。

需要明确 read-only 的含义：

- 如果只禁止修改 authoritative config，应改名并允许显式 backup/export；
- 如果禁止该命令产生任何文件副作用，backup 也必须拒绝；
- dsh 模型是否允许指定 backup 输出位置应单独限制。

### P1-4：alias lookup 缺少唯一性规则

`get <id>` 设计为也接受 `alias[0]`，但没有规定：

- alias 是否可以与另一个 provider id 相同；
- 两个 provider 是否可以拥有相同 alias；
- 是否只认第一个 alias，还是认 alias 数组全部值；
- 冲突时返回谁。

建议全局要求 `provider.id + all aliases` 唯一，冲突时 validator 拒绝整个文件，不按数组顺序选择。

### P1-5：dsh 写能力默认值过于宽松

设计中的 CLI 默认允许写，这对本地人工命令合理；但 dsh ops 是模型操作面，不应因安装 preset 就
默认获得 provider 写权限。

建议分开：

- 本地 CLI：默认可写，受文件权限和显式 read-only 控制；
- dsh ops：默认只开放 list/get/validate；
- 模型 add/update/remove/restore：要求 `PTH_PROVIDER_WRITE=1` 明确开启；
- remove/restore 仍要求批准态或管理员确认，不能仅由模型传 `yes=true` 自行越过。

## 5. 建议的 V1 实施范围

### 5.1 保留

```text
pth config provider list [--json]
pth config provider get <id> [--json]
pth config provider add --json <json> | --file <path>
pth config provider update <id> --json <json> | --file <path>
pth config provider remove <id> [--yes]
pth config provider validate [--file <path>]
pth config provider backup [--output <path>]
pth config provider restore <file> [--yes]
```

### 5.2 后置

- `pth config provider test`；
- model 子命令族；
- pi 扩展热加载；
- 远程 provider API；
- 多租户 provider registry；
- 从普通 Engine RoleRun 调用 provider 配置。

### 5.3 dsh ops 最小面

第一阶段只开放：

```text
list / get / validate
```

第二阶段在显式管理员 opt-in 和批准态完成后开放：

```text
add / update / remove / backup / restore
```

`test` 不进入 dsh V1。

## 6. 修订后的施工顺序

### P0：冻结跨仓 contract

1. 明确 formatVersion/schema revision；
2. 统一路径解析规则；
3. 建立两仓 golden fixtures；
4. 明确 alias、unknown field 和 merge 语义；
5. 决定 JSON exit code。

### P1：实现安全配置后端

1. 在 `@away_from/pth-config` 实现 typed load/validate；
2. 增加 lock/CAS、backup、atomic save、directory fsync；
3. 增加 symlink、权限、并发和失败注入测试；
4. 证明 pi-platform consumer 可读取写入结果。

### P2：接入 CLI

1. 先修复 `pth config` 未知子命令 silent fallback；
2. 增加 `provider-command.ts`；
3. 保留旧 `pth config` 和 `pth config export` 行为；
4. 人类与 JSON 输出使用同一 domain result；
5. 不实现 `test`。

### P3：接入 dsh ops

1. 先开放只读 action；
2. 固定 binary、cwd、argv 和目标文件；
3. canonicalize/realpath 后检查 backup 路径，防 symlink 逃逸；
4. 写操作要求显式 opt-in 和批准态；
5. wrapper 解析 JSON body，不能只看进程退出状态。

### P4：跨仓验收

1. CLI 在临时目录跑完整 CRUD/backup/restore；
2. pi-platform 用同一 fixture 加载；
3. dsh 只读和写入权限分别验证；
4. 跑 PTH lint/test/build/docs；
5. 跑 pi-platform provider registry 定向测试；
6. 跑 dsh syntax/package/接口测试。

## 7. 完成判据

- [ ] provider 文件格式只有一份 canonical schema 或生成源；
- [ ] PTH writer 与 pi-platform reader 使用同一组 golden fixtures；
- [ ] CLI 路径和 consumer 路径完全一致；
- [ ] 未知 `pth config` 子命令 fail closed；
- [ ] add/update/remove/restore 在锁与 CAS 下不会丢并发更新；
- [ ] 校验失败、写失败和进程中断不会破坏原文件；
- [ ] alias/id 冲突规则有测试；
- [ ] read-only/backup/restore 语义无矛盾；
- [ ] JSON 输出和 exit code 对人工、CI、dsh 一致可判定；
- [ ] dsh 默认不获得 provider 写权限；
- [ ] V1 不存在模型可控的任意 URL 请求通道；
- [ ] 现有 `pth config` / `pth config export` 行为保持兼容；
- [ ] PTH、pi-platform、dsh 三仓定向验收全部通过。

## 8. 最终反馈

把 provider 管理编入 `pth config`、把真实读写集中到 `@away_from/pth-config`、让 dsh 只做薄封装，
这三个方向可以保留。当前真正需要修订的不是命令名称，而是跨仓 contract 和安全执行边界。

尤其要避免把一个看似普通的 `provider test` 变成模型可控的内网 HTTP 工具。只要先解决 schema
单一来源、路径一致性、并发写入、权限默认值和 TCE egress 问题，后续 CLI 实现本身是一个边界清晰、
可独立交付的基础能力。
