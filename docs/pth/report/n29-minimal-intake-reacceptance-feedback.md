# N29 最小可信知识摄入内环再次验收反馈报告（M0）

> - 日期：2026-08-19
> - 复验对象：`main@c2b12775a0cf047e0916bd4254167623ca894eb5`
> - 取证基线工作树：clean（本报告落盘前）
> - 上位设计：[N26 自主知识摄入设计](../design/n26-autonomous-knowledge-intake-design.md)
> - 实施计划：[N29 最小可信知识摄入内环反馈与实施计划](../plan/n29-minimal-knowledge-intake-loop-feedback-plan.md)
> - 既有自动报告：[N29 最小可信摄入内环验收报告](./n29-minimal-intake-report.md)
> - 既有 envelope：[n29-minimal-intake-acceptance.json](../n29-minimal-intake-acceptance.json)

## 1. 结论

**独立复验结论：NOT ACCEPTED / NO-GO。**

本轮实现已经打通初次摄入、不变重爬、变化重爬、双重核验、晋升、stale/supersedes 与
Broker/KnowledgeContext 消费的正向路径；聚焦套件、build、lint 与三组 typecheck 也全部通过。

但独立 PostgreSQL 对抗探针复现了五类能够写入错误持久状态的反例：

1. tenant-a 的 Task 和 IntakeRun 可以向 tenant-b 的 outbox 写事件；
2. fetch 阶段可以伪报 `fromStage=promote`，直接迁移到 `complete`；
3. 无效签名与伪造 digest 的 Trust Policy 可以被仓库写成“已验证”镜像；
4. `usePolicyDecision=deny`、错误 hash、缺少 raw→admitted 关联的 revision 仍可存成 `admitted`；
5. 原始 `PgMemoryStore` 仍可绕过 Promotion Service 直接产出 official knowledge。

此外，当前 use-policy 可被 unchanged 路径绕过，晋升时用 `byteLength=0` 复核来源策略，
fetch/extract/review/promote 的领域副作用发生在最终 Run CAS 之前，`draft` 与 `full` 又装配相同完整链路。

因此，现状只能证明“happy path 可运行”，不能证明“最小可信内环成立”。不得启用
`PTH_KNOWLEDGE_INTAKE_MODE=draft|full`；生产安全值保持 `off`。

## 2. 权威状态与新鲜证据

### 2.1 当前与历史 envelope 必须分开

仓库内既有报告和 envelope 绑定的是 `8198a6c52606f18a314fc3e7cdfd523a333b59ea`，决定为
`EVALUATION-INCOMPLETE`。当前 HEAD 是 `c2b12775...`；`8198a6c..c2b1277` 只有文档与验收产物变化，
没有实现代码变化，但旧报告中“没有观察到内环反例”的结论已被本轮运行时反例推翻。

本轮在当前 HEAD fresh 执行 acceptance driver，机械决定为 **NO-GO**。该次 full regression 与另一个
误启动的 driver 并发，出现进程级 side-effect drainer/unhandled rejection，故本报告不把这次 full
非零退出单独判为产品缺陷；即使完全排除该结果，下述可重复 PostgreSQL 反例仍足以独立给出 NO-GO。

### 2.2 新鲜门禁结果

| 门禁 | 结果 | 证据边界 |
|---|---|---|
| N29 focused | **15 files，250/250 passed，0 skip，exit 0** | 证明现有正向路径和已写负测通过，不覆盖下述旁路 |
| 安全/晋升 focused | **5 files，135/135 passed，0 skip，exit 0** | fetch、ingestor、verdict、promotion、memory-store 既有用例通过 |
| `npm run build` | **exit 0** | 当前实现可构建 |
| `npm run lint` | **exit 0** | tsc、PTH boundaries、PTH config 通过 |
| N29/root/N28 typecheck | **exit 0 / 0 / 0** | 三组静态检查通过 |
| N29 evaluator | **PASS** | 现有指标自洽，但 sentinel 未覆盖本轮对抗输入 |
| 当前 acceptance driver | **NO-GO** | full 进程非零 + G8/G9/G10 未完成；本报告另有独立 P0 反证 |

