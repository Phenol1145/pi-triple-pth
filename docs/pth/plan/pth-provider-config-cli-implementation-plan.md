# pth config provider 配置 CLI 实施计划

> 状态：实施中（PTH 侧 P0-P2 已完成；dsh 只读工具已接入；跨仓 conformance 已建立）
> 范围：`pth config provider` 子命令族 + `@away_from/pth-config` provider 配置后端 + dsh ops 薄封装
> 关联设计：`docs/pth/design/pth-provider-config-cli-design.md`
> 施工反馈：`docs/pth/report/pth-cli-provider-config-construction-feedback-2026-08-26.md`

## 修订摘要

- V1 不实现 `provider test`；
- 不引入 `PTH_PROVIDERS_FILE` 公共覆盖；路径与 `pit-providers` 完全一致；
- 跨仓 contract 用 golden fixtures + conformance 测试锁定；
- 后端增加 lock/CAS、symlink fail-closed、目录 fsync、备份 exclusive create；
- JSON 业务失败退出码改为 1；
- `pth config` 未知子命令 fail closed；
- dsh 默认只读，写操作需显式 opt-in 和批准态。

## P0：冻结跨仓 contract

**目标**：在写代码前钉死 providers.json 格式、路径、唯一性、未知字段和版本语义。

### 交付物

| 文件 | 内容 |
|---|---|
| `docs/pth/contract/provider-config-contract.md` | canonical contract：格式版本、schema、唯一性、未知字段、merge 语义、路径 |
| `test/fixtures/providers/golden/*.json`（pi-triple-pth） | PTH writer conformance fixtures |
| `pi-platform/test/fixtures/providers/golden/*.json`（pi-platform） | pi-platform reader conformance fixtures |

### 冻结内容

1. `version: 1` 只表示文件格式版本；schema revision 由 contract 文档/package version 记录；
2. 未知字段保留；
3. `provider.id + alias` 全局唯一；
4. `update` merge 语义：标量替换、`models/alias/inferRules/inferDefaults` 整体替换、`id` 不可改；
5. 路径解析只认 `PI_TRIPLE_HOME/providers.json` 或 `~/.pi-triple/providers.json`；
6. 不实现 `provider test`。

### 完成标准

- contract 文档评审通过；
- 两仓 golden fixtures 一致；
- 两仓 conformance 测试计划明确。

## P1：实现安全配置后端（packages/pth-config）

**目标**：在 `@away_from/pth-config` 实现 typed load/validate/save/backup/restore，满足并发与文件安全要求。

### 新增文件

| 文件 | 内容 |
|---|---|
| `packages/pth-config/src/provider-config.ts` | ProviderDef/ModelDef 类型、路径解析、load/save/validate/backup/restore/merge、lock/CAS |
| `packages/pth-config/test/provider-config.test.ts` | 单元测试 |
| `test/pth-config/provider-config.integration.test.ts` | 临时目录真实读写、并发、symlink、权限测试 |

### 核心 API

```ts
resolveProvidersFile(env?: NodeJS.ProcessEnv): string;
loadProvidersFile(file?: string): Result<ProvidersFile>;
ensureProvidersFile(file?: string): ProvidersFile;
validateProvidersDoc(raw: unknown): { ok: true; doc: ProvidersFile; warnings: string[] } | { ok: false; errors: string[] };
validateProvider(raw: unknown): { ok: true; def: ProviderDef } | { ok: false; error: string };
saveProvidersFile(doc: ProvidersFile, file?: string, opts?): Result<{ backupPath?: string }>;
addProvider(doc: ProvidersFile, def: ProviderDef, opts?): Result;
updateProvider(doc: ProvidersFile, id: string, patch: Partial<ProviderDef>, opts?): Result;
removeProvider(doc: ProvidersFile, id: string, opts?): Result;
backupProvidersFile(file?: string, output?: string): Result<{ path: string }>;
restoreProvidersFile(backupFile: string, file?: string, opts?): Result;
```

### 安全要求

- lock file：`<providers.json>.lock`，`wx` exclusive create，带陈旧 lock 处理；
- CAS：保存前比较当前文件 hash 与读取时 hash，不一致报 `CONCURRENT_MODIFICATION`；
- 原子写：临时文件 + `fsync` + `rename` + 父目录 `fsync`；
- 备份：时间戳 + 随机后缀，exclusive create；
- symlink / 非普通文件：`lstat` 校验，fail closed；
- 权限：新文件/备份 `0o600`，沿用已有权限；
- 未知字段：load/save 原样保留。

### 完成标准

- 单元/集成测试覆盖：CRUD、备份、恢复、并发、symlink、权限、失败注入；
- `npm run build -w @away_from/pth-config` 通过；
- 不改变现有 `pth-config` 导出行为。

