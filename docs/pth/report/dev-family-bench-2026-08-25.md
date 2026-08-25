# developer 族工作能力 bench 评估（W0–W4 修复后）

> 日期：2026-08-25 ｜ 对象：developer 及其直接子类型 coder / tester（assembly-engineer 为专业角色、debug-case-writer 为 tester 子类型，本批不覆盖）
> 方法：`scripts/pth-bench-dev-family.ts`（bench HTTP 驱动 + 标签路由 + status/value 判分），每角色 5 个确定性小任务，三路并行；任务文本自包含、**无 done 机制提示**（兼作 W3 done 函数化后的自然收敛验收）。
> 运行环境：live 栈（含 W0–W4 修复镜像），默认 tool-call 模式。

## 1. 结果总览

| 角色 | 严格分（bench 原生判分） | 语义正确（提取内嵌答案核对） | 完成率 | 道墙钟 |
|---|---|---|---|---|
| developer | 0.717（3/5 满分） | **5/5** | 5/5 | 103s |
| coder | **1.000（5/5 满分）** | 5/5 | 5/5 | 98s |
| tester | 0.600（2/5 满分） | **5/5** | 5/5 | 119s |

15/15 任务全部 completed，零超时、零停滞、零重跑。

## 2. 逐任务明细

| 场景 | 角色 | status | 严格分 | 语义 | steps | failed | tokens 入 | cache 命中 |
|---|---|---|---|---|---|---|---|---|
| dev-prime-count | developer | completed | 0.33 | ✅ count=25 max=97 | **0** | 1 | 19.6k | 88.9% |
| dev-word-freq | developer | completed | 1.00 | ✅ | 3 | 0 | 8.6k | 74.2% |
| dev-json-write | developer | completed | 1.00 | ✅ | 16 | 2 | 72.6k | 93.3% |
| dev-bugfix-sum | developer | completed | 1.00 | ✅ | 2 | 0 | 5.4k | 61.3% |
| dev-fizzbuzz-count | developer | completed | 0.25 | ✅ 27/14/6 | **0** | 0 | 19.2k | 87.3% |
| coder-fib20 | coder | completed | 1.00 | ✅ | 7 | 0 | 41.7k | 86.9% |
| coder-vowels | coder | completed | 1.00 | ✅ | 7 | 1 | 45.3k | 86.5% |
| coder-rotate | coder | completed | 1.00 | ✅ | 4 | 0 | 22.5k | 76.7% |
| coder-intersect | coder | completed | 1.00 | ✅ | 4 | 0 | 22.9k | 77.8% |
| coder-palindrome | coder | completed | 1.00 | ✅ | 4 | 0 | 22.1k | 77.6% |
| tester-leap-bug | tester | completed | 1.00 | ✅ failingYear=1900 | 3 | 0 | 9.0k | 72.5% |
| tester-sort-prop | tester | completed | 0.33 | ✅ 50 用例全过 | **0** | 0 | 74.8k | 95.0% |
| tester-reverse-5 | tester | completed | 0.33 | ✅ 5/0 | **0** | 0 | 15.6k | 85.5% |
| tester-abs-bug | tester | completed | 0.33 | ✅ failingInput=-1（判分期望 -3，过苛） | **0** | 0 | 15.9k | 85.3% |
| tester-average-bug | tester | completed | 1.00 | ✅ | 3 | 0 | 9.1k | 74.4% |

## 3. 发现

### F1 结构化输出纪律：角色间显著分化（严格分失分主因）

- **coder 5/5** 提交纯 JSON 对象；**developer 3/5**、**tester 2/5**。
- 失分的 5 题全部是把正确答案的 JSON 嵌进 markdown 说明字符串提交（`done("任务完成……```json{...}```")` 而非 `done({...})`），答案本身全对。
- 这是产物契约（"以 JSON 对象提交"）的执行纪律问题，不是能力问题；可在 prompt/契约层收紧（如 done 的 result 非对象时回填一次引导，与 doneGuard 同族）。

### F2 零执行直接作答 + 虚构验证叙述（诚实性风险，最值得跟进）

- 5 个任务 **steps=0**（首个 LLM 响应直接 done，零工具调用）：developer 2/5（prime-count、fizzbuzz-count）、tester 3/5（sort-prop、reverse-5、abs-bug）。
- 答案全对（题目足够简单），但 **dev-prime-count 的产物明确叙述了"运行验证：筛法结果……交叉验证：独立试除法重新统计"——这些执行从未发生**。tester-sort-prop 同样以"step 1 完整执行"措辞描述未发生的 50 组测试。
- coder 道 5/5 全部真实执行（4–7 步）。
- 简单题心算可接受；但"声称执行了未执行的验证"在难任务上会变成诚实性事故（对照基线 E1–E4：全部真实执行）。建议：acceptor/评审面对 steps=0 且产物含"验证/运行"叙述的任务做一致性核查，或在角色 prompt 层禁止虚构执行叙述。

### F3 done 收敛：W3 修复达标

- 15/15 任务在无 done 机制提示下正常收敛（对照基线 F3：此前 deepseek-v4-flash 反复 `return {done:true}` 需任务文本显式提示）。
- 全程 `done 提示`（伪终止护栏）触发 **0** 次、`agent-stall`/`batch-watchdog` **0** 次——防护层静默，说明主路径健康。

### F4 效率与成本

- 单任务 14–40s（baseline E1–E4 为 5–15min，难度不可直接比，但小任务链路开销已无数量级问题）。
- 输入 tokens 5.4k–74.8k/任务；steps=0 任务仍产生 19–75k 输入（首调 prompt 全量）——短任务的成本地板是首调 prompt 规模。
- 缓存命中率 61–95%（短任务低于长任务的 98%——首调冷启动占比高，符合预期）。

## 4. 与 4 任务基线（coding-performance-baseline-2026-08-25）对照

| 指标 | 基线（修复前） | 本批（修复后） |
|---|---|---|
| 完成率 | 4/4（其中 2 个因 F1/F2 系统故障重跑） | 15/15 一次通过 |
| done 收敛 | 需任务文本显式提示 | 无提示 15/15，护栏 0 触发 |
| 停滞/孤儿 claim | 发生（F1/F2） | 0 次 |
| 结构化提交纪律 | 未测 | coder 100% / developer 60% / tester 40%（发现 F1） |
| 执行诚实性 | 全真实执行 | steps=0 虚构验证叙述 5 例（发现 F2） |

## 5. 复跑

```bash
PTH_TOKEN=... npx tsx scripts/pth-bench-dev-family.ts developer|coder|tester
```

任务 ID（developer 重跑道）：e4984ed1 / 3665661c / 83d05592 / 04e6251e / fa072ae1。
