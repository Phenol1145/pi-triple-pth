# PTH worker 能力测试集（tester 角色）

> 功能测试：考察 worker 对自身上下文的管理能力 + memory 数据库使用能力。
> 用法：ptl hub job submit 提交（tags 带 test 路由到 tester）或直接 task 发布。

## T1 上下文管理（context 对象——ts 核内跨步骤保留）

```ts
// 1. 写入 context（跨步骤保留）
context.session = { startedAt: Date.now(), steps: 0 };
// 2. 累积步骤（模拟多步工作）
for (let i = 1; i <= 5; i++) { context.session.steps = i; context[`step_${i}`] = `data-${i}`; }
// 3. 读取验证
({ steps: context.session.steps, keys: Object.keys(context).length, retained: context.step_5 });
```

**考察**：context 持久性 / 键管理 / 多步累积。

## T2 上下文压缩（探索——要求压缩会发生什么）

```ts
// 大量写入 → 要求压缩（无内置压缩机制——观察 worker 如何应对）
for (let i = 0; i < 50; i++) context[`bulk_${i}`] = `payload-${i}`.repeat(100);
const before = Object.keys(context).length;
// "压缩"：手动策略——清空 bulk_*，保留摘要
for (const k of Object.keys(context)) if (k.startsWith("bulk_")) delete context[k];
context.summary = { compressed: true, originalKeys: before, remaining: Object.keys(context).length, note: "手动压缩（无内置机制——v1 观察点）" };
context.summary;
```

**考察**：context 无自动压缩时 worker 行为（手动清理/摘要/放弃）——为上下文压缩机制设计收集数据。

## T3 memory 写入与召回

```ts
// 写入（tester 自己的命名空间观察）
await memory.write({ kind: "test-observation", anchors: ["tester", "cap-test"], content: "观察-" + Date.now() });
// 查询
const rows = await memory.query("SELECT kind, count(*)::int AS n FROM memory_entries WHERE kind = 'test-observation' GROUP BY kind");
// 过滤召回（anchors）
const hit = await memory.query("SELECT content FROM memory_entries WHERE kind = 'test-observation' ORDER BY created_at DESC LIMIT 1");
({ rows, hit: hit.length });
```

**考察**：write/query/过滤/召回——memory 数据库使用能力。

## T4 memory 跨任务沉淀（上一任务写 → 下一任务读）

```ts
// 场景：T3 写入后，新任务读取（跨任务 memory 持久）
const rows = await memory.query("SELECT count(*)::int AS n FROM memory_entries WHERE kind = 'test-observation'");
({ persisted: rows[0]?.n });
```

**考察**：memory 持久性——跨任务共享。
