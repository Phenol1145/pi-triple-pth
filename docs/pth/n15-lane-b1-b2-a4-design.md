# N15：B1 穿透自动发现 / B2 执行预算经济化 / A4 护栏 JIT 设计

> 2026-08-18 · 下批车道设计（车道池候选，`docs/pth/parallel-lanes.md`）。
> 本文件是三条车道的**实施契约**：B2 是计量数据地基，B1 消费 B2 的计量面做自动发现，
> A4 消费 N12/N14 已落的护栏观测面做闭环。三条车道改动域不同，可并行 worktree 实现。
> 所有实现决策已在此钉死——车道实现不得另立语义；发现本文件未覆盖的真实分叉，停下上报。

## 0. 依赖关系与车道划分

| 车道 | 内容 | 依赖 | 主要文件域 |
|---|---|---|---|
| **B2** | 穿透执行预算 + 边级计量面 | 无（P0 已落） | `src/pth/tasking/penetration-budget.ts`（新）、`src/pth/bootstrap/batch-process.ts`、`src/pth/config/schema.ts` |
| **B1** | 稳定边自动发现 → `penetration-proposal` → 监督批准注册 | B2 的 `penetration-edge` 聚合行 | `src/pth/tasking/penetration-discovery.ts`（新）、`src/pth/kernel/execution/system-triggers.ts`、`src/pth/kernel/assembly.ts`、`src/pth/application/gateway/pth-gateway-facade.ts` |
| **A4** | 护栏 JIT：热点 → `guard-config` 建议 → 审批热调 → 复测/deopt 回滚 | N14 P1 `obs.guards` / `scorecard.guards` | `src/pth/kernel/execution/optimizer-hotspots.ts`、`optimizer-loop.ts`、`optimizer-apply.ts`、`src/pth/kernel/execution/guardrails.ts` |

合并顺序：**B2 → B1 → A4**（B1 测试依赖 B2 的聚合行语义；A4 独立可任意序）。

---

## 1. B2 穿透执行预算经济化（计量面数据基础）

### 1.1 目标

穿透 = 父任务内的同步子 agent 调用。现状问题：子 agent 吃满 `PTH_AGENT_MAX_STEPS`/
默认 timeout，父任务可无限次穿透——执行成本无边界；计量只发指标不上账。
本车道把穿透的执行成本收进两条预算线，并落**边级计量聚合行**（B1 的数据地基）。

### 1.2 配置（`src/pth/config/schema.ts` 新增；`runtime: true` = 可热调）

| 键 | 类型 | 默认 | 语义 |
|---|---|---|---|
| `PTH_PENETRATION_MAX_STEPS` | number | 40 | 单次穿透调用的子 agent 步数上限 |
| `PTH_PENETRATION_TASK_BUDGET_STEPS` | number | 80 | 同一父任务全部穿透调用的**累计步数**上限 |
| `PTH_PENETRATION_TIMEOUT_MS` | number | 300000 | 单次穿透子 agent 超时（传给 runAgentTask timeoutMs） |

语义裁决（本设计钉死）：
- 子 agent 每步的 LLM/kernel 计量已按 `domain=penetration` 汇入父任务计量面（现状保留，不改）。
- **预算只限步数**：v1 不把 token/时长折算成步数（经济化的第一步是物理边界；token 折算后续）。
- 预算耗尽 = 调用失败：`PtcContractError` 明确报错（P4 裁决「失败由父决策」——父可回退
  `tasks.delegate`）。不自动回退，不静默截断。

### 1.3 新模块 `src/pth/tasking/penetration-budget.ts`（纯函数，先测后写）

```ts
export interface PenetrationLedger { calls: number; steps: number; }
export interface PenetrationBudgetConfig {
  maxSteps: number;
  taskBudgetSteps: number;
  timeoutMs: number;
}
export interface PenetrationChildBudget {
  ok: true;
  maxSteps: number;      // min(单次上限, 剩余累计额度)
  timeoutMs: number;
  remaining: number;     // 本次执行后预计剩余（调用方以实际 steps 修正）
}
export interface PenetrationBudgetResult {
  ok: boolean;
  budget?: PenetrationChildBudget;
  error?: string;
}

export function childBudgetFor(
  ledger: PenetrationLedger,
  cfg: PenetrationBudgetConfig,
): PenetrationBudgetResult;

export function recordPenetrationUse(
  ledger: PenetrationLedger,
  steps: number,
): PenetrationLedger;   // { calls: ledger.calls + 1, steps: ledger.steps + steps }

export function penetrationBudgetError(cfg: PenetrationBudgetConfig, usedSteps: number): string;
```