这些绿色结果可以保留，但不能抵消领域不变量被实际绕过。

### 2.3 独立 PostgreSQL 对抗探针

本轮使用临时 PostgreSQL 16 容器、生产 schema 和生产 repository/store 实现执行只读代码审查配套的
运行时探针；探针文件位于临时目录，执行后删除，未修改仓库。实际输出：

```json
{
  "taskCommit": { "committed": true },
  "crossTenantOutbox": [
    { "key": "cross-intake", "tenant_id": "tenant-b" },
    { "key": "cross-task", "tenant_id": "tenant-b" }
  ],
  "fakePolicyInstalled": {
    "approval_signature": "definitely-not-valid"
  },
  "wrongFromStageTransition": {
    "stage": "complete",
    "status": "queued"
  },
  "invalidAdmittedRevision": {
    "disposition": "admitted",
    "useDecision": "deny",
    "normalizedTextHash": "not-a-hash"
  },
  "rawStoreOfficial": {
    "status": "official",
    "kind": "task-insight"
  }
}
```

探针 exit 0 表示这些错误状态均被当前生产实现接受，而不是预期拒绝异常。

## 3. P0 验收阻断

### P0-1：side effect 的 tenant 未绑定聚合 tenant

[pg-task-repository.ts](../../../src/pth/tasking/adapters/pg-task-repository.ts) `:65-76` 直接使用
`TaskCommitSideEffect.tenantId`；它没有与已通过 Task CAS 的 tenant 对账。

[knowledge-intake-pg.ts](../../../packages/pth-kernel-storage/src/knowledge-intake-pg.ts) `:695-701` 同样接受
`IntakeSideEffect.tenantId`，而冻结合同已经写明“跨 tenant 入队不允许”。

因此，Task/Run 本身的 tenant-scoped CAS 成功，并不能阻止同一事务向另一个 tenant 写 outbox。
现有 `crossTenant` sentinel 只覆盖 claim/read/aggregate CAS，没有覆盖 side-effect tenant。

**关闭条件：** side effect 的 tenant 必须由服务端聚合上下文盖章；若输入仍保留 tenant 字段，任何不相等值
必须在事务写入前 fail closed，并以 Task 与 IntakeRun 两条真实 PG 回归钉住。

### P0-2：Run CAS 忽略 `fromStage`

[knowledge-intake-pg.ts](../../../packages/pth-kernel-storage/src/knowledge-intake-pg.ts) `:632-670` 的 UPDATE 校验
tenant、lease token、generation、rowVersion、status 和 expiry，但 SQL 没有 `stage = input.fromStage`，
也没有合法状态迁移矩阵。

本轮在真实当前阶段为 `fetch` 时传入 `fromStage=promote, toStage=complete`，迁移仍成功。
这会允许错误 handler、旧 payload 或编排缺陷跨过 admission、extract、verify 与 promote。

**关闭条件：** SQL CAS 必须比较当前 stage；`fromStage→toStage/status` 使用服务端固定矩阵，调用方不能声明
任意跳转。每条非法边、同 stage 的 domain→adversarial 特例和终态重放都要有真实 PG 测试。

### P0-3：Trust Policy 的“已验证”边界可结构伪造

[knowledge-intake-pg.ts](../../../packages/pth-kernel-storage/src/knowledge-intake-pg.ts) `:354-395` 只验证 manifest
字段与 digest 非空，然后持久化 `VerifiedTrustPolicy`。TypeScript 的结构接口不是运行时 attestation；任意内部
调用者都能构造同形对象，绕过 [trust-policy.ts](../../../src/pth/execution/knowledge-intake/trust-policy.ts)
中的 Ed25519 验证。

本轮使用无效 signature 和伪造 digest 调用公开 repository 方法，策略镜像写入成功。

**关闭条件：** policy 安装必须只有一个运行时可验证入口。可选择：

