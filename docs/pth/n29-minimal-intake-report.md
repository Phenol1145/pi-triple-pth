# N29 最小可信知识摄入内环验收报告（M0）

> 日期：2026-08-19
> evaluated commit：`8198a6c52606f18a314fc3e7cdfd523a333b59ea`
> 最终决定：**EVALUATION-INCOMPLETE**（既不是 `MIN_INNER_LOOP_GO`，也不是 `NO-GO`）
> 决定来源：`scripts/accept-n29-minimal-intake.ts`（唯一终审权威，exit 2）
> 完整权威 envelope：`docs/pth/n29-minimal-intake-acceptance.json`
> 上位计划：[N29 最小可信知识摄入内环复验反馈与实施计划](./n29-minimal-knowledge-intake-loop-feedback-plan.md)

## 0. 结论

**EVALUATION-INCOMPLETE。** 七道门禁在同一 clean commit 上全部 exit 0；九项正向分母全部为
实测非零值；十五个负向 sentinel 全部由本次运行中**确实通过**的用例派生；full regression 的
skip manifest 等于既有冻结清单（sandbox-security 9）。

但计划 §2.3 第 8 项与 §2.4 的 **G9（真实性）**、**G8（故障）**、**G10（敏感度）** 未在本轮执行：

- 没有对真实公网 HTTPS 来源做 release canary（本环境无该来源的人类签名 Trust Policy，也无获批出网通道）；
- 最小内环组合测试仍替换 HTTP transport 与 `LlmFn` 两条外部缝，受控 TLS 只覆盖 fetch/admission 层；
- 双 OS 进程 drainer 与 SIGKILL 重启故障注入未执行（只有同进程双 drainer/双 scanner 与 lease 回收取证）；
- 未实现 sabotage 注入 harness，因此 sentinel 的敏感度未被证明。

按计划 §2.4 的判定规则（realism 不足时不得给 `MIN_INNER_LOOP_GO`）与 §5 Task 7 Step 4
（来源/网络不可用记 `EVALUATION-INCOMPLETE`），本报告**不得**被读作最小内环 GO，更不得
被读作 Autonomous Knowledge Intake GO。`PTH_KNOWLEDGE_INTAKE_MODE=full` 在 envelope 变为
`MIN_INNER_LOOP_GO` 之前不得启用（当前默认 `off`）。

同时，本轮**没有观察到内环反例**：所有已启动门禁均绿，未关闭项是**取证缺口**，不是已知缺陷。

## 1. 验收门禁（clean worktree，同 commit `8198a6c`）

| 门禁 | 命令 | 结果 |
|---|---|---|
| build | `npm run build` | exit 0（7s） |
| lint | `npm run lint` | exit 0（6s；boundaries 0 / config 直读 0） |
| N29 typecheck | `npx tsc -p tsconfig.n29.json --noEmit` | exit 0（3 scripts + 11 生产文件 + 7 聚焦测试） |
| root typecheck | `npx tsc --noEmit` | exit 0 |
| N28 typecheck | `npx tsc -p tsconfig.n28.json --noEmit` | exit 0（N28 门禁保持绿） |
| focused | `npx vitest run <15 files> --reporter=json` | exit 0；**250/250 passed，0 skip** |
| full regression | `npm test -- --reporter=json` | exit 0；295 files（294 passed / 1 skipped）、2559 tests（2550 passed / 9 skipped） |

full 的 skip manifest = `[{ "file": "test/pth-execution/sandbox-security.integration.test.ts", "tests": 9 }]`，
与既有冻结清单逐字节一致；无新增 skip。

focused 15 个文件：intake 六件套（trust-policy / knowledge-intake-pg / fetch-broker /
knowledge-ingestor / minimal-loop.integration / intake-processors）+ L1 前置修复与消费面
（pg-task-repository / side-effect-outbox / knowledge-promotion / knowledge-verdicts /
knowledge-broker / knowledge-context / templates / memory-policy）+ L7 driver 判据单测。

Trust Policy 绑定：`policy-n29-l6` v1，digest `g3tsitUoDggL1pgr21SRwdmS8MSX7g_y2a7NcvpCBv4`，
approvedBy `human-alice`（`kind=human`，issuer `ptl-human-interface`，Ed25519 detached signature）。

## 2. 正向分母（实测，不可真空）

分母不是常量：最小内环集成套件在**对应断言通过之后**才累加计数，并把台账写到 driver 指定的
临时文件；driver 校验台账的 `evaluatedCommit` 等于被评估 commit，任一缺失/NaN/零即 NO-GO。