规则：
- `used = ledger.steps`；`remaining = cfg.taskBudgetSteps - used`；
- `remaining <= 0` → `{ok:false, error: penetrationBudgetError(...)}`；
- `maxSteps = Math.max(1, Math.min(cfg.maxSteps, remaining))`；
- 累计预算用**实际 steps**结算（调用完成后 `recordPenetrationUse`）；单次预算命中
  `maxSteps` 时不额外扣满——按实际步数记账。
- `penetrationBudgetError` 文案必须包含：`穿透执行预算耗尽`、父任务 id 由调用方拼接、
  `PTH_PENETRATION_TASK_BUDGET_STEPS`、建议 `改走 tasks.delegate 或收敛穿透调用`。

### 1.4 batch-process `runChildImpl` 接线

- 闭包新增 `Map<string, PenetrationLedger>`（key = `req.caller.taskId`，单 batch 进程生命周期，
  任务不跨 batch 进程迁移——与现有「穿透共享父任务工作区」假设一致）；
- 每次调用：
  1. `childBudgetFor(ledger, budgetConfig)`；`ok:false` → 立即返回
     `{ ok:false, steps: ledger.steps, error: penetrationBudgetError(...), durationMs: 0 }`；
  2. `runAgentTask({ ..., maxSteps: budget.maxSteps, timeoutMs: budget.timeoutMs })`；
  3. 结算 `recordPenetrationUse(ledger, r.steps)`（无论成败——失败也消耗预算，防重试放大）；
  4. activity `task.penetrate` 事件追加 `budgetUsed: r.steps`、`budgetExceeded: r.steps >= budget.maxSteps`
     （软限命中标记；累计耗尽走 1 的失败路径）。
- 预算配置读取：`pthConfig().num(...)`（batch 进程配置中心快照——不逐调用热读，语义同
  `PTH_AGENT_MAX_STEPS`）。

### 1.5 边级计量聚合（B1 地基）

每次穿透调用结束后（成功/失败都计），调用
`dataWorld.memory.incrementAggregate?.(
  `penetration-edge:${req.caller.roleId}->${req.childRoleId}`,
  "penetration-edge",
  [req.caller.roleId, req.childRoleId, "penetration-edge"],
  { calls: 1, okCalls: r.ok ? 1 : 0, sumSteps: r.steps, sumDurationMs: durationMs, sumBudgetExceeded: r.steps >= budget.maxSteps ? 1 : 0 },
  { parent: req.caller.roleId, child: req.childRoleId, ts: Date.now() },
)`
- 增量键必须匹配 `^[a-zA-Z0-9_]{1,64}$`（PgMemoryStore.incrementAggregate 硬约束）；
- `incrementAggregate` 缺失（测试/降级）→ skip 不报错（沿用 optimizer 降级语义）；
- 聚合 content 语义（B1 解析契约）：JSON 对象，字段名 = 上述增量键名。

### 1.6 B2 验收

- 纯函数测试：`test/pth-tasking/penetration-budget.test.ts`——累计耗尽/单次上限取 min/
  结算按实际步数/错误文案含回退建议；
- 配置测试自动覆盖（`check:pth-config` 对 schema 增键有断言，如已有）；
- 全量 vitest + `npm run lint` 绿。

---

## 2. B1 穿透自动发现 → 提案注册

### 2.1 目标

把 B2 的 `penetration-edge` 聚合（即实际穿透执行面数据）转化为稳定边的注册提案：
发现 → `penetration-proposal`（draft）→ 监督批准（gateway 同流）→ `skill:penetrate:<child>`
official 落库。注册后的边才可被 `tasks.penetrate` 执行（现有校验不变）。

### 2.2 配置（schema 新增）

