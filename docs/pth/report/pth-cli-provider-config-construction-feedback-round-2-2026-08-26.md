# PTH CLI Provider 配置能力施工反馈报告（第二轮）

> 状态：**PTH writer/CLI、pi-platform reader conformance 与 dsh 只读工具均已形成工作区实现；主要安全边界已吸收，但跨仓名字空间和保真契约仍未闭环**  
> 日期：2026-08-26  
> PTH 提交基线：`e48fca9`（相关 Provider 改动尚未提交）  
> pi-platform 提交基线：`46b7918`（相关 reader/test 改动尚未提交）  
> dsh-interface 提交基线：`3ed14e5`（相关 ops 改动尚未提交）  
> 检查范围：`pth config provider`、canonical writer、跨仓 contract、pi-platform consumer、dsh ops 只读能力  
> 第一轮报告：[PTH CLI Provider 配置能力施工反馈](./pth-cli-provider-config-construction-feedback-2026-08-26.md)  
> 跨仓契约：[Provider 配置 Contract](../contract/provider-config-contract.md)  
> 关联设计：[PTH Provider 配置 CLI 设计](../design/pth-provider-config-cli-design.md)  
> 关联计划：[PTH Provider 配置 CLI 实施计划](../plan/pth-provider-config-cli-implementation-plan.md)

## 0. 第二轮结论

第一轮报告检查时，该能力只有设计和计划。第二轮工作区已经出现完整实现：

- `packages/pth-config/src/provider-config.ts`：typed load/validate/save/backup/restore；
- `src/cli/provider-command.ts`：`list/get/add/update/remove/validate/backup/restore`；
- `src/cli/pth-cli.ts`：`config provider` 正式分派和未知子命令 fail closed；
- `docs/pth/contract/provider-config-contract.md`：跨仓 canonical contract；
- 两仓一致的 golden fixtures；
- pi-platform reader 的 baseUrl 与全局名字校验；
- dsh ops 的只读 `pth_config_provider`；
- lock、CAS、原子 rename、文件/目录 fsync、exclusive backup、symlink 拒绝；
- JSON 业务失败非零退出码；
- `provider test` 明确后置，没有形成绕过 Network Execute 的模型可控 HTTP 通道。

这说明第一轮给出的安全和边界建议基本被吸收，整体架构已经合理：PTH 提供 canonical writer 和
本地 CLI，pi-platform 继续作为 reader，dsh ops 只做受限管理入口，普通任务能力面不接触
provider 配置。

但是，第二轮通过代码和实际构造用例发现：

> **contract 规定 `id + alias` 共用一个全局名字空间，当前两仓实现却分别以 `id:` 与 `alias:`
> 为 key，导致 alias 可以与另一个 provider id 冲突。**

此外，pi-platform reader 会重建 ProviderDef/ModelDef 并丢弃未知字段，与 contract 的“未知字段
保留”不一致；缺失文件的第一次并发创建仍可能发生 lost update。

综合判断：

> **Provider CLI 已从设计阶段进入合并前修正阶段。无需改变总体方案；修复全局名字空间、consumer
> 保真、首次创建 CAS 和 dsh 路径语义，并补对应测试后即可拆仓提交。**

## 1. 与第一轮反馈的对账

| 第一轮问题 | 第二轮状态 | 证据/说明 |
|---|---|---|
| PTH/pi-platform 两份 schema 靠人工镜像 | 部分修复 | 新增 canonical contract + 两仓 golden fixtures；仍是两份 validator 实现 |
| `PTH_PROVIDERS_FILE` consumer 不识别 | 已修复设计 | 不再引入该变量，统一使用 `PI_TRIPLE_HOME/providers.json` |
| `provider test` 绕过 Execute/SSRF | 已修复 | V1 返回 `NOT_IMPLEMENTED`，dsh 不暴露 test |
| JSON 业务失败退出 0 | 已修复 | `fail()` 设置 exit code 1，usage error 为 2 |
| 未知 `pth config` 子命令静默回退 | 已修复 | 未知 config 子命令 fail closed |
| 原子 rename 不防 lost update | 基本修复 | lock + expected hash CAS；缺失文件首次并发仍有窗口 |
| symlink/非普通文件 | 已修复 | `lstat().isFile()` fail closed |
| 备份冲突 | 已修复 | 时间戳 + 随机后缀 + `wx` |
| dsh 写能力过宽 | 已修复 | 只暴露 list/get/validate，不暴露写、test、restore |
| read-only 与 backup 语义矛盾 | 已修复主要路径 | 写 action 受 `PTH_CONFIG_READONLY`/`PTH_PROVIDER_WRITE` 保护 |