- repository 接受 raw manifest，并在写事务前调用注入的 verifier；或
- verifier 返回不可由普通对象构造的 opaque attestation，repository 在运行时验证其签发者/摘要。

仅靠类型名 `VerifiedTrustPolicy`、注释或调用约定不构成信任边界。

### P0-4：Repository 没有守住 SourceRevision / Artifact 不变量

[knowledge-intake-pg.ts](../../../packages/pth-kernel-storage/src/knowledge-intake-pg.ts) `:711-760` 对 admitted 只检查
`usePolicyDecision` 是否存在，没有检查：

- decision 必须为 `allow`；
- admitted 必须从同 tenant/subscription 的 raw-quarantine revision 派生；
- `rawHash === sha256(rawBytes)`；
- `normalizedTextHash === sha256(normalizedText)`；
- decision 的 policy/rule/tenant/space 与 Subscription 一致。

本轮用 `decision=deny`、错误 raw/normalized hash、无 `derivedFromRevisionId` 的输入，仍写入 admitted revision。

**关闭条件：** 上述不变量必须在 repository/同事务数据库约束层再次验证，不能只依赖 service happy path。
所有 repository 公共写口都必须按“被错误内部调用者直接调用”进行对抗测试。

### P0-5：official knowledge 仍有多个绕过入口

[memory-store-pg.ts](../../../packages/pth-memory/src/memory-store-pg.ts) `:143-145` 只对
`domain-fact/domain-method` 应用 official authority；`task-insight` 等 knowledge kinds 可直接 `write(status=official)`。

同文件 `:391-479` 的 `promoteOfficial()` 把 evaluator 设为可选；未提供 `evaluate/evaluateAsync` 时仍会写
official，并且 tenant facade 在 `:955-961` 继续公开该原语。

此外，[knowledge-verdicts.ts](../../../src/pth/execution/knowledge-verdicts.ts) `:286-297,488-509`
只对被识别为 intake-bound 的 candidate 强制非空 evidence/digest。legacy/non-intake candidate 仍可用空
`sourceBindingsDigest` 和空 evidence 晋升。

**关闭条件：**

1. 所有 knowledge official 写入只能经过不可省略 evaluator 的 Promotion Service；
2. raw store/facade 不再公开无门禁晋升；
3. 内部推理知识若无需外部 SourceRevision，也必须使用显式 `origin=internal` 的独立 verification contract，
   不能以空 digest 兼容路径表示可信。

### P0-6：unchanged 分支在 use-policy deny 之前返回成功

[service.ts](../../../src/pth/execution/knowledge-intake/service.ts) `:698-714` 先计算 admission verdict，随后只要
`previous.rawHash === envelope.rawHash` 就进入 unchanged；`:716-773` 会保存 revision、重排 Subscription、
完成 Run。真正的 `mayStoreAdmittedRevision` deny 检查直到 `:804-809` 才执行。

因此，策略过期、撤权或 use 条件收紧后，只要内容 hash 未变，就可以返回 `unchanged-complete` 并继续保留旧
authoritative knowledge。这违反“人类当前策略是唯一信任源”。

**关闭条件：** unchanged/reuse 也必须先通过当前 use-policy；deny 时应保留可审计 quarantine/acquisition，
将依赖 official 撤出或按策略明确冻结，绝不能把 deny 解释为 unchanged success。

### P0-7：晋升时的当前策略复核使用虚假 byteLength，策略轮换语义未冻结

[knowledge-ingestor.ts](../../../src/pth/execution/knowledge-intake/knowledge-ingestor.ts) `:496-520` 调用当前
`authorizeUse()` 时固定传 `byteLength: 0`，所以策略即使收紧为 `maxBytes=1`，一个 1024-byte artifact 也可能
通过晋升复核。

同一段只检查“当前 decision digest 等于当前 manifest digest”，没有说明当前 policy id/version/digest 与
candidate/SourceRevision 已绑定策略不同时应当重新准入、重新抽取还是直接拒绝。新的人类策略重新授权旧
artifact 可能是合法业务语义，但当前代码在没有显式迁移决定和审计绑定的情况下静默接受，合同尚未冻结。