| 键 | 类型 | 默认 | 语义 |
|---|---|---|---|
| `PTH_PENETRATION_DISCOVERY_INTERVAL_MS` | number | 600000 | 发现巡检周期（10min） |
| `PTH_PENETRATION_DISCOVERY_MIN_CALLS` | number | 5 | 边累计调用数门槛 |
| `PTH_PENETRATION_DISCOVERY_MIN_OK_RATIO` | number | 0.8 | 成功率门槛 |
| `PTH_PENETRATION_DISCOVERY_MAX_AVG_STEPS` | number | 60 | 平均步数上限（昂贵边不固化） |

### 2.3 新模块 `src/pth/tasking/penetration-discovery.ts`

```ts
export interface PenetrationEdgeAggregate {
  parent: string; child: string;
  calls: number; okCalls: number; sumSteps: number;
  sumDurationMs: number; sumBudgetExceeded: number;
}
export interface PenetrationDiscoveryConfig {
  minCalls: number; minOkRatio: number; maxAvgSteps: number;
}
export interface PenetrationProposalContent {
  action: "register";
  /** 与 PenetrationEdgeSpec 同构（四段式三要素由证据数据生成） */
  spec: import("./penetration-skill.js").PenetrationEdgeSpec;
  evidence: {
    calls: number; okCalls: number; okRatio: number;
    avgSteps: number; avgDurationMs: number; budgetExceeded: number;
  };
}
```

- `parseEdgeAggregate(content: unknown): PenetrationEdgeAggregate | null`（坏行跳过）；
- `evaluateEdge(agg, cfg): { ok: true; spec: PenetrationEdgeSpec; evidence } | { ok: false; reason }`：
  - parent/child 必须已注册（`knownRoleById`）且 `allowedDelegationTargets(parent).includes(child)`；
  - `calls >= minCalls`、`okCalls/calls >= minOkRatio`、`sumSteps/calls <= maxAvgSteps`；
  - 生成的 `spec`：
    - `inputContract`：`${parent} 提交的自包含任务描述（标题+正文）——与直投任务文本同构`
    - `outputContract`：`done.result 为父任务验收口径的产物；失败回流错误摘要`
    - `anchor`：`${parent}→${child} 稳定直投路径（${calls} 次 / 成功率 ${(okRatio*100).toFixed(0)}%）`
    - `whenToUse`：`${parent} 需要 ${child} 承接同型任务且无需任务池往返时`
    - `effect`：`跳过派发/认领/回流三段往返——平均耗时 ${Math.round(avgDurationMs)}ms`
    - `path: [parent, child]`
- `discoverPenetrationProposals(deps): Promise<{ created: string[]; skipped: Array<{parent,child,reason}> }>`：
  - deps：`queryReadOnly(sql)`（读聚合行/现有 skill/现有 draft 提案）、`memory.write`（落提案，
    PgMemoryStore.write 形状）、`config`（阈值读取）可选注入；
  - SQL：
    1. `SELECT content FROM memory_entries WHERE kind='penetration-edge'`；
    2. `SELECT id FROM memory_entries WHERE id LIKE 'skill:penetrate:%'`——已存在条目（含 draft/archived）
       一律跳过该 child；
    3. `SELECT content FROM memory_entries WHERE kind='penetration-proposal' AND status='draft'`——
       同 parent+child 已有 draft 提案则跳过（防重复巡检重复提案）；
  - 提案条目：`id = pp-<uuid>`、`kind = penetration-proposal`、`status = draft`、
    `anchors = ["penetration", parent, child]`、`content = JSON.stringify(proposalContent)`、
    `meta = { parent, child, stage: "proposed", ts }`。
- 治理函数（与 tool-proposal 同构，本车道直接照抄状态机语义）：
  - `approvePenetrationProposal(store, proposalId)`：仅 draft 可批准 → status official +
    `meta.stage="approved"`；
  - `executeApprovedPenetrationProposal(store, proposalId)`：仅 official 可执行；
    - 解析 proposalContent → 用 `buildPenetrationSkillContent(spec)` 重建内容 →
      `validatePenetrationSkillRegistration(content)`（组织权机器校验，执行期重验）→
      `buildPenetrationSkillEntry(content, { status: "official" })` → `store.write(entry, {force:true})`；
    - 已存在 official `skill:penetrate:<child>` → 拒绝（注册幂等防覆盖；修订不在本批）；
    - 更新提案 `meta.stage="executed"`。

### 2.4 调度接线