## P2：接入 CLI

**目标**：在 `src/cli/pth-cli.ts` 的 `config` 分支下增加 `provider` 子命令族。

### 新增/修改文件

| 文件 | 内容 |
|---|---|
| `src/cli/provider-command.ts` | `configProviderCommand(rest: string[]): Promise<void>` |
| `src/cli/pth-cli.ts` | `case "config"` 先识别 `provider`，未知子命令 fail closed；usage 更新 |

### 子命令

```text
list / get / add / update / remove / validate / backup / restore
```

不实现 `test`。

### CLI 行为

- `pth config provider ...` 使用 `@away_from/pth-config` backend；
- 先修复 `pth config` 未知子命令 silent fallback：`pth config provider ...` 在实现前/未知子命令时报错退出；
- 人类与 JSON 输出使用同一 domain result；
- 成功退出 0，业务失败退出 1，用法错误退出 2；
- JSON 模式下业务失败输出 `{ok:false}` 到 stdout 且退出码 1；
- 写守卫：`PTH_CONFIG_READONLY=1` 拒绝 add/update/remove/restore；`PTH_PROVIDER_WRITE=0` 拒绝 provider 写。

### 完成标准

- `node dist/cli/pth-cli.js config provider list` 可运行；
- 在 `PI_TRIPLE_HOME` 指向临时目录时 CRUD/backup/restore 全链路可用；
- `pth config provider test` 报“不支持”；
- `pth config unknown` 报错；
- `npm run lint`、`npm run build` 通过。

## P3：接入 dsh ops（默认只读）

**目标**：`dsh-pth-interface/preset/pth-ops` 增加 `pth_config_provider` 工具，V1 只开放只读 action。

### 修改文件

| 文件 | 内容 |
|---|---|
| `preset/pth-ops/agent.cordis.yml` | 增加 `pthBin`、`providersDir`（兼容旧 `providersFile`）、`providerWriteEnabled` 配置项 |
| `preset/pth-ops/pth-ops.mjs` | 增加 `pth_config_provider` 工具；补充 systemPrompt 手册 |

### 工具行为

```text
pth_config_provider(
  action: "list"|"get"|"validate",   # V1 只读
  id?: string,
  file?: string
)
```

- 通过 `execFile(config.pthBin, ["config", "provider", ...args], { cwd: config.repoDir, timeout: config.opsTimeoutMs })` 调用；
- wrapper 解析 JSON body 并检查 exit code；
- `file` 参数仅允许 `config.providersDir/providers.json`；
- 固定 binary、固定 argv 前缀、固定 cwd；
- 写操作（add/update/remove/restore/backup）在 V1 不暴露给模型；
- 后续阶段需显式 `providerWriteEnabled: true` + 管理员批准态后才开放写 action。

### 完成标准

- dsh ops 中 `pth_config_provider` 可 list/get/validate；
- 模型无法通过该工具执行写操作或任意 URL 请求；
- 不复制 provider 校验/写入逻辑。

## P4：跨仓验收

**目标**：PTH、pi-platform、dsh 三仓定向验收全部通过。

### 验收项

1. CLI 在临时目录跑完整 CRUD/backup/restore；
2. pi-platform 用同一组 golden fixtures 加载全部通过；
3. dsh 只读和写入权限分别验证；
4. 跑 PTH `npm run lint` / `npm test` / `npm run build` / `npm run check:docs-links`；
5. 跑 pi-platform `pit-providers` registry 定向测试；
6. 跑 dsh syntax/package/接口测试。

### 完成判据

- [ ] provider 文件格式有 canonical contract + golden fixtures；
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

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| 跨仓 schema 漂移 | canonical contract + golden fixtures + 两仓 CI conformance |
| 路径不一致 | 不引入 `PTH_PROVIDERS_FILE` 公共覆盖，CLI 与 consumer 同一路径 |
| 并发 lost update | lock + CAS + 原子写 + 目录 fsync |
| symlink/权限逃逸 | `lstat` fail-closed + realpath 校验 + `0o600` |
| SSRF/内网探测 | V1 不实现 `test`，dsh 不暴露任意 URL 请求 |
| dsh 误用写权限 | 默认只读；写操作需显式 opt-in 和批准态 |
| 与 pi 热加载状态不一致 | 文档明确“修改后需重启 pi 或刷新模型列表” |

## 里程碑

| 里程碑 | 内容 |
|---|---|
| M1 | P0 完成：contract + golden fixtures 冻结 |
| M2 | P1 完成：安全配置后端可用 |
| M3 | P2 完成：`pth config provider` CLI 可用 |
| M4 | P3 完成：dsh ops 只读工具可用 |
| M5 | P4 完成：三仓验收通过 |