**关闭条件：** PromotionSourceGuard 必须从 immutable artifact/revision 重算真实 byte length、content type、
license 与 URI/redirect；策略轮换必须给出显式 re-admit/re-extract/rebind 或拒绝语义，并持久化新的
policy id/version/digest 决定，不能在旧 candidate 上静默换绑。

### P0-8：领域副作用发生在最终 Run CAS 之前

当前 service 的各阶段先写领域状态，再调用 `transitionRun()`：

- fetch：先写 raw/admitted revision、可能标记旧 official stale，再在
  [service.ts](../../../src/pth/execution/knowledge-intake/service.ts) `:854-871` 提交 Run；
- extract：先写 candidate、VerificationPlan、dependency，再在 `:934-950` 提交；
- review：先写 verdict，再在 `:1028-1088` 提交；
- promote：先晋升 official、写 dependency/supersedes、重排 Subscription，再在 `:1170-1183` 提交。

unchanged 分支还忽略 `transitionRun()` 的返回值。lease 过期或被新 worker 抢占后，旧 worker 因此仍可能留下
revision、candidate、verdict、official 或 Subscription 更新，而 Run CAS 返回 null。

**关闭条件：** 每个阶段必须把“聚合状态变更 + Run CAS + 下一阶段 outbox”纳入同一事务边界；若跨 store
无法同事务，则先取得带 generation/token 的 durable stage-commit capability，所有领域写均以该 capability
做 CAS/幂等并能由恢复器判定唯一胜者。不能只让 outbox 与 Run CAS 原子，而把领域写留在事务外。

### P0-9：`draft` 与 `full` 没有形成不同安全级别

[schema.ts](../../../packages/pth-config/src/schema.ts) `:109` 定义 draft=仅私有草稿、full=完整内环且 GO 前不得启用；
但 [batch-process.ts](../../../src/pth/bootstrap/batch-process.ts) `:535-582` 对 draft/full 注册相同的 fetch、extract、
domain review、adversarial review、promote handlers。

[config-center.ts](../../../packages/pth-config/src/config-center.ts) `:180-188` 只做枚举校验，没有读取或校验绑定当前
commit 的 `MIN_INNER_LOOP_GO` envelope。设置 `full` 在配置层不会被阻止。

**关闭条件：** draft 最多运行到 private draft + open plan；promote handler 必须不注册。full 必须由启动时
验签的 acceptance attestation 显式解锁，并校验 evaluated commit/config contract，而不是只靠运维约定。

## 4. P1 高优先级问题

### P1-1：特殊 IP/IPv6 分类仍有 SSRF 缺口

[web-transport.ts](../../../src/pth/impls/kernels/web-transport.ts) `:101-120` 没有拒绝部分特殊地址。
本轮纯函数探针结果：

```json
{
  "ff02::1": false,
  "0:0:0:0:0:ffff:127.0.0.1": false,
  "198.18.0.1": false,
  "192.0.2.1": false
}
```

`false` 表示被当前函数视为公网。`resolvePublicAddresses()` 在 `:157-165` 会接受它们，默认 transport 随后
在 `:177-205` pin 到该地址。至少应覆盖 IPv6 multicast/link scope、所有 IPv4-mapped 展开形式、benchmark、
documentation、reserved 与 future-use 范围，并使用标准化 IP 解析而不是前缀正则拼补。

### P1-2：reviewer 只分离 principal，没有分离 execution

[knowledge-promotion.ts](../../../src/pth/execution/knowledge-promotion.ts) `:293-321` 创建的 checks 会分离
eligible principals；[knowledge-verdicts.ts](../../../src/pth/execution/knowledge-verdicts.ts) `:373-445` 也能
阻止 producer 自审并要求 domain/adversarial principal 不同，但判据没有要求两次 review 的 `executionId`
不同。若验收合同坚持“不同 principal/execution”，则同一执行实例可以代表两个 principal 完成双重核验。

