# 存储后端架构分析:单引擎 vs 分平面多引擎

> 日期:2026-08-14 · 类型:架构裁决前置分析 · 依据:全仓代码事实(探查于 A2 归并计划之后)
> 关联:[backlog-priority.md 附录 B](../backlog-priority.md)、concepts.md §8.2「双 storage 层归属待定」
> 结论先行:**保持分平面多引擎(PG 数据世界 + Redis 热面 + 文件产物)**;A2 归并的对象是**包与归属**,不是**引擎**。

## 0. 先把问题定义对——"单/多存储"有三层含义,别混

| 层 | 问题 | 现状 | 本分析范围 |
|---|---|---|---|
| 包归属 | 一个 storage 包还是两个目录 | 两个包(pth/storage vs kernel/storage) | A2 正文(附录 B) |
| **引擎选择** | 全部数据落一种引擎,还是按数据形态分引擎 | PG + Redis + 文件 + 内存四面 | **本分析** |
| 同概念双后端 | 同一概念写两个引擎 | 审计:Redis Stream 活跃 + PG audit_log 零消费(未接线) | A2 Phase 3(定责,非选边) |

本分析只谈第二层:引擎该不该归一。

## 1. 现状负载面盘点(引擎是按数据形态自然分工的)

### PG(数据世界——kernel/storage,8 文件)
| 数据 | 形态与访问模式 | 依赖的引擎特性 |
|---|---|---|
| tasks | 状态机 6 态 + 认领竞态(`SELECT … FOR UPDATE SKIP LOCKED` + 原子 UPDATE——task-store-pg.ts:105 起)+ 角色队列(assigned_role+status 索引)+ 聚合统计(obs.tasks GROUP BY) | **行锁/事务/组合索引**——SQL 原生 |
| memory_entries | anchors GIN 检索、kind 聚合、版本+幂等唯一键、status 治理、内容 LIKE、T7 归档闭环 | **JSONB GIN + 唯一约束 + 事务**——SQL 原生 |
| transcripts | JSONB 轨迹 + body::text ILIKE 全文检索(obs.search) | JSONB/全文——SQL 原生 |
| audit_log | 结构化事件(任务终态——本批接线后) | 持久查询——SQL 原生 |

### Redis(热面——会话/流/锁/注册表)
| 数据 | 形态与访问模式 | 依赖的引擎特性 |
|---|---|---|
| session:*(会话平面) | 顺序追加 entry(seq)+ meta 计数 + 快照 + zset 租户索引——7 个消费点全经 SessionStore **接口**(实现可换) | 低延迟高频小写 + 顺序读(mget) |
| audit:log | Stream + xtrim MAXLEN 10k 保留窗口(会话审计:tool_call/self_modify/recovery/webhook) | **容量窗口**一行搞定 |
| workflow:* | 分布式锁(SET NX PX + fencing token + Lua compare-and-del)、流程状态 JSON | **TTL 锁 + Lua 原子** |
| components/slot-binding/fallback | 注册表 hash(components/store.ts 35 处读写)、槽位绑定、降级请求表 | 热键高频读写 |
| session-pool/auth/metrics | 槽位计数、鉴权缓存、指标 | 计数器/缓存 |

### 文件(第三引擎,常被忽略)
workspaces/artifacts/toolstore/compiled-cache 等 8 个卷:产物二进制、编译缓存、源码库——**大对象不查询**,天然文件。

### 内存(第四面)
perf-params 配置、guardrails 阈值、space-registry(有 PG 持久化)、event-bus(每 batch 进程内)——**进程生命周期数据**,任何外存都不该装。

**关键事实:四个引擎承载的是四类不同形态的数据,两两之间没有同数据双写**(审计除外——而审计的 PG 端根本没接线)。即现状不是"一份数据两处存",而是"四类数据各存其适"。

## 2. 逐维对比

