# 三源谱系重构实施方案

> 状态：**实施中（W0–W3 已完成，W4 进行中）**
> 设计文档：`docs/pth/three-source-lineage-and-capacity-conservation-design.md`（概念模型/9 条裁决以此为准）
> 分支：`feat/pth-exec-unified`（继续沿用，不另开分支）
> 规模预估：5 waves（W0–W4），每 wave 独立提交、全量串行测试保持绿

**实施进度（2026-08-24）**：

| Wave | 状态 | Commit |
|---|---|---|
| W0 类型契约与产物边界 | ✅ 完成 | `4456ab8` |
| W1 三源谱系重构（Origin 退役） | ✅ 完成 | `942ad8b` |
| W2 controller 工具面清算 + plan grant | ✅ 完成 | `502f81c` |
| W3 terminal reject 终态化 + events 外推 | ✅ 完成 | `97e61fa` |
| W4 守恒校验器 + 注册闸 + 迁移 + 文档 | 🔄 进行中 | — |

**实施总约束（每 wave 必须满足）**：
1. `npm run lint` 全绿 + 全量串行 `npm test -- --maxWorkers=1` 全绿（基线：319 文件 / 2772 通过 / 58 跳过）；
2. 不触碰既有绑定裁决：默认 exec mode `tool-call`、ASP_BLOCK 冻结、`human_requests` 契约、pause 语义、
   goal 传播、无 worker 自发 escalate 工具；
3. 每 wave 一个 commit（`refactor(roles): …`）；文档改动单独 `docs(pth): …`；
4. `role.generation` 已核查无逻辑消费（仅派生计算与展示排序）——全树顺移安全（设计 §0 Q5）；
5. 既有 tag 路由不变式：角色固定标签 = tag-registry 精确匹配路由唯一标准——改动只增删、不改语义。

---

## W0：类型契约与产物边界（produces + 双 kind + 写边界）

**目标**：落地 Q1/Q6 的载体——`RoleDefinition.produces` 字段、`observation-report` /
`modification-plan` 两 kind、`memory.write` 边界 kind 白名单强制。本 wave 不改任何角色行为
（所有角色 `produces` 暂为 `undefined` = 不限），纯机制先行。

### 改动清单

| 文件 | 改动 |
|---|---|
| `packages/pth-kernel-execution/src/execution/worker-cluster.ts` | `RoleDefinition` 新增 `produces?: readonly string[]`（注释：承诺产物 kind 白名单——`memory.write` 边界服务端强制；`undefined` = 不限（生产工种）；空数组 = 禁止任何 memory 写入） |
| `packages/pth-kernel-execution/src/execution/builtin-roles.ts` | 导出常量 `OBSERVATION_REPORT_KIND = "observation-report"`、`MODIFICATION_PLAN_KIND = "modification-plan"`、`LEGACY_OPTIMIZER_SUGGESTION_KIND = "optimizer-suggestion"`（废止标注——迁移用） |
| `src/pth/impls/kernels/capability.ts` | `wrapValidated("memory.write", …)` 增强：注入当前角色 `produces`（capability 装配处已知 role），`entry.kind ∉ produces` → 抛错（fail-fast，错误消息含角色 id 与允许 kind 列表）。角色上下文经装配闭包传入，**不改 PTC 契约形状**（`ptc/contract.ts` 不动） |
| capability 装配调用点（`builtin-catalog-contributions.ts` / kernel capability 注入处） | 把 role.produces 传入 `wrapValidated` 闭包 |

### 测试（`test/pth-kernel-execution/` 或就近）

1. `produces` 边界钉死：声明 `["observation-report"]` 的角色写该 kind 通过、写其他 kind fail-fast、错误消息含允许列表；
2. `produces: undefined` 角色写任意 kind 通过（兼容）；
3. `produces: []` 角色写任何 kind 均 fail-fast；
4. 两 kind 常量导出可见。

### 验收

- 机制就位且**对现有角色零行为变化**（全部 `undefined`）；全量测试绿。

### 提交

`refactor(roles): produces 产物边界与 observation-report/modification-plan kind 机制（W0）`

---

## W1：三源谱系重构（Origin 退役 + 三源 gen 0 + 全树顺移）

**目标**：落地 Q5/Q8 与设计 §2/§5——角色定义层重构。本 wave 只做**谱系结构与 prompt**，
工具面/终态机制留给 W2/W3。

### 改动清单

