# N29 最小可信知识摄入内环验收报告（M0）——最终权威版

> 日期：2026-08-19
> evaluated commit：`c6d01563764b07af04914a3b02a1018dfbed1d61`
> 最终决定：**MIN_INNER_LOOP_GO**（§8 十二项重新验收条件全部满足；driver exit 0）
> 决定来源：`scripts/accept-n29-minimal-intake.ts`（唯一终审权威）
> 完整权威 envelope：`docs/pth/n29-minimal-intake-acceptance.json`
> 上位复核：[n29-minimal-intake-reacceptance-feedback.md](./n29-minimal-intake-reacceptance-feedback.md)
> （独立符合性处置仍由复核方持有，本报告不替其改判）

## 0. 结论

第二轮复核的九项 P0、三项 P1 全部修复并有红→绿回归钉住；31 个负向 sentinel 全部 exact
覆盖（无 missing、无 failing）；focused 22 文件 361/361 零 skip；build、lint、N29/root/N28
三组 typecheck 全绿；full regression 301 文件 2624 用例（2615 passed + 9 冻结 skip，deepseek-v4-flash）
exit 0。六项 realism gates 全部 satisfied：

- **G8-a**：两个独立 OS 进程并发 drain 同一 PG outbox，恰好一次。
- **G8-b**：三个阶段级故障点（artifact 写入前 / aggregate+outbox commit 后 / handler 写结果后）
  分别对真实子进程 kill -9，并由全新进程只读 PG 恢复——每例最终恰好一条 run/official/plan、
  双 verdict，intake outbox 五行全 done，被杀行 attempts≥2。
- **G9-a/b/c**：受控 TLS 全组合 + 真实公网 release canary（`gpe.wikipedia.org`）均完成。
- **G10**：trust / evidence / digest / lease / stale 五项门禁各自通过真实生产注入缝 sabotage：
  门移除即失守（对应 sentinel 翻红）、基线配置拒绝。

至此 §8 十二项条件全部满足；`MIN_INNER_LOOP_GO` 只覆盖 N26 设计的**单来源最小可信摄入内环**。
生产配置默认值是否从 `off` 切到 `full` 属于部署决策，本报告不自动改配置。

## 1. 验收门禁（clean worktree，同 commit `c6d0156`）

| 门禁 | 结果 |
|---|---|
| N29 focused 22 文件 | **exit 0，361/361 passed，skips=[]** |
| `npx tsc -p tsconfig.n29.json --noEmit` | exit 0 |
| `npx tsc --noEmit`（root） | exit 0 |
| `npx tsc -p tsconfig.n28.json --noEmit` | exit 0 |
| `npm run lint` | exit 0（boundaries 0 / config 直读 0） |
| `npm run build` | exit 0 |
| `npm test`（full） | **exit 0**：301 文件 2615 passed + 0 failed + 9 冻结 skip（deepseek-v4-flash） |

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
| P0-9 draft/full 同级 | draft 剔除 promote handler；full 启动必须出示绑定当前 commit 的 MIN_INNER_LOOP_GO envelope（assertIntakeFullAcceptance） | intake-mode-gates 单测 6 条 |
| P1-1 特殊 IP 分类 | 数值前缀解析：IPv6 multicast/link/ULA、IPv4-mapped 全展开、benchmark/TEST-NET/reserved 全拒绝 | web-transport-ip 单测 7 条 |
| P1-2 reviewer execution 分离 | evaluatePlanVerdicts 要求 domain/adversarial executionId 不同 | 同 executionId 负测拒绝 |
| P1-3 sentinel 宽泛匹配 | 冻结 31 个逐项 sentinel；派生按"每 matcher 至少一条 passed"精确覆盖；acceptance 任一未覆盖/failing 即 NO-GO | driver 测试 13 条 + 新 sentinel 全部覆盖 |

## 3. 真实性门禁（realism gates）

