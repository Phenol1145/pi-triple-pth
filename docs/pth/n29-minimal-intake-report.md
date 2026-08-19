# N29 最小可信知识摄入内环验收报告（M0）——再次复核修复后权威版

> 日期：2026-08-19
> evaluated commit：`16abccb2ea2897873391e27cca9738d1bcbed9f6`
> 最终决定：**EVALUATION-INCOMPLETE**（全部机械门禁 exit 0；仅剩 G9-c canary（用户裁决本轮不做）
> 与 G8-b/G10 partial 三项 realism 原因；driver exit 2）
> 决定来源：`scripts/accept-n29-minimal-intake.ts`（唯一终审权威）
> 完整权威 envelope：`docs/pth/n29-minimal-intake-acceptance.json`
> 上位复核：[n29-minimal-intake-reacceptance-feedback.md](./n29-minimal-intake-reacceptance-feedback.md)（独立处置 **NOT ACCEPTED / NO-GO**，由复核方持有，本报告不替其改判）

## 0. 结论

第二轮复核的九项 P0 与三项 P1 **全部修复并有红→绿回归钉住**；29 个负向 sentinel 全部
exact 覆盖（无 missing、无 failing）；focused 21 文件 355/355 零 skip；build、lint、
N29/root/N28 三组 typecheck 全绿；**full regression 全绿**（300 文件 2609 passed + 9 冻结 skip，
环境 LLM 用例使用 deepseek-v4-flash 通过）；G8 双 OS 进程与 SIGKILL、G9 受控 TLS 全组合、
G10 sabotage 敏感度已执行取证。

未达到 `MIN_INNER_LOOP_GO` 的剩余原因只有三项 realism gate：G9-c 真实公网 canary（本轮用户
裁决不执行，需要 PTL Human Interface 真实签发流程）、G8-b 阶段级三故障点逐点 SIGKILL 未做
（outbox 级故障模型已取证）、G10 中 lease/evidence 两条不可注入门禁的 sabotage 未做
（敏感度由 L3 mutation 探针取证）。

`PTH_KNOWLEDGE_INTAKE_MODE` 生产安全值保持 **off**。

## 1. 验收门禁（clean worktree，同 commit `16abccb`）

| 门禁 | 结果 |
|---|---|
| N29 focused 21 文件 | **exit 0，355/355 passed，skips=[]** |
| `npx tsc -p tsconfig.n29.json --noEmit` | exit 0 |
| `npx tsc --noEmit`（root） | exit 0 |
| `npx tsc -p tsconfig.n28.json --noEmit` | exit 0 |
| `npm run lint` | exit 0（boundaries 0 / config 直读 0） |
| `npm run build` | exit 0 |
| `npm test`（full） | **exit 0**：300 文件 2609 passed + 0 failed + 9 冻结 skip（deepseek-v4-flash） |

## 2. 第二轮复核 P0/P1 修复对照

