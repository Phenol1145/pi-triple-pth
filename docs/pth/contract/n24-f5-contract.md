# N24-F5 契约：durable side-effect outbox + candidate lineage + audit 绑定（6.1 / 6.2 / 6.7）

## 1. Durable side-effect outbox（6.1）

- `src/pth/kernel/storage/schema.ts` 增表：
  ```sql
  CREATE TABLE IF NOT EXISTS side_effect_outbox (
    id BIGSERIAL PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    kind TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now(),
    done_at TIMESTAMPTZ
  );
  ```
- 新 `src/pth/tasking/side-effect-outbox.ts`：
  - `PgSideEffectOutbox`（pg.Pool）：`enqueue({key,tenantId,kind,payload})`（幂等 key）、
    `claimPending(limit)`、`complete(key)`、`markFailed(key, attempts)`；
  - `createSideEffectDrainer({ outbox, handlers, logger, tickMs })`：轮询 pending →
    按 kind 调 handler（handler 抛错 → markFailed+attempts，attempts≥3 置 failed 留审计）→
    complete；返回 start/stop（unref timer）。
- `TaskLoopDeps` 增可选 `sideEffectOutbox?`；task-loop 每轮 claim 前调用
  `drainSideEffects()`（或注入 drainer 回调——实现时选一处，需说明）；
- `createRefineObserver` 改造：不再依赖 BoundedBackgroundQueue 丢弃；
  - 依赖增 `enqueue: (key, kind, payload) => Promise<void>`；
  - post-commit observer 同步 `await enqueue` 后再结束（写入失败不能静默——notifyObservers
    记 observer 错误日志）；
  - key=`refine:<tenantId>:<taskId>:<leaseGeneration>`（幂等）；
  - payload 含 taskId/roleId/traceEvents/domains/outcome 摘要/artifactRefs（见 §2）。
- 生产装配：batch-process 创建 PgSideEffectOutbox + drainer，handler 调
  `refiner.refine`（refine 输入从 payload 重建；payload 不存大 trace——只存
  `traceEvents` 截断 60 条或省略并回退 snapshot）。
- 测试：fake outbox——enqueue 幂等、claim/complete/markFailed、handler 重试；
  进程“重启”场景用同一 fake 表重放 pending。

## 2. Candidate lineage（6.2）

- `RefineInput` 增（已有部分字段）：`domains?: readonly DomainId[]`、
  `domainBinding?: DomainBinding`、`outcome?: { status: string; result?: unknown }`、
  `artifactRefs?: string[]`。
- 调用方：
  - refine-observer：从 `event.work.domains/domainBinding`、`event.outcome` 取；
  - task-loop legacy：从 task payload（`readWorkItemDomains/readWorkItemDomainBinding`）
    与执行结果取（能拿到什么传什么）。
- `Refiner.scopedMeta` 增：`domains`（数组）、`domainBinding`（对象或省略）、
  `outcomeStatus`（string）、`artifactRefs`（数组）；provenance.sourceRefs 优先
  artifactRefs（已有语义保留）。
- 测试：refiner 单测断言这些 meta 字段随输入出现。

## 3. Audit observer 方法绑定（6.7）

- `bootstrap/task-loop.ts`：改为捕获 audit store 对象
  `const audit = ...?.audit;`，observer 写口 `write: (ev) => audit.write(ev)`（不先解引用
  方法）；同样检查 transcripts 等其它依赖是否用 `(obj)=>obj.method` 安全调用。
- 测试：真实/fake audit store 计数——committed 后 audit 事件落库且 `this` 绑定生效
  （可复用现有 task-loop 测试）。

## 4. 测试与约束

- 全量 vitest + lint 绿；worktree `.worktrees/f5` / `lane/f5-outbox-lineage-audit`；
- 只改本契约文件域（schema/core/tasking/bootstrap/refiner 及测试）；
- 一条 commit；返回偏差与 full test 数字。