第一轮报告中的“尚未实施”已经过时，应继续保留为历史基线，由本报告记录实现后的收口问题。

## 2. 能力边界与 TCE/控制面复核

### 2.1 这不是普通任务工具

Provider 配置属于本地主机/运维控制面：

- 修改影响模型路由和可用上游；
- baseUrl 可能指向内网；
- 配置文件可引用 API key 环境变量名；
- 错误配置可能使整个 Agent 系统不可用。

因此它不应进入普通 PTH worker 的 Tool/Code 能力索引，也不应由研究任务、开发任务等普通模型
直接调用。

### 2.2 PTH CLI

PTH CLI 是显式管理员入口：

```text
pth config provider list|get
pth config provider add|update|remove
pth config provider validate
pth config provider backup|restore
```

CLI 只做参数解析、输出和权限守卫，文件事实逻辑集中在 `@away_from/pth-config`，这一分层合理。

### 2.3 dsh ops

dsh ops 只暴露：

- list；
- get；
- validate。

模型不能通过该工具：

- 修改 provider；
- 恢复备份；
- 发起 provider test；
- 读取 API key；
- 任意执行 shell。

这符合“模型可观察，管理员显式写入”的 V1 边界。

### 2.4 Network Execute 边界

`provider test` 未实现是正确裁决。若后续需要测试连接，应：

1. 使用受控 admin network profile；
2. 经过 SSRF/DNS/redirect/private-address policy；
3. 不让模型直接决定任意 baseUrl 并立即探测；
4. 对响应大小、timeout 和 credential 使用做审计；
5. 与普通 `net.fetch` 的 public-untrusted profile 区分。

## 3. 当前实现进度

### 3.1 canonical writer/backend

已经实现：

- `providersPath()`；
- ProviderDef/ModelDef/InferRule 类型；
- document/provider validation；
- unknown field writer round-trip；
- defaults normalization；
- add/update/remove/get；
- file hash；
- lock file；
- compare-and-swap；
- temp write + fsync + rename + directory fsync；
- backup/restore；
- symlink/non-regular target 拒绝；
- `0o600` 新文件和备份权限。

### 3.2 CLI

已经实现：

- `list --json`；
- `get <id|alias>`；
- `add --data|--file`；
- `update <id|alias> --data|--file`；
- `remove <id|alias> --yes`；
- `validate [--file]`；
- `backup [--output]`；
- `restore <file> --yes`；
- write guard；
- 非零错误退出码；
- 未知 action usage error；
- `test` 显式 `NOT_IMPLEMENTED`。

### 3.3 pi-platform reader

已经增加：

- `baseUrl` http(s) 校验；
- provider id 重复检查；
- alias 重复检查；
- golden fixture conformance 测试。

### 3.4 dsh ops

已经增加：

- `pthBin` 配置；
- `providersFile` 配置；
- `execFile` 调用 PTH CLI；
- 只读 action whitelist；
- JSON CLI 输出回传；
- 明确不提供 test/write/restore。

## 4. P0：`id + alias` 全局名字空间没有实现

### 4.1 contract 要求

```text
provider.id + 所有 provider.alias → 一个全局唯一名字空间
```

例如以下文件必须拒绝：

```json
{
  "version": 1,
  "providers": [
    { "id": "alpha", "alias": [] },
    { "id": "beta", "alias": ["alpha"] }
  ]
}
```

### 4.2 当前实现

PTH writer 与 pi-platform reader 都使用：

```ts
names.set(`id:${def.id}`, ...)
names.set(`alias:${alias}`, ...)
```

这创建了两个互不冲突的命名空间。`id:alpha` 与 `alias:alpha` 被视为不同 key。

本轮直接调用 PTH validator 构造上述输入，实际结果为：

```json
{"ok":true,"errors":[],"warnings":[]}
```

### 4.3 影响

`getProvider()` 使用数组顺序查找 `id === input || alias.includes(input)`，因此冲突文件会产生：

- get 结果取决于 provider 数组顺序；
- update/remove 可能操作错误 provider；
- PTH writer 和 pi consumer 都无法提供确定解析；
- alias 的兼容用途反而成为配置歧义源。

### 4.4 修复要求

两仓 validator 都应使用同一个 normalized name Set：

```ts
for (const name of [def.id, ...(def.alias ?? [])]) {
  if (names.has(name)) reject;
  names.add(name);
}
```

并增加：

- id 与后续 alias 冲突；
- alias 与后续 id 冲突；
- 同 provider 内 alias 重复；
- 空 alias；
- alias 非字符串。

## 5. P1：pi-platform consumer 丢弃未知字段

### 5.1 contract 要求

contract 与 golden fixture 明确允许 provider/model 未知字段，以便不同 provider 扩展而不需要同时
升级所有消费者。