| 文件 | 改动 |
|---|---|
| `packages/pth-kernel-execution/src/execution/builtin-roles.ts` | ① 删 `ORIGIN_ROLE`（连带导出清理——grep `ORIGIN_ROLE` 全部消费点同步改）；② `actuator`/`sensor`/`controller`：`parent` 删除、`generation: 0`、`differentiation` 改为「（三源之根——2026-08-24 三源重构：Origin 退役）」；③ **全树 generation 顺移 -1**（四族 2→1、治理点位 2→1、叶子 3→2…逐角色核对）；④ **7 个 sensor prompt 去建议化**：删「建议…优化方向」语义，产物描述改「`observation-report`——事实+评估，不含方案」；⑤ **9 个 controller prompt 去实施化**：删 `manage.params.set` 热调/回滚执行/直派任务语义，产物描述改「`modification-plan` draft（含回滚条件/复测窗口/implementation 路由声明）——批准与实施不在本角色」；⑥ `actuator` prompt 加实施职责段：「②实施 official 方案（按 implementation 路由派生的实施任务——逐字执行、不得改方，结果落 `implementation-report`）」；⑦ sensor/controller 系填 `produces`（sensor 系 `["observation-report"]`、controller 系 `["modification-plan"]`、`controller:adversarial` 按产物实际定） |
| `packages/pth-kernel-execution/src/execution/worker-cluster.ts` | 注释改写：§60 行「谱系树的根（generation=0）——所有角色的分化起点」→「三源森林——actuator/sensor/controller 三 gen 0 根」；§306 行「generation=1——Origin 的初代分化」→ 新语义；展示排序逻辑不动（顺移后相对顺序不变） |
| `src/pth/tasking/delegation-policy.ts` | 删 origin 特例行（§61-63）与文件头注释对应行；矩阵推导不变式保持：治理面空 / 内部类型直接子 / planner·governor 补充 / 叶子空 |
| `src/pth/catalog/adapters/builtin-catalog-contributions.ts` | origin 贡献项删除（若有）；其余 generation 透传自动正确 |
| `src/pth/gateway/routes-lineage.ts` | 谱系展示多根核查（parent null 现有处理应天然支持三 root——若按「唯一根」假设展示则改）；「父+1」派生计算不动 |
| tag-registry / 路由消费点 | grep `origin` 全仓（排除 `original`/lease）逐一核对：角色标签、路由规则、注释 |

### prompt 改写准则（W1-④/⑤ 的统一口径）

- **sensor 系**：任务段保留观测对象/数据源；删一切「建议 X 方向」句式；产物段统一改为
  「产物：memory.write kind=observation-report——观测事实 + 严重度评估 + 证据链。**只观测评估，
  不开处方——方案归 controller:** <镜像点位>」；
- **controller 系**：任务段首句改「读取 sensor:<镜像点位> 的 observation-report」；删
  `manage.params.set`/「恶化回滚」执行/「复测验证（下窗口对比）」执行语义（复测是 sensor 的事，
  本角色只声明复测窗口）；产物段统一为「产物：memory.write kind=modification-plan（status=draft
  ——监督层流转）——含目标/变更内容/预期效果/回滚条件/复测窗口/implementation 路由声明。
  **只提案不实施**」；
- 保留并强化各点位的对抗性自审/预算守卫/治理族不豁免等既有纪律表述。

### 测试

1. **更新** `test/pth-kernel-execution/agent-tool-convergence.test.ts` 六例（九类型工具面钉死、
   MID prompt 句式、治理族根豁免——prompt 改写后同步）；
2. **更新** 全部 origin 引用测试（grep `origin` test/——谱系/路由/delegation 相关）；
3. **新增**钉死：三 gen 0 根（parent 均空）；任意角色 parent 链必达三根之一；generation = 父+1
   全树一致；sensor 系 produces 全为 `["observation-report"]`、controller 系为
   `["modification-plan"]`；
4. delegation 矩阵：origin 行删除后 `allowedDelegationTargets("origin")` 返回空（未知角色语义）——
   钉死；planner/governor 补充权不变。

### 验收

- 谱系 API（routes-lineage）展示三源森林正确；全量测试绿；
- **已知行为变更**（写 release notes draft）：`origin` 角色/标签不复存在——带 `origin` 标签的
  任务不再路由（此前路由到 Origin 兜底）——W3 完成终态外推后语义闭环。

### 提交

`refactor(roles): 三源谱系——Origin 退役 + 三源 gen 0 + 全树 generation 顺移 + prompt 职责清算（W1）`

---

## W2：职责越界清算（controller 工具面 + 实施任务契约）

**目标**：落地 Q2/Q3——信息源边界与实施机制。依赖 W0（kind/produces）+ W1（角色面）。

### 改动清单