| 维度 | 全 PG(单引擎) | 全 Redis(单引擎) | 现况:分平面多引擎 |
|---|---|---|---|
| 任务认领竞态 | ✓ 行锁原生 | ✗ Lua 模拟 CAS;角色队列排序/分片索引要自造 | ✓ |
| 记忆检索(GIN/LIKE/版本/幂等) | ✓ 原生 | ✗ 二级索引重建;全文弱;唯一键自造 | ✓ |
| 会话消息流 | △ 可行,高频写放大(vacuum/bloat) | ✓ 原生 | ✓ |
| 审计流容量窗口 | △ 定时 DELETE 批任务 | ✓ Stream MAXLEN 一行 | ✓ |
| 工作流 TTL 锁/fencing | △ advisory lock 是连接级语义,TTL 锁要自建锁表+清理 | ✓ SET NX PX + Lua 原生 | ✓ |
| 热计数/槽位/注册表 | △ 每 incr 一行事务——写放大 | ✓ 原生 | ✓ |
| 持久必达(任务/记忆不可丢) | ✓ WAL | ✗ RDB/AOF 有丢失窗口;误 FLUSHALL 风险 | ✓(关键面在 PG) |
| 故障域 | ✗ **单点全灭** | ✗ 单点全灭 | ✓ 分域降级(pg 挂→kernel 503,PTL 会话照常——main.ts fail-open 已实装) |
| 运维 | 一套备份/监控 | 一套备份/监控 | 两套(各自标准工具成熟;compose 已托管,边际成本≈0) |
| 迁移面 | schema.ts 单点 | key 规范散落(无 schema 概念) | schema.ts 单点 + key 前缀规范 |
| 开发面 | 一套 SQL | 命令集(检索/事务弱) | SQL + 命令(两份心智,但各面已有接口抽象) |
| 容器依赖 | 1 | 1 | 2(已托管) |

## 3. 单引擎化的本仓实证代价

**全 Redis 化 = 重写一个数据库**
- 任务状态机(6 态转换)、认领竞态(SKIP LOCKED)、角色队列索引、记忆 anchors GIN、LIKE 检索、版本/幂等唯一键——全部要在 Lua/二级索引里重造;数据量增长后(zset/stream 大键)检索性能无保障;
- RDB/AOF 丢失窗口直接威胁「任务池/记忆库不可丢」的根本承诺——这是 PTH 信任基座,不可接受;
- 结论:不可行,理由成立且充分。

**全 PG 化 = 三个真代价 + 一个风险**
1. 会话交互高频 append(逐消息写行 + meta 更新)→ 写放大、表膨胀、vacuum 压力——交互面是无界聊天,PG 不是为它生的;
2. 工作流锁/计数/注册表语义重建:TTL 锁(SET PX NX)→ 自建锁表+超时清理任务;fencing Lua → 事务化 compare-and-del;审计容量窗口 → 定时 DELETE 批任务——每处都是新代码+新 bug 面;
3. **故障域集中**:今天 pg 挂了只有 kernel 503(已裁决的 fail-open 设计),全 PG 后 pg 挂 = 会话/工作流/邮箱/任务全灭——把"分域降级"这一既有防线主动拆掉;
4. 风险:Redis 侧的成熟运维经验(RDB/AOF/哨兵)与 PG 侧(vacuum/连接池)经验都要换——迁移成本全是"搬家",没有新能力收益。

## 4. 行业基线(一句话)

PG/MySQL(持久关系面)+ Redis(热/流/锁面)+ 文件(产物面)是行业标准分层——任务池/知识库(关系)+ 交互会话/审计流(顺序热)+ 产物(文件)恰好是这套分层的教科书负载。纯单引擎只在单一形态负载成立(Supabase 全 PG、纯 KV 场景全 Redis)。PTH 是**混合形态负载**,不在单引擎适用面内。

## 5. 结论

1. **引擎不归一,维持分平面多引擎**——四类数据形态各配其适,两两无同数据双写;
2. A2 归并的真正对象是**包/归属层**(kernel/storage 单包、迁移面单一化、死接线清理、审计两平面定责)——附录 B 原案已按此设计,**不需要改方向**;
3. 未来若要动引擎,触发条件(两个前置缺一不可):① 某面数据形态质变(如会话需要全文检索/强一致查询——那一面单独迁 PG);② 运维成本实测失衡(如 Redis 成为运维负担源)。当前两前置均不成立;
4. 附带发现(与本裁决无关,记录待办):audit:log 流目前**无生产消费端**(仅测试读 mock 流)——保留窗口是纯写入成本,消费面(console/审计查询)是未来项,不阻塞本裁决。

## 6. 对附录 B 的修正

- 0.7 新增「后端架构基线」:多引擎分平面为本裁决的**架构基线**——A2 全部 Phase 不移动任何引擎,归并范围 = 包/归属/接线/死代码;
- 裁决点 A2-1 措辞限定:「归并方式」指包层归并方式,与引擎无关;
- Phase 3 审计接线不受影响(两平面定责本来就是多引擎分平面的落地)。
