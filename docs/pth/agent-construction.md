# PTH Agent 构建体系（稳定可用——v1）

> 目的：把 PTH 的 LLM agent 组件/配置/流程**固化为一套可复用的构建体系**——新角色/新 worker/新能力按体系构建——不靠散落的机制。
> 状态：机制全部实现（生产 lazy 模式运行中）——本文档为整合固化。

---

## 1. 体系全景（一个 agent = 五层）

```
┌─────────────────────────────────────────────┐
│ ① System Prompt（buildAgentSystemPrompt）     │ ← 世界观 + 任务 + 角色块 + 能力块 + 输出要求
│ ② 信息面（memory——统一知识层）                 │ ← role-doc / capability-index / project-map /
│                                              │    self-modify-guide / skill / 既有沉淀
│ ③ 工具面（AGENT_TOOLS——4 原语）                │ ← ts / python_execute / bash_execute / done
│ ④ 收敛机制（运行时）                           │ ← 重复检测 / done 强制 / 静态保护 / 探索自由
│ ⑤ 执行环境（batch + kernel + sandbox）         │ ← 角色簇 / 任务工作区 / 内核池 / 沙箱隔离
└─────────────────────────────────────────────┘
```

## 2. 各层组件明细

### ① System Prompt（agent-loop.ts）
| 块 | 内容 | 注入方式 |
|----|------|---------|
| PTH_WORKER_SYSTEM | 世界观（你在哪/工作流/框架事实/约束）| **固定**（所有角色共享）|
| 任务块 | 当前任务（标题 + 文本）| 固定 |
| 角色块 | eager=角色文档全文 / lazy=指针（memory 查 role-doc）| 按模式 |
| 能力块 | eager=索引全文 / lazy=指针 + 触发指引（capability-index/project-map/API skill）| 按模式 |
| 输出要求 | done 必带 result / 完成标准 / 探索顺序 | 固定 |

### ② 信息面（memory——统一知识层——全部受保护）
| 文档 | id/kind | 内容 | lazy 指针 |
|------|---------|------|----------|
| 角色文档 | role-doc:<role> | 人设/职责/任务类型 | ✅ |
| 能力索引 | capability-index | 能力签名（确切参数/返回）| ✅ |
| 项目全貌 | project-map | 代码库结构/关键文件/任务流 | ✅ |
| 世界观详细 | pth-worker-system | 完整规则 | ✅ |
| 自修改指南 | self-modify-guide | 改系统不变量 | ✅ |
| API 调查 | skill:api-investigation | 调查方法论（Object.keys/fn.toString/readSource）| ✅ |
| 既有沉淀 | task-insight/refine-report | 历史任务结论 | ✅（探索优先）|

### ③ 工具面（agent-tools.ts——4 原语——不给大量工具）
| 工具 | 作用 | 输出模式 |
|------|------|---------|
| ts | PTC 程序（组合一切能力）| default/quiet/errors-only/value-only |
| python_execute | Python（sandbox）| 同上 |
| bash_execute | Shell（sandbox）| 同上 |
| done | 提交（result 必填——无产物拒）| — |

### ④ 收敛机制（运行时——系统级保障）
| 机制 | 实现 | 作用 |
|------|------|------|
| 重复检测 | actionFingerprint（readSource 路径/memory SQL/code 去空白）| ≥3 引导 ≥5 终止 |
| done 强制 | 无 result 拒绝（completed 空结果防）| 完成标准系统级 |
| 静态保护 | isSystemDocId（文档不可覆盖）| 上下文编辑工具不能删静态上下文 |
| 探索自由 | 不限制轮数（300）+ 边做边找 | 模型自然转向产出（实验验证）|
| 推理记录 | thinking 捕获（reasoning_content）| 轨迹可审计 |

### ⑤ 执行环境（batch-process）
| 组件 | 说明 |
|------|------|
| 角色簇 | 8 内置 + 扩展（allWorkerRoles 统一谱系）|
| 任务工作区 | /tmp/tasks/<taskId>/（fs.task 落盘——白名单）|
| 内核池 | 池容量 24（> worker×2 余量）+ acquire 超时 10s |
| 沙箱 | sandbox 容器（python/bash/C 隔离执行）|

## 3. 配置项（env）

| 配置 | 默认 | 说明 |
|------|------|------|
| PTH_AGENT_MODE | lazy | eager（全量注入）/lazy（指针按需）|
| PTH_AGENT_MAX_STEPS | 300 | 推理轮数（不限制）|
| PTH_AGENT_TIMEOUT_MS | 10800000 | 总超时（3h）|
| PTH_AGENT_LLM_TIMEOUT_MS | 90000 | 单次 LLM 超时 |
| PTH_KERNEL_POOL_SIZE | 24 | sandbox 内核池容量 |
| PTH_KERNEL_ACQUIRE_TIMEOUT_MS | 10000 | acquire 排队超时 |
| PTH_WORKER_ROLES | (空) | 指定角色构成（默认全谱系）|
| PTH_REFINE | auto | 任务后提炼（refine-report）|

## 4. 构建流程（怎么加新角色/新能力）

### 新角色
```
1. registerWorkerRole({ id, tags, prompt, capabilities, memoryScope })
   —— id 冲突/pattern 重叠会拒绝（扩展谱系正交）
2. 角色文档：memory kind='role-doc:<id>'（injectPromptDocs 自动注入——按 DEFAULT_ROLES/注册表）
3. 角色进 PTH_WORKER_ROLES 配置 → batch 构成
4. 路由：任务带 flow.role=<id> 或 tags 精确匹配角色固定标签
```

### 新能力
```
1. 代码库式扩展：toolstore/extensions/<name>/（tools/capabilities/events/roles contracts）
2. ext.use 按需引用（eval 重放）——或 kernel 注入（registerKernel）
3. 能力索引更新（buildCapabilityIndex——签名具体化——模型一次读够）
```

### 新 worker（PTL 侧）
```
1. ptl hub job submit（异步委托——脱手）——或 POST /tasks（同步）
2. 任务文本：明确目标/阶段/产物要求（结构化任务——模型按预算推进）
3. 结果：ptl hub job fetch（顺带性能归档 .perf-bench/jobs/）
```

## 5. 验证方法（稳定标准）

| 层 | 验证 |
|----|------|
| 单元 | vitest（1276 全绿——agent-loop/收敛/路由/存储）|
| 端到端 | 生产任务（POST /tasks → 状态 → 产物/轨迹）|
| 轨迹 | GET /kernel/tasks/:id/transcript（thinking + 工具调用——行为审计）|
| 性能 | ptl hub bench（7 类任务 + 系统快照）|
| 门禁 | release-pack.sh（发布打包校验）|

## 6. 已知边界（v1 承认的）

- done 收尾：模型可能 done 空 args（引导中——补充任务验证）
- 模型质量：flash 模型 ts 语法偶错（重试/轨迹可查）
- 探索效率：信息面补强后仍可能绕远（放开轮数兜底——不限制）