| 文件 | 改动 |
|---|---|
| `builtin-roles.ts`（capabilities 列） | controller 系 `capabilities` 白名单核查：剔除 `obs.*` 全族（保留 memory.read/query 读 observation-report、`manage.tool.list` 类注册面只读快照）；sensor 系保留 `obs.*`；actuator 系不动 |
| `packages/pth-kernel-interpreter/src/extensions/manage.ts` | `manage.params.set` 等**即时生效类**工具加 **plan grant 校验**：调用必须携 grant（绑定 `modification-plan` hash + official 状态）——无 grant 拒绝；`manage.tool.list`/`manage.worker.propose`/`manage.memory.archive`（draft 落盘类）保持原语义（提案 ≠ 实施，合规） |
| plan grant 机制（复用 `execution-grant-service`——N28 已有） | 新 grant scope：`plan:<sha256>`；签发点 = 审批面 official 落闸处；`implementation.kind` 路由派生实施任务时注入 payload |
| `modification-plan` schema 校验 | 审批闸处校验 plan 必填字段：目标/变更内容/预期效果/回滚条件/复测窗口/**implementation**（`{kind, routeHint?}`，kind 枚举：param-change/code-fix/storage-cleanup/role-register/…） |
| 实施任务派生器 | official 事件 → 按 `implementation.kind` 路由表派生 actuator 任务（param-change → 参数面实施任务携 plan grant；code-fix → developer 任务；role-register → 注册生效路径（治理面系统件，不派任务））；payload 携方案 hash；实施任务 done 契约：`result.planHash` 必填，偏离 reject（服务端校验——挂任务类型不挂角色） |

### 测试

1. controller 系 capabilities 无 `obs.*`、sensor 系有（钉死全量点位）；
2. `manage.params.set` 无 grant 拒绝 / 携合法 plan grant 通过 / grant 与方案 hash 不符拒绝；
3. plan schema 缺 `implementation` 字段 → 审批闸拒绝；
4. 实施任务 done 缺 `planHash` → reject；引用一致 → 通过；
5. 注册生效类方案（role-register）不派生 actuator 任务（治理面直接生效）。

### 验收

- controller 工具面与 prompt 一致（prompt 已在 W1 清算——本 wave 机制对齐）；
- obs.* 单双向收口正确；全量测试绿。

### 提交

`refactor(roles): controller 工具面清算 + plan grant 实施任务契约（W2）`

---

## W3：terminal reject 外推（升级链语义拆除）

**目标**：落地 Q4——terminal reject = 终态 + HTTP API 外推。依赖 W1（origin 标签已无）。

### 改动清单

| 文件 | 改动 |
|---|---|
| `src/pth/bootstrap/task-loop.ts` | §360 注释改写（「Origin 升级链事件源」→「terminal reject 统一出口——task.rejected 活动事件供 trigger/事件面消费」）；terminal reject 统一出口处追加 **external event 外推**（复用 `emitExternalEvent` → EventBus → SSE 通道——`routes-events.ts` 已验证 delivered 路径）：事件类型 `task.terminal-reject`，payload 含 taskId/role/reason/traceId |
| `packages/pth-kernel-execution/src/execution/trigger-engine.ts` | retask 模式内 Origin 专用语义删除：「升级终止：已属 target（Origin 失败即终态）」注释与 origin 兜底链注释改写为通用语义（retask 作为通用 trigger 能力**保留**——角色间升级链是合法运营手段；删除的是 origin 兜底链的专属语义与注释）；`origin` 字面量清零 |
| `src/pth/gateway/routes-trigger.ts` | retask API 能力保留；注释核对 |
| 运营面核查 | grep 全仓 + deploy/seed 数据确认无 origin 兜底链 trigger 注册（若有注册脚本/文档，同步删除并注记） |

### 测试

1. terminal reject → `task.terminal-reject` external event 出现在 events 流（SSE 通道可订阅——
   钉死事件类型与 payload 字段）；
2. terminal reject 后任务**不重发布**（无 origin 兜底——终态即终态）；
3. 通用 retask trigger（非 origin 链）功能回归不变；
4. task-control-service 的 pause 升级 escalated（P1 生命周期——与终态 reject 不同语义）不受影响。

### 验收

- 操作面（PTL/operator console）经 SSE 可见终态失败；升级链语义在代码与注释中清零；全量测试绿。

### 提交

`refactor(roles): terminal reject 终态化 + events 外推——Origin 升级链语义拆除（W3）`

---

## W4：守恒校验器 + 注册闸 + 文档收尾

**目标**：落地 Q9 与设计 §7/§10——守恒可审计 + 概念文档同步。

### 改动清单

| 文件 | 改动 |
|---|---|
| `scripts/check-role-conservation.ts`（新建） | ① 从 builtin-roles + tool-reg 快照计算各角色 `effcap`（T=承诺任务类型 / A=capabilities 并集 / D=spaceScope·defaultReads·produces / O=delegation-policy 推导——四元组口径按设计 §6.2）；② **L1 覆盖对账**：每 generation 并集 vs C（C = tool-reg 注册工具全集 ∪ 角色承诺任务类型全集 ∪ 数据空间全集）——漏覆盖 fail-fast；③ **L2 倒挂检测**：`cap(c) ⊀ effcap(p)` fail-fast（按四元组逐维判定——D/O 维按集合包含）；④ **重复度报告**（Q7——兄弟 A 维 Jaccard 重叠度排序输出，不 fail）；⑤ 输出分「错误 / 质量指标」两档，exit code 区分 |
| lint 接入 | `package.json` lint 链加 `check-role-conservation`（与 check-pth-config 同档） |
| `src/pth/gateway/routes-lineage.ts`（注册闸） | 分化/注册提案批准闸加 L1–L3 校验：新角色必须是父能力真子集、produces 声明合法、兄弟并集不破覆盖 |
| 存量记忆迁移 | 一次性迁移（启动迁移或脚本——择轻者）：`kind=optimizer-suggestion` 条目 meta 标注 `migratedFrom:"optimizer-suggestion"` + 按内容语义归kind（含方案结构字段 → modification-plan；纯观测 → observation-report；不确定 → 保留原 kind + 标注，人工分流） |
| `docs/pth/concepts.md` | §0.7.1 控制论映射表重写（三源严格分工 + 新回路）；§0.16.1 组织权段删 origin 行、补「三源森林」句；词条表 origin/sensor/controller 三条重写；谱系示例链（Origin → actuator → …）改三源表述 |
| 历史文档沿革注记 | `n14-sensor-controller-four-dims.md`、`n16-v1.2-role-expansion.md`、`design-tensions-adjudication.md` 头部加一行注记（「2026-08-24 三源重构：optimizer-suggestion 语义废止、triple 升 gen 0——详见 three-source-lineage-and-capacity-conservation-design.md」）——**历史正文不改写** |
| `docs/pth/release-notes-v1.8.0.md` | breaking 变更条目：origin 角色/标签删除、terminal reject 语义变更、produces 边界、controller 工具面变更 |
| `docs/docs-manifest.json` | 重生成 + 恢复 release-notes 手工分类（已知生成器行为——复用本轮手法） |

### 测试

1. 校验器钉死：当前树 L1/L2 全过；构造漏覆盖/倒挂 fixture 均 fail-fast；重复度报告输出但不 fail；
2. 注册闸：非法 produces / 非真子集提案被拒（fixture 级）；
3. 迁移：fixture 条目分流正确；
4. `npm run lint` 含新校验器全绿；文档链接校验绿。

### 验收

- 守恒成为 CI 可执行不变量；concepts.md 与代码一致；release notes 完整。

### 提交（两个）

1. `refactor(roles): 守恒校验器 + 注册闸 L1–L3 + 存量 kind 迁移（W4）`
2. `docs(pth): concepts 三源修订 + 历史文档沿革注记 + release notes breaking 条目（W4）`

---

## 风险与回滚

| 风险 | 等级 | 缓解 / 回滚 |
|---|---|---|
| prompt 大改影响在跑 agent 行为 | 中 | W1 prompt 改写准则统一口径；全量测试 + agent-tool-convergence 钉死兜底；按 wave 回滚单 commit |
| produces 边界误伤存量角色 | 低 | W0 全部 `undefined`（零行为变化）；W1 仅治理族填白名单；边界测试先行 |
| origin 删除影响外部脚本/运营习惯 | 中 | release notes breaking 条目；W1 已知行为变更显式列出；W3 外推保证失败可见性优于旧兜底 |
| 守恒校验器口径争议（D/O 维集合判定边界） | 中 | W4 先落地 T/A 维硬判定 + D/O 维报告档，口径稳定后升级——校验器自身留 `--strict` 档 |
| 迁移误分流（optimizer-suggestion → 双 kind） | 低 | 不确定项保留原 kind + 标注人工分流——不强行归类 |
| 全量测试时间（串行 ~7min × 5 waves） | 低 | 每 wave 先跑目标测试文件再全量；允许按 wave 累积后统一全量两轮 |

## 兼容约束汇总（对外语义）

1. **breaking**：`origin` 角色/标签删除（W1）；terminal reject 不再自动重发布（W3）；
   controller 系失去 `obs.*` 与 `manage.params.set` 直调（W2）；
2. **兼容**：retask trigger API、组织权矩阵（除 origin 行）、W8 投递契约、任务池协议、
   PTH HTTP API 形状、`lease.generation` 语义——全部不变；
3. **新增**：`observation-report` / `modification-plan` kind、`produces` 字段、
   `task.terminal-reject` 事件、plan grant scope、check-role-conservation。