| 分母 | 下限 | 实测 |
|---|---:|---:|
| initialIngestion（初次摄入产出 official） | 1 | 1 |
| unchangedRecrawl（不变重爬） | 1 | 1 |
| changedRecrawl（变化重爬） | 1 | 1 |
| staleWithdrawal（旧 official 撤出 authoritative） | 1 | 1 |
| supersede（新 official 明确 supersedes 旧条目） | 1 | 1 |
| domainVerdict | 1 | 1 |
| adversarialVerdict | 1 | 1 |
| promotion（两次晋升：V1 + superseding V2） | 2 | 2 |
| brokerContextRetrieval（生产 Broker + KnowledgeContext 命中） | 2 | 4 |

台账同时冻结了可回放证据：subscription id、5 条 revision（2 raw-quarantine / 2 admitted /
1 unchanged 及各自 rawHash）、2 条 official（entryId、contentHash、sourceRevisionId、
artifactHash、quoteHash、locator `[start,end)`、supersedes）、2 条 verdict 行（domain +
adversarial，两个不同 principal）。

集成套件自身的组合层负向计数：`subscribeOutOfScopeDenied=1`、`dueScannerIdempotent=1`、
`unchangedNoNewCandidate=1`、`staleNotAuthoritative=1`、`policyRevocationStale=1`、
`crossTenantIsolation=1`、`runCasRejected=4`。

## 3. 负向 / 故障 sentinel（全部由本次 passed 用例派生）

| Sentinel | 通过用例数 | 主要取证位置 |
|---|---:|---|
| wrongGeneration | 4 | pg-task-repository（wrong generation 零 side effect）· knowledge-intake-pg（transitionRun CAS）· minimal-loop（组合层 run CAS） |
| expiredLease | 4 | pg-task-repository（expired / NULL lease 不能提交）· knowledge-intake-pg（lease 过期回收） |
| duplicateHandler | 4 | side-effect-outbox（双 drainer 不重复领取、stale handler 不能回滚状态、错 token 无效）· knowledge-intake-pg（双 scanner） |
| leaseRecovery | 3 | side-effect-outbox（processing lease 回收）· pg-task-repository（recoverExpired）· knowledge-intake-pg |
| crossTenant | 10 | knowledge-intake-pg（策略镜像/artifact/dependency/CAS 全面跨租户零可见）· knowledge-ingestor · minimal-loop · pg-task-repository |
| policyExpiryOrRevocation | 5 | trust-policy（过期/撤销）· fetch-broker（fetch 后过期/轮换/撤销 → use 拒绝）· minimal-loop（撤销传播 stale） |
| redirectScopeEscape | 4 | fetch-broker（策略外 origin / escape / 越出 pathPrefix / redirect 到非 TLS） |
| unknownLicense | 3 | trust-policy（未知 license/sourceType/contentType/domain）· fetch-broker（未批准 content type、domain 不匹配） |
| emptyEvidence | 4 | knowledge-ingestor（无 evidence claim、空 evidence plan）· knowledge-promotion · knowledge-verdicts |
| staleVerdictOrDependency | 3 | knowledge-ingestor（依赖 stale 后拒绝晋升）· knowledge-verdicts / knowledge-promotion（stale candidateRevision） |
| sameKeyDifferentPayloadConflict | 3 | side-effect-outbox（同 tenant/key 不同 payload / 不同 kind 显式 conflict）· knowledge-intake-pg（conflict 回滚整个 transition） |
| differentTenantSameKey | 1 | side-effect-outbox（不同 tenant 可复用同一 key） |
| quarantineBeforeUse | 3 | fetch-broker（use 前只能 quarantine）· knowledge-ingestor（拒绝 quarantined revision）· knowledge-intake-pg（revision 正文不可 UPDATE） |
| directOfficialBypass | 5 | memory-policy（knowledge 层强制 draft，service/platform-admin 无法绕过）· templates（recon-doc / memory-maintain 固定 draft、无 official 直写） |
| producerSelfReview | 3 | intake-processors（四主体必须互不相同、reviewer 资格校验）· knowledge-verdicts（producer 不得自审） |

## 4. §2.3 完成定义逐项对账