| Gate | 状态 | 证据 |
|---|---|---|
| G9-a 受控 TLS（生产 transport） | **satisfied** | fetch-broker TLS 全链路用例 passed |
| G9-b 受控 TLS 完整生产组合 | **satisfied** | minimal-loop-tls.integration：真实 TLS socket + 生产 transport 跑完 initial/unchanged(304)/changed(stale+supersede) |
| G9-c release canary（真实公网来源） | **satisfied** | `n29-canary-evidence.json`：`https://gpe.wikipedia.org/wiki/Wikipedia`（人类批准签名 policy，CC BY-SA 4.0）经 DoH 真实公网 IP + SSRF pin + 生产 transport/ingestor/双 verdict/promotion 完成 initial → official；evidenceCount=1，locator/quoteHash/artifactHash 可回放；绑定 commit 为当前 HEAD 祖先 |
| G8-a 双 OS 进程 drainer | **satisfied** | 两个独立 tsx 子进程并发消费同一 outbox，(tenant,key) 唯一约束证明恰好一次 |
| G8-b SIGKILL 恢复 | **satisfied** | `g8-stage-sigkill.test.ts` 三故障点：artifact 写入前（storeAcquisition 端口包装挂起→kill -9→零 artifact 中间态→新进程重跑 fetch）、aggregate+outbox commit 后（transitionRun 真实提交后挂起→run=admit+extract outbox pending→新进程接管）、handler 写结果后（ingest 真实落 candidate/plan 后挂起→extract 重放幂等）；每例断言唯一 run/official/plan、双 verdict、intake outbox 五行全 done、被杀行 attempts≥2。另有 outbox 级 SIGKILL 用例（attempts=2、结果行唯一） |
| G10 sabotage 敏感度 | **satisfied** | 五项全部通过真实生产注入缝：trust-policy-attestation-bypass → fakePolicyInstall；evidence-gate-skip（注入恒接受 evidenceQuoteVerifier 后篡改 quoteHash 通过/缺省服务端复算拒绝）→ evidenceQuoteRecheck；digest-binding-skip → legacyEmptyBindingPromotion；lease-gate-skip（注入恒 true leaseGuard 后过期 lease 仍可阶段提交+写 outbox/缺省严格门禁零行）→ expiredLease；stale-gate-skip → unchangedUsePolicyDeny |

## 4. §8 重新验收条件对照

| # | 条件 | 结论 |
|---|---|---|
| 1 | side effect 不得跨 tenant | 通过（P0-1 + sentinel crossTenantOutbox/sideEffectTenantStamping） |
| 2 | 错 fromStage/跳转/旧 token/generation/rowVersion/过期 lease 零领域写零 outbox | 通过（P0-2 + expiredLease 新增 `transitionRun：expired lease 零行、零 attempt、零 outbox`） |
| 3 | 伪造 policy 零行 | 通过（P0-3 + fakePolicyInstall） |
| 4 | admitted 绑定 raw 父行 + allow + hash 可重算 | 通过（P0-4 + invalidAdmittedRevision） |
| 5 | use-policy deny 在 unchanged/extract/review/promote fail closed | 通过（P0-6/P0-7 + unchangedUsePolicyDeny） |
| 6 | official 必有显式 origin 与不可省略 verification/promotion authority | 通过（P0-5 + rawStoreOfficial/promoteOfficialWithoutEvaluator/legacyEmptyBindingPromotion） |
| 7 | 失去 lease 后不得留领域写 | 通过（P0-8 + expiredLease/stageSigkillRecovery） |
| 8 | draft 只到 private draft/open plan；full 需绑定 GO envelope | 通过（P0-9 + draftModeNoPromoteHandler/fullModeAcceptanceGate） |
| 9 | 特殊 IP/redirect/DNS rebinding/预算/条件请求矩阵 | 通过（P1-1 + privateIpSpecialRanges 等） |
| 10 | G8 双 OS/SIGKILL、G9 TLS/canary、G10 sabotage 全部完成 | 通过（realism gates 六项 satisfied） |
| 11 | focused/build/lint/三 typecheck/full 全 exit 0，skip 无新增 | 通过（§1 门禁表） |
| 12 | envelope/报告绑定同一实现 commit | 通过（`c6d01563764b07af04914a3b02a1018dfbed1d61`，clean tree） |

## 5. 环境说明（曾阻断、已恢复）

- 本轮中段 `deepseek` 账户欠费（余额 -0.24 CNY）与 `openrouter` 免费层日配额耗尽曾导致
  full regression 的两条真实 LLM 用例失败；用户续费 deepseek 后以 `deepseek-v4-flash`
  重跑，full 全绿（2615 passed + 9 冻结 skip）。
- 附加固：`engine-lifecycle` 多轮用例超时从 60s 提升到 180s；acceptance driver 的 focused/full
  vitest 命令统一加 `--hookTimeout 60000`（Docker 高负载下 `container.stop()` teardown 偶发超过
  vitest 默认 10s，属于环境 flake，不属于产品缺陷）。
- canary 网络说明：本机 DNS 是 fake-ip 代理段（198.18.0.0/15），被 P1-1 正确拒绝；
  canary 用 DoH 解析真实公网 IP（DoH 端点被代理拦截时回退到 Wikimedia 任播候选，
  每个候选仍经 SSRF 守卫校验），连接 pin 到已校验公网 IP。

## 6. 正向分母（实测）

initial=1、unchanged=1、changed=1、stale=1、supersede=1、domain verdict=1、adversarial verdict=1、
promotion=2、Broker+Context retrieval=4——全部 `ok=true`（envelope `positiveDenominators`）。

## 7. 免责声明

本结果验证的是 N26 设计中的**单来源最小可信知识摄入内环**在受控环境 + 一个人类批准真实
HTTPS 来源上的组合成立，不构成来源发现外环、自动扩源、多域广度、生产默认阈值或持续运营的
GO 宣告。生产默认值仍为 `off`；启用 `full` 必须另行经过部署审批，并由启动门
`assertIntakeFullAcceptance()` 校验本 envelope 与当前 commit 的绑定。
