# 执行可靠性修复计划：F1 LLM 挂起停滞 / F2 孤儿 claim / F3 done 收敛困惑

> 状态：**修复计划（待评审）**
> 分支：`feat/pth-exec-unified`
> 依据：`docs/pth/report/coding-performance-baseline-2026-08-25.md`（F1–F3 实跑证据）
> 范围：F1/F2/F3 三项 + F4（grant TTL 匹配）顺带核查；F5（内核池容量）归 N34 Phase 1 独立池设计，F6 为任务模板提示项，均不在本计划。

---

## 0. 根因确认（2026-08-25 代码核查）

### F1：LLM 挂起 → agent loop 无限静默停滞

**实跑现象**：E1/E3 两任务 06:16 同时停步，日志零输出 >9 分钟；batch 进程存活（S 态）；任务级 3h 超时不会触发，单步无任何兜底。

代码核查发现三条可疑路径，**主次需 W0 仪器化确认**：

1. **`llm-fn.ts` directComplete 的 body 读取无保护**（高度可疑）：`fetch()` 本身有 AbortController（`opts.timeoutMs ?? 60s`），但 `clearTimeout` 在 fetch resolve 后立即执行——**随后的 `await res.text()` 不在任何超时覆盖下**。DeepSeek 连接若 headers 已回、body 流停滞（长推理输出 + 连接半开），此处无限挂起。与"两个并发任务同时冻结"吻合（同一上游连接池异常）。
2. **agent-loop 的 Promise.race 只包 `llm.complete()`**：若挂起点在 ts.run 工具执行内部（capability await），race 覆盖不到。ts.run 经 `runPtcProgram` 执行 worker 代码，**无单步执行超时**。
3. **无停滞可观测性**：循环内无"等待点 + 已等待时长"心跳日志，停滞时外部完全不可见（本次靠人工发现）。

### F2：平台重启不回收孤儿任务 claim

**根因明确且比预期干净**：租约机制已完整实现——`pg-task-repository.ts` 的 claim 生成 `lease_id + generation + lease_expires_at`（TTL 默认 10min），`recoverExpired()` 会清理过期 claimed 行并允许更高 generation 重新 claim。

**但 `recoverExpired` 全仓零调用**（grep 确认：除契约声明与实现外无调用方）——没有调度器周期调用，重启恢复路径（`recovery_start`）也只恢复会话、不触碰任务租约。孤儿 claim 因此永久滞留。

**配套缺口**：无心跳续约机制。任务执行超过 lease TTL（10min）时租约自然过期——若直接启用 recoverExpired，长任务会被重复认领（双 worker 并发执行同一任务）。本次评估 E1 单次执行 >10min，属于常态。因此 recoverExpired 的启用必须与心跳续约同批落地。

### F3：done 收敛困惑

**现象**：worker 反复在 ts.run 代码里 `return { done: true }` / `({ task: "E1" })` 代替调用 done 工具（E1 停滞前最后 4 步、治理任务 memory-keeper 均可见）；E1r/E3r 在任务文本显式提示"用 done 工具"后一轮收敛。

**根因**：TCE 代码面里所有能力都是 `await xxx.yyy(...)` 形态的函数调用，而 done 仅以"固定协议段 + tool schema"形式存在（`agent-tools.ts` L129/L143）。模型（尤其 reasoning 模型 deepseek-v4-flash）在代码上下文里过度泛化"一切皆 ts.run 内代码"，把任务结束也写成 return 值。**这是代码面与终止原语形态不一致导致的系统性歧义**，非单次提示可根治。

---

## 1. 修复方案（三波次，按依赖排序）

### W0：停滞可观测性（先行——为 F1 定因提供证据）

> 目标：任何 agent loop 停滞 60s 内日志可见、可定位等待点。

- W0-1 agent-loop 等待点心跳：每次 await（llm.complete / 工具执行）前后记录 `step=N waiting=<kind> elapsed=Ts`，挂起超过 `PTH_AGENT_STALL_LOG_MS`（默认 60s）打 warn 级 `agent-stall` 日志（含 taskId/role/等待点）。实现：把 `await x` 包为 `withWaitPoint(kind, promise)`（`.then` 旁路记录，不改时序语义）。
- W0-2 batch 进程级 watchdog 日志：每 30s 输出在飞任务清单（taskId、当前步、最近一步距今秒数）。空闲不输出（零噪音）。
- 验收：人工构造挂起（mock llm 永不 resolve）→ 60s 内出现 `agent-stall` warn 且指向正确等待点。

### W1：F1 超时闭环

- W1-1 修 `llm-fn.ts` body 读取缺口：AbortController 覆盖延长至 `res.text()` 完成（timer 移到全部读取之后），或 `res.text()` 独立 race 超时。补单测：mock fetch 返回永不完结的 body stream → 断言按 timeoutMs 抛错。
- W1-2 ts.run 单步执行超时：`runPtcProgram` 增加 `stepTimeoutMs`（默认 `PTH_AGENT_STEP_TIMEOUT_MS`，300s），vm 内 in-flight capability promise 统一 race；超时结果 = 工具失败回灌模型（"上一步超时，请换策略"），不终止任务。
- W1-3 核查 pi-ai SDK 路径是否另有 LLM 调用入口绕过 llm-fn（agent-engine/session-pool 的 system session）——若有，同标准补超时。
- 验收：W0 构造的挂起场景在 W1 后表现为"工具/LLM 失败回灌 + 循环继续"，任务最终 done 或失败，但**不再静默冻结**。

### W2：F2 孤儿 claim 回收（心跳 + 周期回收成对落地）