| 阻断项 | 修复 | 关键回归 |
|---|---|---|
| P0-1 跨 tenant side effect | Task/Run commit 的 outbox tenant 由 CAS 通过行服务端盖章；caller 自报不一致 fail closed | 3 条 PG 回归（task completed/retryable/rejected + run） |
| P0-2 Run CAS 忽略 fromStage | SQL 增加 `stage = $fromStage`；冻结 `RUN_STAGE_TRANSITIONS` 矩阵（含 fetch→complete、verify 自边） | 伪报 fromStage / 跳阶段 / 终态出边全部零行零 outbox |
| P0-3 policy 可结构伪造 | 运行时 attestation（Symbol brand + WeakMap 双校验）+ 注入 verifier 时仓库重新验签 | 7 条对抗用例（伪造签名/digest/拷贝/换 manifest/service 签名） |
| P0-4 revision/artifact 不变量 | 服务端重算 raw/normalized hash + byteLength；admitted 必须 allow + 同 tenant/subscription 的 raw 父行 + 策略绑定一致；DB CHECK + trigger 兜底 | 10 条零行回归 + 1 条正向 |
| P0-5 official 旁路 | gated kinds 扩到 task-insight/tool-function；promoteOfficial evaluator 必填；facade 移除 promoteOfficial；legacy 空 digest/evidence 一律拒绝；新增 internal-reasoning authority | raw store 直写/facade/无 evaluator/legacy 空绑定全部拒绝 |
| P0-6 unchanged 绕过 use-policy | unchanged 分支遇 verdict=deny 先撤权（stale）并 dead-letter | 集成负向：策略轮换后 unchanged 重爬 dead-letter + 依赖撤出 |
| P0-7 晋升复核 byteLength=0 | 从 artifact 元数据读真实 byteLength 复核当前策略 | maxBytes 收紧到 1 → 晋升拒绝（candidate 保持 draft） |
| P0-8 领域写在 Run CAS 前 | 各阶段 transitionRun 返回 null 一律抛 IntakeStageRetryableError（handler 重试、幂等重放），不再静默 skipped | CAS 失败路径由既有 CAS 回归 + 集成套件覆盖 |
| P0-9 draft/full 同级 | draft 剔除 promote handler（纯函数 selectIntakeStageHandlers）；full 启动必须出示绑定 commit 的 MIN_INNER_LOOP_GO envelope（assertIntakeFullAcceptance） | intake-mode-gates 单测 6 条 |
| P1-1 特殊 IP 分类 | 数值前缀解析：IPv6 multicast/link/ULA、IPv4-mapped 全展开、benchmark/TEST-NET/reserved 全拒绝 | web-transport-ip 单测 7 条 |
| P1-2 reviewer execution 分离 | evaluatePlanVerdicts 要求 domain/adversarial executionId 不同 | 同 executionId 负测拒绝 |
| P1-3 sentinel 宽泛匹配 | 冻结 29 个逐项 sentinel；派生按"每 matcher 至少一条 passed"精确覆盖（命中但全 failed 记未覆盖）；acceptance 任一未覆盖/failing 即 NO-GO | driver 测试 13 条更新 |

## 3. 真实性门禁（realism gates）

| Gate | 状态 | 证据 |
|---|---|---|
| G9-a 受控 TLS（生产 transport） | **satisfied** | fetch-broker TLS 全链路用例 passed |
| G9-b 受控 TLS 完整生产组合 | **satisfied** | minimal-loop-tls.integration：真实 TLS socket + 生产 transport 跑完 initial/unchanged(304)/changed(stale+supersede) |
| G9-c release canary（真实公网来源） | **not-executed** | 本轮用户裁决不做真实公网 canary（需 PTL Human Interface 真实签发流程） |
| G8-a 双 OS 进程 drainer | **satisfied** | 两个独立 tsx 子进程并发消费同一 outbox，(tenant,key) 唯一约束证明恰好一次 |
| G8-b SIGKILL 恢复 | **partial** | handler 进行中 kill -9 → lease 过期 → 新进程回收完成（attempts=2、结果行唯一）；三个 intake 阶段级故障点的逐点进程注入未执行，阶段不变量由 L1/L3 CAS + lease recovery 回归覆盖 |
| G10 sabotage 敏感度 | **partial** | trust/digest/stale 三条可注入门禁的 sabotage 敏感度已证明（门移除即失守、基线拒绝）；lease/evidence 为 SQL/纯代码门禁，敏感度由 L3 mutation 探针取证（临时移除 → 7 断言翻红 → 恢复） |

## 4. 环境说明（曾阻断、已恢复）

- 本轮中段 `deepseek` 账户欠费（余额 -0.24 CNY）与 `openrouter` 免费层日配额耗尽曾导致
  full regression 的两条真实 LLM 用例失败；用户续费 deepseek 后以 `deepseek-v4-flash`
  重跑，full 全绿（2609 passed + 9 冻结 skip）。
- 附加固：`engine-lifecycle` 多轮用例超时从 60s 提升到 180s（慢速 provider 下的 flake 加固）。

## 5. 正向分母（实测）

initial=1、unchanged=1、changed=1、stale=1、supersede=1、domain verdict=1、adversarial verdict=1、
promotion=2、Broker+Context retrieval=4——全部 `ok=true`（envelope `positiveDenominators`）。

## 6. 免责声明

This result validates the minimal single-source inner loop composition in a controlled environment;
it does not validate source expansion, multi-domain breadth, autoscaling, or production default
thresholds. The release canary against a real human-approved public HTTPS source was not executed
this round by user decision; the decision remains EVALUATION-INCOMPLETE until G9-c, G8-b stage-level
fault injection, and the two non-injectable G10 sabotage gates are executed.
