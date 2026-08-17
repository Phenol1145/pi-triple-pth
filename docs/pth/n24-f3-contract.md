# N24-F3 契约：Domain envelope 继承 + 审核/晋升主体绑定（AB-04 / AB-05）

## 1. Delegate 继承 Domain（AB-05）

- `TaskDispatchContext` 增：
  `domains?: readonly DomainId[]`、`domainBinding?: DomainBinding`；
- `bootstrap/task-loop.ts` `stampTaskDispatchContext`：
  用 `readWorkItemDomains(payload)` / `readWorkItemDomainBinding(payload, domains)` 填充
  （复用 task-work-item-reader——不再从 payload 手工解析）；
- `TaskControlService.delegate`：
  - `TaskDelegateInput` 增可选 `domains?: string[]`（显式子集收窄）；
  - 提供 domains 时必须满足 `new Set(input.domains) ⊆ caller.domains`，否则 fail-fast；
  - 缺省完整继承 `domains: caller.domains ?? []`、`domainBinding: caller.domainBinding`；
  - 子 payload 写入这两个键（服务端盖章，body 不可自报——input.domains 仅用于子集校验，
    最终 payload 由 caller 封套派生）；
- `PgTaskStore` delegate 通道不重跑 resolver（既有），payload 中 domains 由 claim reader 读取；
- 测试：root publish（domains A,B）→ claim → delegate → 子 payload domains=[A,B]+binding；
  显式子集 [A] 成功；越权子集 [C] 拒绝；legacy 无 domains 父任务 → 子 domains=[]。

## 2. Verdict / Promotion 主体与 RBAC（AB-04）

### 2.1 KnowledgeVerdict 扩展

```ts
export interface KnowledgeVerdict {
  kind: "domain" | "adversarial";
  verdict: "pass" | "reject";
  reviewerRole: string;
  note: string;
  at: number;
  principalId?: string;        // 签发主体（不可伪造——HTTP 取自 auth，能力面取自 worker 身份）
  executionId?: string;        // 执行上下文（task/run id，HTTP 可缺省）
  candidateRevision?: number;  // 审核时 entry.meta.version
  domainId?: string;           // domain 类 verdict 必填；adversarial 不填
  evidence?: string[];         // 可选非空字符串数组
}
```

- `validateKnowledgeVerdict`：optional 字段形状校验；domain verdict 的 `domainId` 非空；
- `canPromote`：pass domain verdict 必须有 `principalId` 与 `domainId`；adversarial 必须有
  `principalId`；任一 pass principalId === provenance.producerRole → 拒；
  domain/adversarial principal 相同 → 拒；candidateRevision 必须等于 entry.meta.version。

### 2.2 recordKnowledgeVerdict

- opts 增 `principalId?` / `executionId?` / `domainId?`；
- 自动补 `candidateRevision = entry.meta?.version`（调用方不可覆盖）；
- 写入前用 `validateKnowledgeVerdict`。

### 2.3 promoteKnowledgeEntry

- opts 增 `principalId?`；
- promotion meta 增 `principalId`；幂等重放同 F1 语义；
- 测试补 principalId 判定的全部拒绝路径。

### 2.4 HTTP RBAC

- `POST /knowledge/verify`：仅 `auth.role === "platform-admin"`（否则 403）；
  - kind=domain 必须带 `domainId`；kind=adversarial 不接收 body.domainId；
  - principalId=`auth.principalId`；executionId 可选 body；
  - tenantId=`auth.tenantId` 传入 facade/service；
- `POST /knowledge/promote`：仅 platform-admin（否则 403）；tenantId 透传；
  promoterRole=`memory-keeper`（HTTP 监督通道代表 memory-keeper 执行）；
- facade `verifyKnowledge/promoteKnowledge` 签名增加 tenantId/principalId 等参数并透传。

### 2.5 worker 能力面

- controller:adversarial `knowledge.review`：principalId=`worker:controller:adversarial`；
  domainId 不填（adversarial）；candidateRevision 由 service 自动补；
- memory-keeper `knowledge.promote`：principalId=`worker:memory-keeper`。

## 3. 测试与约束

- `test/pth-tasking/task-control-service*`：delegate 继承/子集/越权；
- `test/pth-execution/knowledge-promotion.test.ts`：扩展 verdict 字段与 canPromote 拒因；
- `test/pth-gateway/kernel-routes.test.ts`：tenant-agent verify/promote 403、platform-admin
  domain 必须 domainId、tenant 透传；
- 全量 vitest + lint 绿；worktree `.worktrees/f3` / `lane/f3-domain-rbac`；
- 不改 concepts/parallel-lanes/TODO/README；一条 commit，返回偏差。