### 5.2 当前 reader 行为

pi-platform `validateProvider()` 在校验后重新构造 ProviderDef：

```ts
const def = {
  id,
  name,
  baseUrl,
  api,
  multiKey,
  refreshModels,
  models: models.map(m => ({ knownFieldsOnly }))
};
```

因此合法 fixture 中的 `x-vendor`、`x-model-tag` 等未知字段在 load 后消失。当前 conformance 测试
只断言“能加载且 provider 数量大于 0”，没有断言字段保真。

### 5.3 处理方式

可以二选一，但必须统一 contract：

1. 推荐：validator 校验已知必填字段后，保留完整原对象并只做类型收窄；
2. 或修改 contract，明确 reader 可丢弃未知字段，但 writer 必须保留。

当前 contract 已明确“不丢字段”，因此应修 reader 和测试，而不是静默接受漂移。

## 6. P1：缺失文件的首次并发创建仍会 lost update

### 6.1 当前流程

当文件不存在时：

```text
loadForRead() → doc=[] + hash=null
saveProvidersFile(... expectedHash: current.hash ?? undefined)
```

`null` 被转成 `undefined`，CAS 检查完全跳过。

两个进程可以同时读取“文件不存在”，分别构造 provider A/B。lock 会让写入串行，但第二个写者在
拿到 lock 后不会检查文件已由第一个写者创建，最终用只含 B 的文档覆盖只含 A 的文档。

### 6.2 修复要求

CAS 必须区分：

- 未指定前置条件；
- 期望文件不存在；
- 期望文件 hash 为某值。

可以将 `expectedHash` 改为 `string | null`，其中 `null` 表示“提交时仍必须不存在”；或者使用显式
`expectedState: { kind: "missing" } | { kind: "hash"; value: string }`。

测试应以两个独立 writer 同时首次 add 为例，最终要么：

- 一个成功、一个 `CONCURRENT_MODIFICATION`；
- 或第二个重新读取并合并。

不能静默覆盖。

## 7. P1/P2 跨仓契约问题

### 7.1 reader 部分加载与“拒绝整个文件”（P1）

contract 写的是 validator 发现冲突后拒绝整个文件。pi-platform `loadProviders()` 当前会保留前面
已经通过校验的 providers，只把错误放入 `errors`。调用方若忽略 errors，可能在半有效配置上运行。

需要明确：

- strict mode：任一 contract error → providers=[]；
- tolerant mode：部分加载，但调用方必须显式选择且状态不可视为健康。

当前不能既写“拒绝整个文件”，又默认返回部分 provider。

### 7.2 字符串校验强度不一致（P2）

当前只检查若干字段 `typeof === "string"`：

- `api: ""` 可通过，但 contract 要求非空；
- `model.id: ""` 可通过，但 contract 要求非空；
- alias 可包含空字符串；
- pi-platform 对 alias 元素没有逐个字符串校验；
- `name` 是否允许空字符串未形成一致规则。

应在 contract 和两仓 fixture 中一次冻结。

### 7.3 spec v2/v3 注释仍漂移（P2）

pi-platform `types.ts` 注释称 spec v2，`registry.ts` 注释称 spec v3，文件本身固定 `version:1`。
contract 已解释“文件 version 与 schema revision 分离”，代码注释仍应统一为 contract revision 或直接
引用文档，避免继续产生三种版本口径。

### 7.4 两份 validator 的维护成本（P2）

golden fixtures 能发现部分漂移，但当前测试没有覆盖所有 contract 规则。长期可以考虑发布一个只含
types/validator 的小型共享包；V1 不必为此阻塞，只要先把 fixture matrix 做完整并在两仓 CI 同时跑。

## 8. dsh ops 适配问题

### 8.1 `providersFile` 实际只消费目录（P1）

dsh 配置项名和注释称它是完整文件路径，但实现只执行：

```ts
PI_TRIPLE_HOME = path.dirname(providersFile)
```

PTH CLI 最终固定读取该目录下的 `providers.json`。如果用户填写
`/config/custom-provider-registry.json`，实际读取的是 `/config/providers.json`。

建议：

- 将配置改名为 `providersDir`；或
- 校验 basename 必须是 `providers.json`；
- 不要制造一个 contract 不支持的自定义文件名假象。

### 8.2 stdout 仍是字符串封套（P2）

dsh 工具返回：

```json
{"ok":true,"output":"{ ...CLI JSON string... }"}
```

CLI 非零退出码已经能防误判，安全性没有问题；但结构化能力索引和 LLM 使用体验更适合解析 stdout
JSON 后直接返回 `{ok:true, providers/...}`。解析失败时再返回 raw output。

