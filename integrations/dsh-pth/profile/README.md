# dsh-pth：PTH interface 模式

让一个 dsh（DeepSeek Harness）agent 变成 **PTH 任务池管理系统的前端**：
agent 只持有 `pth_*` 工具与一份 PTH 使用手册，不持有 bash/fs/subagent/web 等任何其他模型面工具。

本目录不在 npm workspace 内，是纯 ESM JS，免构建、不参与仓库 lint/build。

## 目录结构

```
integrations/dsh-pth/
├── plugin/                 # Cordis 插件包（安装进 dsh profile 的依赖）
│   ├── package.json        # @pth/dsh-interface-plugin
│   └── index.js            # 注册 pth_* 工具 + 注入 PTH 使用手册
└── profile/                # dsh profile 模板
    ├── package.json        # bundles = dsh-base + dsh-headless
    ├── cordis.patch.yml    # 禁用非 PTH 工具 + 插入插件
    ├── pnpm-workspace.yaml
    ├── install.sh          # 一键安装/更新 ~/.dsh/profiles/pth
    └── README.md
```

## 安装

前置：本机已有 `dsh` CLI、Node ≥ 22；有 `pnpm` 或 `corepack`（Node 自带）之一。

```bash
cd /path/to/pi-triple-pth/integrations/dsh-pth/profile
./install.sh            # 默认安装到 ~/.dsh/profiles/pth
# 或 ./install.sh pth2 安装到自定义 profile 名
```

脚本会：

1. 创建 `~/.dsh/profiles/pth/`（`$DSH_HOME` 存在时用 `$DSH_HOME`）；
2. 写入 `package.json`（bundles：`@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-headless`）、`pnpm-workspace.yaml`、`cordis.patch.yml`；
3. 用 `pnpm pack` 把 `../plugin` 打成 tarball，再用 pnpm（`corepack pnpm` / `npx pnpm` 兜底）安装为 profile 依赖。

> `file: 相对路径` 在 profile 里会相对于 profile 目录解析，容易装错；
> 而 `dsh plugin add <本地目录>` 会让 pnpm 建立 symlink，Node 会按插件仓库真实路径解析依赖，
> 找不到 dsh profile 提供的 `@deepseek-ai/schemastery` / `@deepseek-ai/dsh-tools`。
> 因此 install.sh 采用 `pnpm pack` + tarball 安装，插件实体落在 profile/node_modules 下。

## 验证

```bash
# 1. 查看组合树：确认非 PTH 工具行已 disabled、pth-interface 行在位
dsh --dump-config --profile pth | grep -E '^- id: (tool-|pth-interface|user-questions)' -A1

# 2. 设置 token（只从环境变量读，不写仓库）
export PTH_TOKEN=<你的 ops admin token>

# 3. 端到端：发任务 → 等待 → 读结果
dsh --profile pth "给 developer 发个任务：计算 21*2，要求最终结果以 JSON 对象提交 {\"answer\": 数值}；发布后等待完成并读出 answer"
```

## 工具清单

所有工具返回统一结构：成功 `{ ok: true, ...业务字段 }`，失败 `{ ok: false, error: { code, message, status?, details? } }`。

| 工具 | 参数 | 成功返回 |
| --- | --- | --- |
| `pth_submit` | `title`（必填）、`text`（必填）、`tags?` | `{ ok:true, task }` |
| `pth_status` | `taskId`（必填） | `{ ok:true, task }` |
| `pth_wait` | `taskId`（必填）、`timeoutSec?` | `{ ok:true, task, waitedMs, timedOut }` |
| `pth_tasks` | `limit?`、`status?` | `{ ok:true, tasks:[...], count }` |
| `pth_cancel` | `taskId`（必填） | `{ ok:true, result }` |
| `pth_transcript` | `taskId`（必填） | `{ ok:true, transcript }` |
| `pth_kernel_status` | — | `{ ok:true, status }` |
| `pth_worker_activity` | `role`（必填）、`sinceSec?` | `{ ok:true, activity }` |
| `pth_worker_context` | `role`（必填）、`last?` | `{ ok:true, context }` |
| `pth_roles` | — | `{ ok:true, roles:[...] }` |

### 典型流程

- **发任务 → 等结果**：`pth_submit` → `pth_wait` → 读 `task.payload.result.value` / `task.outputRef.ref.value`。
- **排查**：`pth_kernel_status` → `pth_tasks` → `pth_worker_activity(role)` → `pth_worker_context(role)` → `pth_transcript(taskId)`。
- **取消**：`pth_cancel(taskId)`。

## profile 禁用行清单

`profile/cordis.patch.yml` 逐条对照 `@deepseek-ai/dsh-base/cordis.patch.yml` 禁用以下模型面工具行：

```
tool-bash
tool-pwsh
tool-jobs
tool-fs
tool-fs-search
tool-str-replace-editor
tool-skill
tool-goal
tool-subagent-control
tool-subagent-list-agents
tool-subagent
tool-subagent-fork
tool-subagent-report
tool-workflow
tool-ralph
tool-todo
tool-web
```

同时禁用非工具但会引入额外上下文/能力的行：

```
skill-filesystem   # skill 装载面
agent-instructions # AGENTS.md/CLAUDE.md 注入
plan-mode          # 避免 plan-mode 自带模型面工具/模式
```

保留：

- `user-questions`：操作员对话通道（headless 不影响；交互时可让操作员澄清）。
- `tool-result-pruner`：它不是模型面工具，保留用于裁剪大响应（例如长 transcript），防止撑爆上下文。

## 设计决策

- **为什么是插件，不是 skill？**
  skill 只能给 agent 增加“知识/技能描述”，不能注册、禁用工具。interface 模式的核心是**工具面收窄**——必须用 Cordis 插件 + profile patch 的 `disabled` 机制实现。
- **为什么保留 user-questions？**
  即使 interface 模式，操作员仍可能需要向 agent 澄清任务；`user-questions` 不是模型面工具，不违背“只持有 pth_* 工具”。不需要时可注释掉对应行。
- **为什么用 dsh-base + dsh-headless？**
  `dsh-base` 提供基础设施（agent/llm/session/tools/system-prompt 等）；`dsh-headless` 提供一次性执行入口（`dsh --profile pth "任务"`）。
- **为什么用 pnpm pack 安装本地插件？**
  本地目录依赖被 pnpm 默认 symlink 到仓库；symlink 会破坏 Node 从 profile 共享依赖目录解析 peerDependencies 的路径。打包成 tarball 后插件以普通依赖实体安装，能稳定解析 dsh 提供的 `@deepseek-ai/dsh-tools` / `@deepseek-ai/schemastery`。
- **为什么工具返回统一 `{ ok, error }` 信封？**
  让模型零猜测：成功/失败形状一致；失败时 `error.code` 可直接用于排查（`PTH_TOKEN_MISSING` / `PTH_NETWORK_ERROR` / `PTH_HTTP_ERROR`）。

## 已知限制

- 本插件只封装了用户指定的 10 个 pth API 工具；PTH 的 batch/optimizer/memory 等管理端点未封装。
- `pth_wait` 把 `completed/rejected/escalated` 视为终态；若未来出现新的终态状态，需要同步更新 `TERMINAL_STATUSES`。
- token 只从 `process.env[tokenEnv]` 读取，不会自动读取 `~/.dsh/.credentials.yaml`；这是刻意设计（工具不碰 dsh 密钥存储）。
- `pth_transcript` 目前按后端返回原样透传；若后端后续新增 `context` 字段，也会随 `transcript` 一起返回。