- W2-1 心跳续约：batch 执行中每 `leaseTtlMs/3`（≈200s）对持有任务发 `renewLease(taskId, leaseId, generation)`（repository 新增方法：`UPDATE tasks SET lease_expires_at = now()+ttl WHERE id=$1 AND lease_id=$2 AND lease_generation=$3 AND status='claimed'`——CAS 防误续）。执行结束（commit/fail/cancel）停止续约。
- W2-2 周期回收接线：task-dispatcher tick（已有 `PTH_BATCH_TICK_MS` 循环）每 tick 调用 `recoverExpired(now)`；batch-process 启动路径同样调用一次（重启即回收上代遗留）。回收产生 warn 日志 + 审计事件（`task.lease-expired`），被回收任务回 pending 可被重新认领。
- W2-3 保护窗：`recoverExpired` 只清 `lease_expires_at < now - graceMs`（grace 默认 60s，防时钟偏移误杀）。
- 验收：集成测试——claim 后不续约 → 过期+grace 后任务回 pending 且可被再认领；claim 后正常续约 → 不被回收；commit 后 recoverExpired 不再触碰该行。重启现网平台后，历史孤儿 claimed 行被自动回收（本次 E1/E3 僵尸为现成 fixture）。

### W3：F3 done 收敛（代码面原语一致化）

- W3-1 **首选**：ts.run vm 注入可调用 `done(result)` 全局函数（family=loop 的能力对象化）——调用即终止 agent loop 并提交结果，与"一切皆代码函数"的模型心智一致。tool schema 的 done 保留（非 PTC 路径仍可用）；`asAction` 投影统一为 `return await done(...)`。
- W3-2 兜底护栏：检测 ts.run 返回 `return {done:true}` / 注释含"提交 done"的伪终止模式 → guard 提示一次（"done 是函数调用：await done(result)"），不阻断。
- W3-3 prompt 协议段同步精简：固定段保留一行 done 说明，形态与函数签名一致。
- 验收：bench 基线任务组（E1r/E2/E3r/E4 同型）在**无任务文本提示**下 done 一次收敛率 ≥ 3/4；回归：非 PTC 模式（tool-call/asp）done 行为不变。

### W4（顺带小项）：F4 grant TTL 匹配核查

- 核查 execution grant TTL 与任务时长的关系（E4/E1r 任务中途 grant 过期）；若 TTL < PTH_AGENT_TIMEOUT_MS 量级，续约或对齐。仅限核查 + 参数/续约小改，不改授权模型。

---

## 2. 文件影响面（预估）

| 波次 | 主要文件 |
|---|---|
| W0 | `packages/pth-kernel-execution/src/execution/agent-loop.ts`、`agent-loop-registry-execution.ts`（等待点包装）、`src/pth/bootstrap/batch-process.ts`（watchdog） |
| W1 | `packages/pth-kernel-interpreter/src/interpreter/llm-fn.ts`、`packages/pth-kernel-interpreter/src/ptc/runner.ts`（step 超时）、`packages/pth-config/src/schema.ts`（新配置项注册） |
| W2 | `src/pth/tasking/adapters/pg-task-repository.ts`（renewLease）、`src/pth/tasking/task-dispatcher.ts`（周期 recoverExpired）、`src/pth/bootstrap/batch-process.ts`（启动回收 + 执行心跳）、`packages/pth-contracts/src/tasking-types.ts`（契约补 renewLease） |
| W3 | `packages/pth-kernel-execution/src/execution/agent-loop.ts`（done 全局注入与终止语义）、`packages/pth-kernel-interpreter/src/ptc/contract.ts`（asAction 统一）、`agent-tools.ts`（协议段） |
| W4 | grant 签发/校验处（execution/ 下，核查后定） |

测试伴随：W1 单测（llm-fn body 挂起）、W2 集成测试（PG 租约生命周期——testcontainers 已有先例）、W3 bench 同型任务复测。

## 3. 验收标准（整体验收 = 基线任务组复测）

1. 以 `coding-performance-baseline-2026-08-25.md` §1 同型 4 任务复测（**不附加 done 提示**）：全部完成、无人工干预、无僵尸 claimed。
2. 人为 kill 一个 batch 进程：其持有任务在 lease 过期 + grace 内自动回 pending 并被重新认领完成。
3. mock 挂起场景不再静默冻结，且 `agent-stall` 日志可定位等待点。
4. `npm run lint` + 全量 vitest 绿；新增配置项全部入 pth-config schema（strict 模式兼容）。

## 4. 回滚

- W2 心跳/回收：`PTH_TASK_LEASE_RECOVERY=off` 开关（默认 on；off 回退现状——recoverExpired 不被调用）。
- W3 done 全局函数：纯增量（tool schema 不动），回滚 = 移除 vm 注入点。
- W1/W0 均为加保护不改语义，回滚 = revert 单测覆盖的 commit。

## 5. 风险

| 风险 | 缓解 |
|---|---|
| 心跳续约 bug 导致租约永不释放 | renewLease 全 CAS 条件（lease_id+generation+status）；recoverExpired 仍兜底 |
| done 函数化改变收敛判定语义 | 终止仍走同一 commit 路径（delivery/lineage 盖章不变）；tool 形态保留双轨 |
| 单步超时误杀长编译（dev.build 大项目） | stepTimeoutMs 默认 300s 宽限；capability 可声明自身更长超时（如编译核已有 120s 编译超时） |
| W0 等待点日志量 | 仅在超过阈值时输出；正常路径零额外日志 |

## 6. 施工顺序建议

W0 → W2（F2 是正确性缺口，优先级最高）→ W1 → W3 → W4。每波次独立 commit、独立验收；W0+W2 可同批。
