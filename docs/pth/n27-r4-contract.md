# N27-R4 契约：true transactional outbox + claim lease/token/CAS + observer 可观测失败

> 对应复验报告 **P0-4、P0-5、P1-5**。
> 文件域：`src/pth/tasking/{task-dispatcher,task-outcome-observers,side-effect-outbox}.ts` +
> `src/pth/runner/observers/refine-observer.ts` + `src/pth/kernel/storage/schema.ts`。

## 1. 目标

1. task outcome commit 与 outbox enqueue 原子化（P0-4）：崩溃/失败窗口不再永久丢 candidate。
2. outbox claim 原子 `pending → processing`，带 processing token/lease；complete/fail 必须
   匹配 token 与 processing 状态；支持 lease 过期回收、availableAt/backoff、lastError、
   dead-letter（P0-5）。
3. observer fan-out 命名化 + durable failure 可查询；根修组合测试中的
   `observer failed: Cannot read properties of undefined (reading 'pool')`（P1-5）。

## 2. 阻塞项引用

**P0-4 原文要点：** 任务 CAS commit 完成后 dispatcher 才调用 observer
（`task-dispatcher.ts#L80-L85`）；refine observer 随后独立 enqueue
（`refine-observer.ts#L50-L69`）；enqueue 失败被 observer 隔离为日志
（`task-outcome-observers.ts#L23-L33`）。进程在 commit 后、enqueue 前崩溃，或数据库短暂失败
时，Candidate 永久缺失；snapshot 失败也直接 return 不入队（`refine-observer.ts#L41-L48`）。

**P0-4 关闭条件原文：**

> task outcome 与 outbox row 必须由同一个 PostgreSQL transaction/client 提交；或保存足够的
> durable outcome event，使 repair worker 可确定性补写，不能靠 post-commit callback。

**P0-5 原文要点：** `claimPending` 使用自动提交的单条 `SELECT ... FOR UPDATE SKIP LOCKED`
（`side-effect-outbox.ts#L60-L81`），查询返回事务已结束、行锁已释放；记录未原子改成 processing。
`complete/markFailed` 只按 key 更新，无 claim token、owner、lease deadline 或 status CAS
（`side-effect-outbox.ts#L84-L100`）。双 drainer 可重复处理同一行；stale handler 可把 complete
改回 pending。

**P0-5 关闭条件原文：**

> 原子 `pending → processing` claim，生成 claim token/lease；complete/fail 必须携带 token 且
> 匹配 processing；支持 lease 过期回收、availableAt/backoff、lastError 与 dead-letter。

**P1-5 原文要点：** 真实 batch 组合期间出现 `observer failed: Cannot read properties of
undefined (reading 'pool')`；需要给 observer 加名称/阶段上下文并让关键持久化 observer 失败进入
可查询的 durable failure，而不是只写 warning 后继续绿测。

**P1-5 关闭条件原文：**

> 需要给 observer 加名称/阶段上下文并让关键持久化 observer 失败进入可查询的 durable failure，
> 而不是只写 warning 后继续绿测。

## 3. 实施范围

| 文件 | 改动 |
|---|---|
| `src/pth/tasking/task-dispatcher.ts` | commit 路径改为可携带同事务 enqueue（或 durable outcome event），不再 commit 后独立调用 observer 完成持久化副作用 |
| `src/pth/tasking/side-effect-outbox.ts` | outbox 端口与实现：原子 claim（token/lease）、complete(key, token) CAS、markFailed(key, token, attempts, lastError, backoff)、lease 过期回收、dead-letter |
| `src/pth/tasking/task-outcome-observers.ts` | `notifyObservers` 接受带 name/stage 的 observer 元数据；失败写 durable failure（outbox 或 `observer_failures`），不再只 logger |
| `src/pth/runner/observers/refine-observer.ts` | refine 的持久化 enqueue 移入 commit 同事务；observer 本体只做同事务外的非关键通知；snapshot 失败不再静默 return（转为 durable failure 记录） |
| `src/pth/kernel/storage/schema.ts` | `side_effect_outbox` 增列：`processing_token`、`locked_until`、`available_at`、`last_error`、`owner`、`dead_letter`（或等价状态列）；status CHECK 增 `processing`/`dead-letter`；`observer_failures` 表（如采用） |
| 测试 | `test/pth-tasking/side-effect-outbox.test.ts` + 真实 PG 多连接并发探针 + 组合测试 |

## 4. 设计裁决要点

### 4.1 同事务 enqueue（P0-4）

- 首选方案：给 task committer 增加同事务扩展点（如 `commit(outcome, { enqueue?: [...] })`，
  或在 committer 内直接持有 PG client 并完成 `task CAS commit + side_effect_outbox INSERT`，
  同一事务 `COMMIT`）。enqueue 失败 → 整体 ROLLBACK → 任务回到可重试状态。
