# Coding 性能基线评估报告（N34 前置基线，2026-08-25）

> 目的：在 N34（LSP+DAP IDE 面）落地前，以 developer 角色真实开发任务建立 coding 性能基线。
> 环境：docker compose 全栈（pi-platform 新镜像 `0042e33`、sandbox、PG、Redis）；
> LLM = deepseek/deepseek-v4-flash（经 `~/.pi/agent/auth.json` 凭据接线，ModelRouter 自动探测）。
> 数据：任务 API + `/transcript` scorecard + 平台日志。本报告全部为实跑记录。

## 1. 任务与结果总览

4 个真实开发任务（tags=["code"] → developer 角色，worker 无 dev.* 工具——走 bash/python/fs/ts.run 裸链路）：

| # | 任务 | 结果 | 步数 | 失败动作 | tokens（入/出） | 关键证据 |
|---|---|---|---|---|---|---|
| E2 | 二分查找双 bug 定位修复 | ✅ 一次通过 | 29 | 3 | 342k / 17k | 两根因均正确定位（hi=mid-1 漏检、lo=mid 死循环）并附复现用例；14 固定用例 + 2000 组随机属性测试全过 |
| E4 | C 素数筛（百万内 78498） | ✅ 一次通过 | 48 | 6 | 673k / 19k | gcc -O2 零警告；结果正确；独立 Python 交叉验证；程序内计时 6.6ms |
| E1r | LRU+TTL 缓存 + 测试 | ✅ 重跑通过 | 42 | 1 | 224k / 14k | unittest 17 用例全过；pytest 不可装（沙箱无网）主动改 unittest |
| E3r | wordcount CLI（对齐 GNU wc） | ✅ 重跑通过 | 41 | 7 | 896k / 40k | 反推 GNU wc 输出格式规则；20 组用例 stdout/stderr/退出码三要素全一致 |

**首次提交的 E1/E3 未计入**——它们在 06:16 因系统级故障停滞（见 §3 F1/F2），取消后重跑（E1r/E3r，任务文本补了一句"用 done 工具提交"提示）。

缓存效率：cacheRead/input ≈ 97–98%（DeepSeek prompt cache 命中良好，长循环成本可控）。

## 2. 观察到的系统行为（亮点）

1. **跨任务记忆复用真实生效**：冒烟阶段某 worker 沉淀的"grant 过期 → bash.dispose() 恢复"task-insight，被 E4/E1r 的 worker 主动检索并成功复用——记忆系统闭环工作。
2. **环境自适应能力强**：pytest 装不上（PEP 668 + 沙箱无 DNS）→ 主动改 unittest；python 核进程崩溃 → 改用 bash 调系统 python3。
3. **验证习惯好**：E2 主动补随机属性测试；E3r 实测系统 wc 反推格式规则再 20 例对齐；E4 双重验证（断言 + 交叉实现）。
4. **TCE 主路确认**：全部工作经 `ts.run` 代码面完成（toolFreq 仅 ts_run + done），工具调用投影机制运行正常。

## 3. 发现的系统问题（按严重度）

| # | 问题 | 现象与证据 | 建议去向 |
|---|---|---|---|
| F1 | **LLM 连接挂起导致 agent loop 无限静默停滞** | E1/E3 于 06:16 同时停步，日志零输出 9 分钟+；batch 进程存活（S 态 11 线程）；`PTH_AGENT_LLM_TIMEOUT_MS=90s` 未生效于该路径 | 排查 llm-fn fetch 的 AbortController 接线；agent 循环加 watchdog |
| F2 | **平台重启不回收孤儿任务 claim** | restart 后 recovery 仅恢复会话（recovered:1）；E1/E3 永久停留 claimed 且无执行者、无日志、无升级 | tasking 租约恢复机制（lease 过期 → requeue）；这是正确性缺口 |
| F3 | **done 收敛困惑（deepseek-v4-flash）** | worker 反复在 ts.run 里 `return {done:true}` / `({task:"E1"})` 而非调用 done 工具（E1 停滞前、memory-keeper 治理任务同样可见）；E1r/E3r 在任务文本显式提示后改善 | prompt/契约层强化 done 调用方式；或评估 done 是否该作为 ts.run 内可调用函数 |
| F4 | sandbox grant 任务中过期 | E4/E1r 均遇到；worker 经记忆自愈 | grant TTL 与任务时长匹配性评审 |
| F5 | 内核池并发打满（24/24） | 冒烟3 因 acquire timeout 无法执行（此前发生） | 池容量/泄漏审计；N34 设计已要求 LSP/DAP 独立池 |
| F6 | 沙箱无网络致 pytest 不可装 | E1r 改 unittest 规避 | 预期行为（安全设计），但任务模板应提示"用标准库测试" |

## 4. 对 N34 的基线意义

- 基线形态：**无 IDE 面**——worker 靠"写文件→bash 跑→读输出"裸循环迭代，无诊断、无跳转、无符号索引；
  E3r 为对齐输出格式花了 41 步（其中大量是 hex 级 diff 探测），LSP diagnostics/hover 可直接压缩这类迭代。
- 对照指标（Phase 3 复测同一任务组）：steps、failedActions、output tokens、墙钟时长、done 收敛一次率。
- F3（done 收敛）与 N34 正交但影响所有编码任务效率，建议独立优先修。

## 5. 复现方式

```bash
# 栈：docker compose -f deploy/docker-compose.yaml up -d（需 deploy/.env，含 DEEPSEEK_API_KEY）
TOKEN=<platform-admin token>
curl -X POST http://localhost:3000/api/v1/kernel/tasks -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"title":"...","text":"...","tags":["code"]}'
curl http://localhost:3000/api/v1/kernel/tasks/<id>/transcript -H "Authorization: Bearer $TOKEN"  # scorecard
```

任务全文与判定标准见本报告 §1 表内描述；任务 ID：E2 `bc3fb122`、E4 `1d38b085`、E1r `f02dafcf`、E3r `c7016d82`。