| # | 要求 | 结论 | 证据 |
|---:|---|---|---|
| 1 | 初次摄入产生一条 official | **满足** | initialIngestion=1；run `stage=complete/status=completed`；official 内容 = 服务端重算 quote |
| 2 | official 可回放到 exact revision / artifact hash / representation / locator / quote hash | **满足** | 台账 officials[]：sourceRevisionId + artifactHash + `representation=normalized-text` + locator + quoteHash |
| 3 | 不变重爬不产生新 candidate / promotion | **满足** | unchangedRecrawl=1；条件请求 304；entries/plans/LLM 调用数不变 |
| 4 | 变化重爬先撤旧 authoritative，再产生 superseding official | **满足** | staleWithdrawal=1、supersede=1；旧条目 `status=stale`、`meta.supersededBy`；Broker get 旧 id → 404 |
| 5 | 进程/handler 中断后可由 PG 状态与 outbox 恢复 | **未闭合** | 进程内证据齐全（lease 过期回收、outbox 重放/CAS、终态 run 不可复活），但真实 SIGKILL 子进程与双 OS 进程未执行（G8） |
| 6 | 错误 generation / 过期 lease / 跨 tenant / 策略过期 / 越权 redirect / 空 evidence 零 side effect | **满足** | §3 前十个 sentinel，全部为 passed 用例 |
| 7 | full regression、lint、真实 PG 组合套件全部通过 | **满足** | §1 门禁表 |
| 8 | 受控 TLS 来源通过生产组合测试 + 真实 HTTPS release canary | **未满足** | 受控 TLS 只覆盖 fetch/admission 层（G9-a partial）；G9-b/G9-c 未执行 |

第 5、8 项未闭合 → 结论只能是 `EVALUATION-INCOMPLETE`。

## 5. §2.4 验收矩阵对账

| Gate | 状态 | 说明 |
|---|---|---|
| G0 旁路 | PASS | worker/service/platform-admin/模板均不能写 knowledge official；只有 Promotion Service 可晋升 |
| G1 信任 | PASS | PTL human proof 装策略；service 签名/伪造主体/错 tenant/错 space/deny 优先全部拒绝 |
| G2 调度 | PASS | 双 scanner 同一 due window 只建一个 run；未过期 lease + generation + rowVersion 才能迁移 |
| G3 获取 | PASS（transport 为受控替身） | 逐跳 HTTPS/DNS/IP/字节/时间预算、raw bytes/hash/headers/redirect 可回放、use 前保持 quarantine |
| G4 抽取 | PASS | 生产 processor 经 lease/inputHash/result schema；locator 与 quoteHash 由服务端重算，不信 LLM 自报文本 |
| G5 晋升 | PASS | 四主体职责分离；空 digest/空 evidence/撤销 policy/非 admitted revision/stale 依赖一律拒绝 |
| G6 消费 | PASS | 生产 Broker + KnowledgeContextProvider 命中同一 official 与 evidence；stale/跨 tenant 命中 0 |
| G7 重爬 | PASS | initial / unchanged / changed 三路径；V1 stale 后默认不可见但 history/asOf 可读；V2 明确 supersedes V1 |
| G8 故障 | **未满足** | CAS/outbox 原子性与 lease 回收已证；双 OS 进程 + 三个 SIGKILL 故障点未执行 |
| G9 真实性 | **未满足** | 生产 transport 的真实 TLS 只在 fetch/admission 层跑通；全链路 TLS 组合与真实 HTTPS canary 未执行 |
| G10 敏感度 | **未执行** | 无 sabotage harness，sentinel 敏感度未证 |

## 6. 与计划的偏离

| # | 偏离 | 原因与影响 |
|---:|---|---|
| D1 | 对 `src/types/pg.d.ts` 与三个 PG 测试文件做**纯类型**修正（`query<R>` 行类型参数、`StartedPostgreSqlContainer`、SQL 行形状、一处被覆盖的重复属性、一处类型 import 归位） | 计划要求 `tsconfig.n29.json` 覆盖全部 focused tests，而这些文件此前从未被任何 tsconfig 覆盖，带 40 条类型错误。修正只影响类型，不改任何运行时断言（full regression 前后同为 294 files 绿） |
| D2 | driver 额外执行 `npm run build` 与 `npx tsc -p tsconfig.n28.json --noEmit`；并把 `npx tsc --noEmit` 排在 build/lint 之后 | root project 的 paths 指向 `dist/*.d.ts`（仓库既有约定），必须先产出声明；N28 门禁纳入以防回归 |
| D3 | 计划 §5 Task 7 Step 2 要求的 process restart（SIGKILL）、dual drainer（双 OS 进程）与 §2.4 G10 sabotage harness 未实现 | 本 lane 只做验收机具、不夹带实现；driver 把它们显式记为 realism gate `not-executed`，从而**强制**结论降为 `EVALUATION-INCOMPLETE`，而不是用等价 mock 充当满足 |
| D4 | focused 面从"内环聚焦套件"扩展到 15 个文件（含 L1 tasking 与消费面） | 使负向 sentinel 从**真实 passed 用例**派生，而不是由 driver 自报常量 |
| D5 | 未采用 N28 的"两次独立 evaluator + byte-identical"形态 | N29 的 provisional 判据是"聚焦套件实测台账 + 报告派生 sentinel"；重复跑 focused 只会重复启动 Testcontainers 而不增加信息量。driver 只跑一次 focused，并用 `evaluatedCommit` 绑定台账防止复用旧证据 |
| D6 | canary 未执行 | 计划 §5 Task 7 Step 4 明确：网络或来源不可用记 `EVALUATION-INCOMPLETE`，不得放宽 matcher 或改用 direct-store 让它通过 |