- `system-triggers.ts`：`SYSTEM_ACTION` 增 `penetrationDiscovery: "penetration.discovery"`；
  `SystemTriggerDeps` 增可选
  `penetrationDiscovery?: { enabled: boolean; intervalMs: number; discover: () => Promise<unknown> }`；
  enabled 时注册 schedule trigger `penetration-discovery`（everySec = intervalMs/1000）+ 原生 action
  （action 处理器调 `deps.penetrationDiscovery.discover()`，返回 `{created}` 由 handler 直接回传）。
- `assembly.ts`：用 `createPenetrationDiscoveryService`（实现可放 discovery.ts 或独立小服务，
  但**主进程装配**：queryReadOnly = `dataWorld.queryReadOnly`、memory = `dataWorld.memory`、
  log = assemblyLogger）装配 deps；`PTH_PENETRATION_DISCOVERY_INTERVAL_MS` 决定周期。

### 2.5 批准面

- `pth-gateway-facade.approveMemoryAdmin`：新增 `proposal?.kind === "penetration-proposal"` 分支：
  `approvePenetrationProposal` → 失败返回；`executeApprovedPenetrationProposal` → 返回。
- 现有 `POST /api/v1/kernel/memory-admin/approve` 路由复用，不加新路由。

### 2.6 B1 验收

- 纯函数测试：`test/pth-tasking/penetration-discovery.test.ts`——parse 容错/门槛（calls 不足、
  成功率不足、平均步数超限、组织权拒绝、已存在 skill/已有 draft 提案去重）/提案生成三要素与证据；
- 治理链测试：fake store 全链 approve+execute → `skill:penetrate:<child>` official 且
  `parsePenetrationSkillContent` 可读、重复 execute 拒绝；
- `system-triggers.test.ts` 增 `penetration-discovery` 注册断言（enabled 分支 + action 类型）；
- 全量 vitest + lint 绿。

---

## 3. A4 护栏 JIT（护栏本身当优化对象）

### 3.1 目标

N14 已落：护栏观测（`obs.guards`/scorecard.guards）+ 调节角色（controller:rule）+ SOP
（skill:opt-rule）。A4 补上**优化循环的自动段**：窗口热点检测护栏误杀 →
`guard-config` 建议（draft）→ 监督批准（`/optimizer/apply`）→ 热调 `PTH_GUARD_*` →
复测窗口对比 → 劣化自动回滚（deopt 同款）。护栏的护栏 = 审批面：**永不走
auto-reversible 自动应用**。

### 3.2 热点规则（`optimizer-hotspots.ts`）

- `HotspotHit` 增可选字段：
  ```ts
  guard?: { guard: string; limitKey: string; scale: number };
  ```
- `OptimizerSuggestion`（optimizer-loop.ts）`kind` 联合增 `"guard"`；内容对象增可选
  `guard`（与 HotspotHit 同形）。
- 新规则 `guard-kill-spike`（保守单规则——v1 只这一条）：
  - 窗口聚合 scorecard.guards：每护栏 `hits/guide/soft/hard`；
  - `kills = soft + hard`；
  - 触发条件（全部满足）：
    1. 任一护栏 `hard >= 3`，或 `(soft + hard) >= 5 且 hits > 0 且 kills/hits > 0.5`；
    2. 该护栏属于**软处置/负结果族**（可放宽白名单，见下）——hard 护栏不自动建议放宽；
    3. 窗口内 `kills` 最多的护栏为建议对象。
  - 建议：`limitKey` 取白名单映射，`scale = 1.5`（放宽 50%——保守系数）；
  - `path: "guard"`、`target: guard-config:<guardId>`、`section: "阈值"`、
    `metric: { hits, guide, soft, hard, killRatio, tasks }`。
- 可放宽白名单（导出 `GUARD_TUNABLE_DEFS`，guardrails.ts）：
  ```ts
  {
    "negative-loop": { limitKey: "PTH_GUARD_NEGATIVE_LIMIT", default: 15, mode: "soft" },
    "repeat-action": { limitKey: "PTH_GUARD_REPEAT_LIMIT", default: 5, mode: "soft" },
  }
  ```
  （empty-done/empty-reply/unknown-tool 是 hard 契约护栏——只许人工调，不自动建议。）
- `renderSuggestion` 对 path `"guard"` 产出文本：
  `建议参数: <limitKey> ×1.5（当前值由批准时配置中心解析）`。