- 允许备选方案（实施者在 PR 说明理由）：不扩展 committer，改为在 commit 前同一 client 写
  durable outcome event 表，commit 后由 repair worker 确定性补写 outbox——但必须证明
  repair 可重放且不丢（有测试）。
- refine observer 的 enqueue 调用从 post-commit observer 中移除，改为随 commit 同事务；
  该 observer 自身退化为"同事务外的通知/观测"，不再承担唯一持久化路径。
- snapshot 失败：refine 需要 kernel snapshot，而 snapshot 在 commit 时同步可取——若失败，
  enqueue 一个不带 snapshot 的 refine payload（标记 `snapshotMissing: true`）并记录
  durable failure，而不是静默 return 丢候选。

### 4.2 原子 claim（P0-5）

- 新增列与状态机：`pending → processing → done | dead-letter`；`pending` 在
  `available_at <= now()` 才可被领取；`processing` 且 `locked_until < now()` 视为租约过期
  可被重新 claim（claim 时 `attempts+1`）。
- claim 必须单语句原子完成：CTE `WITH picked AS (SELECT id FROM side_effect_outbox WHERE
  (status='pending' AND available_at <= now()) OR (status='processing' AND locked_until < now())
  ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED) UPDATE ... SET status='processing',
  processing_token=$token, owner=$owner, locked_until=now()+$lease, attempts=attempts+1
  FROM picked WHERE ... RETURNING ...`。每行返回唯一 token。
- `complete(key, token)`：`UPDATE ... SET status='done', done_at=now() WHERE key=$1 AND
  status='processing' AND processing_token=$2 RETURNING id`；0 行 = conflict（stale handler
  不得把已 complete 行改回 pending）。
- `markFailed(key, token, attempts, lastError)`：同样 CAS；按 `attempts >= maxAttempts` 置
  `dead-letter`（或 `failed`），否则 `available_at = now() + backoff`、`last_error` 记录。
- 删除按 key 无 token 的 `complete/markFailed` 旧接口（或标记 deprecated 并全部改走新接口）。

### 4.3 observer 命名与 durable failure（P1-5）

- `TaskOutcomeObserver` 改为 `{ name, stage?, observe }` 或保持函数但 `notifyObservers`
  接受带 name 的包装；错误信息必须含 name/stage 与原始 message。
- 关键持久化 observer 的失败写入 `observer_failures`（或 outbox kind=`observer-failure`），
  可被查询与重放；非关键 observer 失败可降级但要区分告警。
- 根修 `reading 'pool'`：定位组合装配中哪个 observer 的依赖未注入（likely 某个 observer
  构造时 deps 缺 pool）。修复后全量组合测试必须零 `observer failed` 输出；测试中 grep 该
  字符串作断言。

## 5. 非目标

- 不改 refine 的 LLM 抽取逻辑本身；不改 promotion/verdict（R1/R3）。
- 不改 raw query（R2）、评测（R5）。
- 不把 side-effect outbox 换成外部消息队列（保持 PG）。

## 6. 验收标准

### 6.1 定向测试（真实 PG + 多连接并发探针）

- `side-effect-outbox.test.ts`：
  - `claim atomically marks pending as processing with token and lease`
  - `two concurrent drainers never claim the same row`
  - `complete with wrong token does nothing (CAS conflict)`
  - `stale handler cannot move completed row back to pending`
  - `markFailed with token applies backoff and dead-letter after threshold`
  - `expired processing lease is reclaimed by a later claim`
  - `enqueue and task commit are atomic: enqueue failure rolls back commit`
- `task-outcome-observers.test.ts` / 组合：
  - `observer failure is recorded as durable failure with observer name`
  - `full batch composition emits no 'observer failed' log line`

### 6.2 关闭条件对账表

| 关闭条件 | 证据 |
|---|---|
| task outcome 与 outbox row 同事务提交（或 durable outcome + repair） | `enqueue and task commit are atomic` |
| 原子 `pending → processing` claim + token/lease | 6.1 前两例 |
| complete/fail 携带 token 且匹配 processing | `complete with wrong token` + `stale handler ...` |
| lease 过期回收 / availableAt / backoff / lastError / dead-letter | 6.1 后三例 |
| observer 名称/阶段 + durable failure | 6.1 observer 两例 |

### 6.3 全量门槛

- `npx vitest run`（连接 compose PG/Redis）全绿且无 `observer failed` 输出；`npm run lint` 全绿。
- 一条 commit；返回改动文件、测试结果、并发探针输出、偏差说明。