## 7. 未关闭风险

1. **真实来源行为未验证**（G9-c）：真实公网 HTTPS 的 DNS/TLS/redirect 链、许可与 content-type
   真实分布、字节/时间预算的真实边界均未跑过；本轮所有网络行为来自受控替身或本地 TLS server。
2. **真实崩溃恢复未验证**（G8）：artifact 写入前、aggregate+outbox commit 后/handler 前、
   handler 写结果后/outbox complete 前三个故障点没有真实 SIGKILL 证据；双 OS 进程竞争未验证。
3. **sentinel 敏感度未证**（G10）：无 sabotage 注入，无法证明"移除任一门禁至少翻红一个 sentinel"。
4. **LLM 缝为受控替身**：抽取质量、真实模型的 schema 违规与越界引用面未覆盖（服务端重算
   evidence 是防线，但不等于抽取质量验证）。
5. **广度未验证**：单 tenant / 单 space / 单 domain / 单 subscription / 一个 bounded HTML
   connector；来源发现外环、多源冲突、跨版本比较、十域扩展、自动分片与扩缩容均未进入本轮。
6. **运行开关**：`PTH_KNOWLEDGE_INTAKE_MODE` 默认 `off`；在 envelope 变为 `MIN_INNER_LOOP_GO`
   之前不得启用 `full`。

## 8. 复现

```bash
git checkout 8198a6c52606f18a314fc3e7cdfd523a333b59ea   # 必须 clean worktree
npx tsx scripts/accept-n29-minimal-intake.ts --output docs/pth/n29-minimal-intake-acceptance.json
# exit 0 = MIN_INNER_LOOP_GO / 1 = NO-GO / 2 = EVALUATION-INCOMPLETE（本轮为 2）

# 仅跑 provisional evaluator（最小内环集成测试 + 正向分母核对）
npx tsx scripts/eval-n29-minimal-intake.ts
```

## 9. envelope 摘要（完整 JSON 见 `docs/pth/n29-minimal-intake-acceptance.json`）

```json
{
  "schema": "n29-minimal-intake-acceptance/1",
  "evaluatedCommit": "8198a6c52606f18a314fc3e7cdfd523a333b59ea",
  "implementationTreeClean": true,
  "trustPolicy": { "policyId": "policy-n29-l6", "version": "1", "digest": "g3tsitUoDggL1pgr21SRwdmS8MSX7g_y2a7NcvpCBv4", "humanPrincipalId": "human-alice", "issuer": "ptl-human-interface" },
  "evaluator": { "decision": "PASS", "ledgerBoundToCommit": true },
  "focused": { "started": true, "exitCode": 0, "skipped": [], "totals": { "files": 15, "tests": 250, "passed": 250, "failed": 0, "skipped": 0 } },
  "fullRegression": { "started": true, "exitCode": 0, "skipped": [{ "file": "test/pth-execution/sandbox-security.integration.test.ts", "tests": 9 }] },
  "build": { "exitCode": 0 }, "lint": { "exitCode": 0 },
  "n29Typecheck": { "exitCode": 0 }, "rootTypecheck": { "exitCode": 0 }, "n28Typecheck": { "exitCode": 0 },
  "realismGates": [
    { "gate": "G9-a 受控 TLS 来源（生产 transport）", "status": "partial" },
    { "gate": "G9-b 受控 TLS 来源跑完整生产组合", "status": "not-executed" },
    { "gate": "G9-c release canary（真实 HTTPS 来源）", "status": "not-executed" },
    { "gate": "G8-a 双 OS 进程 drainer", "status": "not-executed" },
    { "gate": "G8-b SIGKILL 重启恢复", "status": "not-executed" },
    { "gate": "G10 敏感度（sabotage）", "status": "not-executed" }
  ],
  "decision": "EVALUATION-INCOMPLETE"
}
```

## 10. 免责声明

This result validates the minimal single-source trusted intake inner loop only (one
human-signed Trust Policy, one tenant/space/domain/subscription, one bounded HTTPS/HTML
connector, initial + unchanged + changed recrawl). It does not validate source
discovery/expansion, multi-source conflict resolution, multi-domain or ten-domain breadth,
automatic partitioning/rebalancing/autoscaling, external object storage or vector indexing,
browser-rendered or authenticated connectors, or real-LLM extraction quality.

本轮结论为 `EVALUATION-INCOMPLETE`：门禁与不变式证据充分，但真实性（受控 TLS 全链路、
真实 HTTPS canary）、真实崩溃恢复与敏感度三类取证缺口尚未关闭，因此不构成最小内环 GO。
