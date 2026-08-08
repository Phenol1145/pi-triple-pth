---
name: pth-tasks
description: PTH 任务发布工具——向 PTH kernel 发布异步任务（tasks 表）、查询状态、控制 batch 扩缩容。当用户要"让 PTH 跑个任务/并行调查/后台处理"、或要查看 PTH 任务/batch 运行状态时激活。配套命令：/pthtask（会话内）、ptl hub kernel（shell）。
---

# PTH 任务发布

PTH（Pi-Triple Hub）是远端任务运行时：你发布任务到 kernel 的 tasks 表（pg），batch 子进程（7 角色 worker）自动 claim 并执行，结果写回 completed/rejected。交互层是 **PTL 会话**——本 skill 教你怎么写任务、何时用命令。

## 何时用 PTH 任务 vs 直接做

**适合发布为 PTH 任务：**
- 异步/后台处理（用户不需要立即拿到结果）
- 可并行拆分的调研/分析（scout/analyst 角色各跑各的）
- 需要持久记忆上下文的长任务（memory-keeper 沉淀）
- 与当前会话无关的独立小活（不打断主线）

**不适合：** 需要用户交互澄清的、依赖本会话私有上下文的、立即要结果的——直接做。

## 任务描述怎么写（关键——batch 是无人值守的）

batch 的 worker 只能看到 `title` + `text`（+tags）。没有你的会话上下文。所以：

1. **title**：一句话目标（≤80 字符），如"调查 pi 扩展机制"
2. **text**：自包含描述，必须包含：
   - 背景（为什么做这个）
   - 具体任务（做什么）
   - **验收标准**（什么算完成——batch 会据此判定 completed/rejected）
   - 可用工具/约束（如有）
3. **tags**：可选分类（code/research/memory 等）

**模板：**
```
背景：<为什么>
任务：<做什么，明确具体>
验收：<可检查的完成标准>
约束：<已知限制>
```

## 使用命令

**会话内（推荐，pi 会话里）：**
```
/pthtask publish 背景：… 任务：… 验收：…
/pthtask ls              # 看任务列表
/pthtask status          # 运行状态全景（batches/tasks/watchdog）
/pthtask batch add 2     # 扩容（任务积压时）
/pthtask batch remove 1  # 缩容
```

**Shell（等价）：**
```
ptl hub kernel tasks add "背景：… 任务：… 验收：…"
ptl hub kernel tasks ls
ptl hub kernel status
ptl hub kernel batch add 2
```

## 发布后流程

1. 发布 → 确认返回 `id` + `status: pending`
2. 若 `status` 显示任务积压且无 batch 运行 → `/pthtask batch add 1`
3. 等待 → 用 `/pthtask ls` 或 `/pthtask status` 轮询（completed/rejected）
4. 向用户报告结果（含 id 与最终状态）；rejected 可查看原因后修正重发

## 状态语义

| status | 含义 |
|---|---|
| pending | 待认领（可被任何 batch worker claim） |
| claimed | 已被某 worker 领取执行中 |
| submitted | worker 已提交结果，待验收 |
| completed | 验收通过 ✅ |
| rejected | 验收失败（text 写得不清晰/验收标准不可达时常见） |
| escalated | 升级待人工处理 |

## 排障

- `PTH_TOKEN 未配置` → 会话环境缺 token，配 `PTH_URL`/`PTH_TOKEN`
- HTTP 503 → kernel 未装配（PTH 主进程 DATABASE_URL 未配置或 pg 不可达）——查 PTH 侧日志
- 任务长期 pending 无 batch → `/pthtask batch add 1`