需要把 execution separation 纳入 plan/check contract 和最终 `evaluatePlanVerdicts()`，并添加同 execution、
不同 principal 的负测。

### P1-3：现有 acceptance sentinel 会漏掉具体旁路

[eval-n29-minimal-intake.ts](../../../scripts/eval/eval-n29-minimal-intake.ts) `:155-160,204-209` 的
cross-tenant/direct-official 观测主要依赖测试名和既有正向计数；
[accept-n29-minimal-intake.ts](../../../scripts/accept/accept-n29-minimal-intake.ts) `:156-168` 对一类 sentinel 只要求
至少一个 matcher passed，并不要求每个冻结旁路都有独立用例。

所以 `crossTenantIsolation=1` 与 `emptyEvidence=4` 可以保持绿色，同时 side-effect tenant、raw store official、
fake policy install、admitted deny 等未命名旁路实际存在。

重新验收前应冻结逐项 sentinel ID，并要求 exact denominator；删除/绕过相应门禁时，唯一对应 sentinel 必须翻红。

## 5. G0–G10 独立复核矩阵

| Gate | 既有自动证据 | 独立复核 | 说明 |
|---|---|---|---|
| **G0 旁路** | PASS | **FAIL** | raw store 与无 evaluator `promoteOfficial()` 可写 official；legacy 空 digest 仍兼容 |
| **G1 信任** | PASS | **FAIL** | 结构伪造的 VerifiedTrustPolicy 可安装；full 无 acceptance attestation 门 |
| **G2 调度/CAS** | PASS | **FAIL** | Run CAS 忽略 fromStage；side effect 可跨 tenant；领域写在 CAS 前 |
| **G3 获取/准入** | PASS | **FAIL** | repository 接受 admitted+deny/错误 hash；特殊 IP 分类不完整 |
| **G4 抽取** | PASS | **PARTIAL** | 生产 processor/evidence 重算正向链存在；candidate/plan 写入先于 Run CAS |
| **G5 晋升** | PASS | **FAIL** | byteLength=0、policy 轮换语义未冻结、raw promotion 与 legacy 空 evidence 旁路 |
| **G6 消费** | PASS | **PARTIAL** | Broker/Context 正向与 stale 不可见用例有效；上游 official 可信性未成立 |
| **G7 重爬** | PASS | **FAIL** | initial/unchanged/changed happy path 成立，但 use deny 可被 unchanged 绕过 |
| **G8 故障** | PARTIAL | **FAIL / 未完成** | 同进程竞争/lease recovery 有证据；跨阶段事务不原子，双 OS/SIGKILL 未执行 |
| **G9 真实性** | PARTIAL | **未完成** | 生产 TLS 只覆盖 fetch/admission；完整生产组合和 release canary 未执行 |
| **G10 敏感度** | 未执行 | **未完成** | 没有 trust/evidence/digest/lease/stale 逐项 sabotage harness |

任一 P0 已足以阻断 `MIN_INNER_LOOP_GO`；当前共有九项 P0。

## 6. 已确认可保留的成果

下列工作不需要推倒重来：

- 默认模式仍为 `off`；普通 worker 的 knowledge `memory.write` 会被用途策略强制为 draft；
- `recon-doc` 与 `memory-maintain` 模板已经改为 private draft；
- Ed25519 Trust Policy verifier、逐跳 HTTPS policy matcher、DNS pin、字节/超时限制已有可复用基础；
- Subscription、Run lease、Artifact、SourceRevision、Dependency 和 tenant-qualified outbox schema 已落地；
- due scanner、同进程双 scanner/drainer、lease expiry recovery 和 outbox claim token 已有正向证据；
- extractor processor、服务端 EvidenceReference/quoteHash 重算、VerificationPlan 与双 verdict 路径已接通；
- draft CAS→official→index outbox、initial/unchanged/changed recrawl 与 stale/supersedes 正向组合已通过；
- production Broker/KnowledgeContext 能消费 happy-path official，跨 tenant/space 与 stale 的既有负测通过；
- 15 文件 250 个聚焦用例、build、lint 和三组 typecheck 当前均通过。