### 8.3 `pthBin` 的空格拆分（P2）

`splitPthBin()` 支持 `node /path/to/cli.js`，但不能正确处理可执行路径中的空格或引号。V1 可以接受，
但配置说明应限制路径形态，或将 `pthCommand` 建模为 argv 数组。

## 9. 测试与证据

### 9.1 PTH

```text
test/pth-config/provider-config.test.ts
test/pth-cli/provider-command.test.ts

2 test files passed
27 tests passed
```

覆盖：

- valid/invalid fixture；
- defaults；
- CRUD；
- id immutable；
- models wholesale replace；
- save/load；
- backup/restore；
- symlink 拒绝；
- CAS 已存在文件；
- unknown field writer round-trip；
- CLI exit codes；
- read-only/write guard；
- `test` 未实现。

### 9.2 pi-platform

```text
test/pit-providers/golden-fixtures.test.ts

1 test file passed
3 tests passed
```

覆盖 valid fixtures、bad id、bad URL 和 duplicate alias，但没有覆盖 alias↔id 冲突、unknown field
保真和 strict whole-file rejection。

### 9.3 dsh-interface

已验证：

- `node --check lib/index.js`；
- `node --check preset/pth-interface/pth-interface.mjs`；
- `node --check preset/pth-ops/pth-ops.mjs`；
- `npm pack --dry-run --json`。

全部通过。dsh 仓库没有自动测试脚本，当前只得到语法与打包证据，没有工具调用 E2E。

### 9.4 全量检查

- PTH 完整 `npm run lint`：通过；
- pi-platform 完整 `npm run lint`：通过；
- 两仓 boundary/config/product/docs checks：通过；
- 两仓 golden fixture 目录逐文件一致；
- 三仓 `git diff --check`：通过。

## 10. 建议施工顺序

### P0：修全局名字空间

1. 在 contract fixture 增加 `invalid-alias-collides-with-id.json`；
2. 先让 PTH/pi-platform 两仓测试失败；
3. 两仓 validator 改用统一 Set；
4. 验证 get/update/remove 不再产生歧义；
5. 同步补 alias 元素校验。

### P1：修 reader 保真和 strict 语义

1. conformance 测试断言 provider/model unknown field；
2. reader 保留原始字段；
3. 明确 invalid document 是否整体拒绝；
4. 调用方不得忽略 errors 并继续当作健康配置。

### P1：补首次创建 CAS

1. 把 missing 作为显式 expected state；
2. 添加两个独立 writer 并发首次 add 测试；
3. 确保没有 silent overwrite；
4. 保持 lock、backup 和 atomic rename 现有实现。

### P1：收紧 dsh 路径语义

1. `providersFile` 改名为 `providersDir` 或校验固定 basename；
2. 增加只读 action 的 fake CLI E2E；
3. 解析 JSON stdout 为结构化结果；
4. 继续不开放写操作和 provider test。

### P2：整理版本与验证矩阵

1. 统一 spec/version 注释；
2. 增加 api/model id/alias 空值 fixture；
3. 把同一 fixture matrix 纳入两仓 CI；
4. 更新第一轮报告状态为历史，由第二轮报告作为当前反馈入口。

## 11. 合并门槛

- [ ] alias 与任意 id/alias 冲突时两仓都拒绝；
- [ ] pi-platform reader 不丢 provider/model unknown field；
- [ ] invalid document 的 whole-file/partial-load 语义与 contract 一致；
- [ ] missing-file 首次并发创建不会 silent overwrite；
- [ ] `api`、`model.id`、alias 的非空与类型规则一致；
- [ ] dsh 路径配置不再暗示支持任意文件名；
- [ ] dsh 继续只读且不暴露 provider test；
- [ ] PTH 27 个现有测试及新增回归测试通过；
- [ ] pi-platform conformance 及新增保真测试通过；
- [ ] PTH、pi-platform、dsh 三仓分别形成可审查提交。

本轮不要求：

- provider test；
- API key 管理；
- provider 热加载；
- 远程/多租户配置服务；
- 把 Provider CRUD 暴露给普通任务 Agent；
- 为 CLI 引入数据库。

## 12. 最终意见

第二轮实现证明第一轮的总体方向成立：Provider 配置应该由本地 canonical writer 管理，CLI 提供
显式管理员入口，pi-platform 读取，dsh ops 默认只读；网络连通测试继续受 Execute 安全边界控制。

当前剩余问题不需要推倒重来，主要是 contract 实现精度：名字空间、未知字段、并发首次创建和路径
语义。把这四项修正并用 golden/concurrency/E2E 测试锁住后，该能力即可进入分仓提交和管理员试用。