### 3.3 批准应用（`optimizer-apply.ts`）

- `isReversibleSuggestion` 扩展：`target.startsWith("guard-config:")` 为可逆（参数热调 +
  回滚可逆）。
- 函数签名增可选 `runtimeConfig?: { get(key): string | undefined; set(key, value): void }`
  （缺省 import perf-params 的 `config()`；测试注入 fake）。
- guard 分支（target `guard-config:<id>`）：
  1. 从 suggestion content 读 `guard`（限白名单存在）；缺/非法 → 拒绝；
  2. 当前值 `cur = Number(runtimeConfig.get(limitKey))`；非法/NaN → 用白名单 default；
  3. `next = max(cur + 1, ceil(cur * scale))`，上限 `ceil(cur * 5)`；`next <= cur` → 拒绝
     （已在顶——无需放宽）；
  4. `runtimeConfig.set(limitKey, String(next))`；
  5. 建议 meta 记 `guardBaseline: { limitKey, from: String(cur), to: String(next), values: { [limitKey]: String(cur) } }`；
  6. 基线：读全局聚合（rollup），存 `{ taskCount, avgGuardKills, avgGuardHits }`
     （聚合键见 §3.4）；基线读取失败 → 拒绝应用（护栏是安全面，无基线不热调——fail-closed）；
  7. 不派发独立复测任务（无单一角色）；`verifyAfterWindow: true`；
  8. status official + `appliedAt` + `target`。
- 其它 target 走现逻辑不动。

### 3.4 聚合与 deopt（`optimizer-loop.ts`）

- `collect` 的角色聚合增量追加（flat 键）：
  ```ts
  sumGuardHits: Σ sc.guards.hits 值,
  sumGuardSoft: Σ sc.guards.soft 值,
  sumGuardHard: Σ sc.guards.hard 值,
  sumGuardKills: sumGuardSoft + sumGuardHard,
  ```
- `rollupAggregateRows` 追加滚动 `sumGuardHits/sumGuardSoft/sumGuardHard/sumGuardKills`。
- `checkDeopt` guard 分支：
  - 读全局聚合（target 无单一角色——与 capability-index 同通道）；
  - 证据：`avgKills = sumGuardKills/taskCount`、`avgHits = sumGuardHits/taskCount`；
  - 劣化判定（任一）：
    - `avgKills > baseline.avgGuardKills * 1.5 + 0.001`；
    - `avgHits < baseline.avgGuardHits * 0.5`（护栏被调废——命中面消失）；
  - 未劣化 → `verifiedAt`；劣化 → 回滚：
    - `runtimeConfig.set(k, baseline.values[k])`（注入 fake 或 perf-params config()）；
    - 建议 meta `rolledBack: true, rollbackReason, rolledBackAt`；
    - 落 `task-insight`（type=guard-deopt）记录。
  - `checkDeopt` 需要 runtimeConfig——构造参数或 deps 增可选 `runtimeConfig`（缺省 perf-params）。

### 3.5 A4 验收

- `optimizer-hotspots.test.ts`（已有）增 guard-kill-spike 触发/不触发/hard 护栏不触发/白名单；
- `optimizer-apply.test.ts`（已有）增：guard 建议批准 → 参数按 1.5 调、meta guardBaseline、
  official；无基线拒绝；hard 护栏/非法 scale 拒绝；
- `optimizer-loop.test.ts`（已有）增 deopt 回滚：劣化 → 参数恢复 + rolledBack；未劣化 → verified；
- 全量 vitest + lint 绿。

---

## 4. 通用约束

- SDK import 硬约束与全部现有门禁不变；`npx tsc --noEmit`、`npx vitest run`、`npm run lint` 全绿；
- 各车道在自己的 worktree + 车道分支提交（`.worktrees/b1|b2|a4`，分支
  `lane/b1-penetration-discovery` / `lane/b2-penetration-budget` / `lane/a4-guard-jit`）；
- README 徽章/测试总数只在合并回 main 时更新；
- 概念同步：车道完成时只在自己的 lane 备注里记录概念，合并者统一归并
  `docs/pth/concepts.md`（0.16.3 行、N12 二期行、N14 行、parallel-lanes 车道池行）。
- 合并者顺序合并 B2 → B1 → A4，每次合并前跑全量。