这些成果说明最小内环的组件形状与正向数据流基本可行。剩余问题集中在权限边界、聚合不变量、跨阶段原子性
和验收观察器，而不是需要重新设计整个 N26。

## 7. 分层修复顺序

### 第一层：立即收口危险入口

1. 部署与运维保持 `PTH_KNOWLEDGE_INTAKE_MODE=off`；draft/full 暂时启动失败；
2. 删除/封闭 raw `write official` 与无 evaluator `promoteOfficial()`；
3. side-effect tenant 由聚合上下文盖章，并固化 Task/Run 两条跨租户回归；
4. Run CAS 增加 fromStage 与合法迁移矩阵；
5. Trust Policy 安装改为运行时不可伪造的 verifier→repository 单入口。

### 第二层：恢复来源与阶段不变量

1. repository 重算 artifact/raw/normalized hashes，强制 admitted→allow + raw parent + subscription/policy 绑定；
2. unchanged 在当前 use-policy allow 后才能完成；deny 必须触发明确撤权/冻结语义；
3. PromotionSourceGuard 使用真实 artifact byteLength，并为 policy 轮换实现显式 re-admit/rebind 或拒绝语义；
4. 所有阶段以 Run lease/generation/token 约束领域写，并把领域提交、Run CAS、outbox 合为一个可恢复事务；
5. domain/adversarial 增加 execution separation。

### 第三层：修复网络与验收器

1. 使用标准化 IP 分类覆盖 IPv4/IPv6 特殊地址全集；
2. 为本报告五类 PG 反例各增加精确命名的红→绿回归；
3. evaluator 冻结逐旁路 exact denominator，不再靠测试名宽泛匹配；
4. 实现 G10 sabotage；
5. 完成双 OS drainer、三个 SIGKILL 恢复点、受控 TLS 完整生产组合和人类批准来源 canary。

## 8. 重新验收条件

重新验收必须在同一 clean evaluated commit 上同时满足：

1. Task/Run side effect 不能指定或写入不同 tenant；
2. Run 的错误 fromStage、非法跳转、旧 token/generation/rowVersion/expired lease 均零领域写、零 outbox；
3. 无效 signature/digest、service/worker principal、错 tenant/space 的 policy 安装为零行；
4. admitted revision 必须绑定同 tenant/subscription 的 raw revision，当前 use decision=allow，所有 hash 可重算；
5. use-policy deny/过期在 unchanged、extract、review、promote 四处均 fail closed；policy 轮换只有经过显式
   re-admit/rebind 决定才可继续；
6. 所有 official knowledge 都有显式 origin 与不可省略的 verification/promotion authority；
7. 任一阶段失去 lease 后不能留下 revision、candidate、plan、verdict、official、dependency 或 cursor 更新；
8. draft 只到 private draft/open plan；full 未绑定 `MIN_INNER_LOOP_GO` attestation 时启动失败；
9. 特殊 IPv4/IPv6、redirect、DNS rebinding、预算与条件请求矩阵全部通过；
10. G8 双 OS/SIGKILL、G9 完整 TLS/canary、G10 sabotage 全部完成；
11. focused、build、lint、N29/root/N28 typecheck、full regression 全部 exit 0，skip manifest 无新增；
12. 新 acceptance envelope 和报告绑定包含实现、合同、driver 与修复回归的同一 commit。

在这些条件全部满足前：

- 既有 `EVALUATION-INCOMPLETE` 报告只保留为历史运行记录；
- 本报告的独立符合性处置保持 **NOT ACCEPTED / NO-GO**；
- `PTH_KNOWLEDGE_INTAKE_MODE` 必须保持 **off**；
- 不得进入来源发现外环、自动扩源、生产 canary 或 `MIN_INNER_LOOP_GO` 宣告。
