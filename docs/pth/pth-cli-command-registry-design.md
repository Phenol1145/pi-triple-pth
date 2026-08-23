# pth-cli 新命令注册渠道设计（符号连接模型 · Symlink Command Registry）

> 状态：设计定稿待评审（v2 —— 由 “TS handler 模型” 改为 “符号连接 / 外部可执行模型”）
> 范围：`pth <verb>` 顶层命令的插件式注册渠道
> 关联代码：`src/cli/pth-cli.ts`、`src/pth/services/cli.ts`、`src/pth/tools/cli.ts`
>
> **核心原则（v2 决策）**：**尽量不约束命令的具体实现，只提供符号连接。**
> 一个 `pth <name>` 命令 = 一个指向任意可执行文件的符号连接。
> pth-cli 不关心实现语言、不要求任何接口、不做运行时编译——只负责解析、分发、透传。

---

## 1. 背景与目标

当前 `pth-cli` 的所有顶层命令都硬编码在 `src/cli/pth-cli.ts` 的 `switch (cmd)` 中。新增一个 `pth foo` 需要修改源码并重新发布。

v1 设计曾要求命令必须是「TS handler + 默认导出异步函数 + `PthCommandContext` + `tsx` 运行时加载」。**v2 改为彻底解耦**：

1. 允许项目、用户或显式路径提供自定义 `pth <command>`。
2. **命令实现完全不受约束**——shell / python / 二进制 / node / 任意语言皆可。
3. 注册 = **一个符号连接**（`<name> → /任意/可执行文件`），无接口、无 manifest 强制。
4. 不改变现有内置命令行为；内置命令默认优先。
5. 提供 `pth commands` 子命令族用于查看、诊断、批准覆盖。
6. **不引入 `tsx` 依赖**（v1 需要；v2 直接 `exec`，无需编译）。

## 2. 非目标

- 不约束命令实现语言 / 接口 / 运行时。
- 不实现 npm 插件市场、远程安装、自动更新。
- 不实现图形化插件管理。
- 不把内置命令迁移到注册表（保持兼容，后续可选）。
- 不提供多租户权限模型；命令插件的信任模型是“本机用户可执行本机代码”。

## 3. 术语

| 术语 | 含义 |
|---|---|
| 内置命令 | `pth-cli.ts` 中 `switch` 直接分发的命令，如 `up/submit/services` |
| 符号连接命令 | 命令目录里的一个符号连接（或可执行文件），文件名即命令名 |
| 命令目标（target） | 符号连接指向的真实可执行文件 |
| 覆盖（override） | 符号连接命令与内置命令重名时，经用户确认后替代内置命令执行 |

## 4. 总体架构

```
argv
  │
  ▼
pth-cli.ts 入口
  │
  ├── 内置命令？ ──是──▶ 执行内置 switch（默认优先）
  │
  └── 否
        │
        ▼
   SymlinkCommandRegistry
   ├── 发现：扫描命令目录里的符号连接 / 可执行文件
   ├── 解析：<name> → 真实可执行文件路径（realpath）
   ├── 校验：存在 + 可执行（+ 可选覆盖批准）
   └── 分发：spawn(target, args)，stdio 继承
        │
        ▼
   可执行文件 ──▶ stdout / stderr / exit code（原样透传）
```

- 内置命令与符号连接命令分离：内置命令仍是硬编码 switch；注册表只负责“非内置命令”和“显式覆盖”。
- 注册表不缓存到磁盘，进程内按需扫描；`pth commands list` 触发全量扫描。
- **没有 handler、没有接口、没有编译**：pth-cli 只是把 `pth foo a b` 变成 `exec <foo 的真实路径> a b`。

## 5. 发现路径与优先级

### 5.1 发现目录（符号连接目录）

按以下顺序扫描，同名命令**先命中者优先**。每个目录里的**每个条目**（符号连接或可执行文件）的**文件名**就是命令名：

| 优先级 | 路径 | 说明 |
|---|---|---|
| 0 | 内置命令 | `switch` 中的命令，始终优先 |
| 1 | `<cwd>/.pth/commands/<name>` | 当前项目/仓库命令 |
| 2 | `$PTH_CLI_COMMANDS_PATH` 中每个目录的 `<name>` | 显式扩展路径，支持 `:` 分隔多个目录 |
| 3 | `~/.config/pth/commands/<name>` | 用户全局命令 |
| 4 | `<pkgRoot>/commands/<name>` | pth-cli 包内随附命令（预留） |

- 条目可以是**符号连接**（推荐，指向任意位置的可执行文件），也可以**直接是可执行文件**。
- `pth foo` 的查找：依次在上述目录找名为 `foo` 的条目，命中即停。
- `pkgRoot` 为 `@away_from/pth-cli` 安装根目录。

### 5.2 重名处理

- 同一优先级内出现同名条目：**报错**并计入 `pth commands doctor`。
- 不同优先级出现同名：按上表优先级取第一个；其余标记为 `shadowed`，在 `pth commands list` 中可见但不执行。

## 6. 命令 = 符号连接（规范）

### 6.1 注册方式
创建一个符号连接，**文件名 = 命令名**，指向任意可执行文件：

```bash
# 用户全局
mkdir -p ~/.config/pth/commands
ln -s /opt/mytools/hello.sh ~/.config/pth/commands/hello

# 项目内
mkdir -p .pth/commands
ln -s ../../scripts/deploy-check.py .pth/commands/deploy-check
```

之后：

```
pth hello           →  exec /opt/mytools/hello.sh
pth deploy-check    →  exec <解析后的 deploy-check.py>（带剩余参数）
```

### 6.2 解析规则
1. 在所有发现目录中按优先级找名为 `<cmd>` 的条目。
2. 若是符号连接 → `fs.realpath()` 解析到真实路径（支持多级符号连接）。
3. 校验真实路径存在且可执行（`fs.access(X_OK)`）。
4. `spawn(realpath, args, { stdio: "inherit" })`。
5. 以子进程退出码退出。

### 6.3 无 manifest 强制
- **不要求** `command.json` / handler / 接口。
- 元数据（描述 / 用法）**完全可选**：放一个同名 sidecar 文件 `<name>.meta.json`（见 §8），缺失时 `pth commands list` 只显示名称与目标。

## 7. 执行契约（命令拿到什么）

符号连接命令以**普通子进程**运行，pth-cli 只保证以下几点：

| 项 | 约定 |
|---|---|
| `argv` | `pth foo a b --x` → 子进程收到 `["a", "b", "--x"]`（去掉 `pth` 与 `foo`） |
| `stdin/stdout/stderr` | 完全继承（`stdio: "inherit"`） |
| 退出码 | 子进程退出码原样作为 `pth` 的退出码 |
| 环境变量 | 继承当前环境；额外注入便利变量（见下） |

注入的便利环境变量（**可选消费，非接口强制**）：

| 变量 | 含义 |
|---|---|
| `PTH_COMMAND` | 用户输入的命令名 |
| `PTH_API` | engine API 地址（默认 `http://localhost:3000`） |
| `PTH_TOKEN` | 当前 token（若已设置） |
| `PTH_CWD` | 调用时的工作目录 |

> 命令若需访问 engine，用 `PTH_API` / `PTH_TOKEN` + HTTP，或 shell 出去调 `pth` 子命令——**不作为接口强制**。

## 8. 可选元数据（sidecar，非强制）

文件：`<commands-dir>/<name>.meta.json`（与符号连接同名同目录）

```json
{
  "description": "示例命令",
  "usage": "pth hello [--name <n>]",
  "hidden": false,
  "overrideBuiltin": false
}
```

- 所有字段均可选；文件整体也可缺省。
- 仅用于 `pth commands list` 展示与覆盖声明，不影响执行。
- 命令的帮助信息也可由其自身 `--help` 提供，pth 不强制。

## 9. 命令解析与调度

### 9.1 主流程

```
main(argv):
  cmd = argv[0]

  # 1) 内置命令优先（除非已批准覆盖）
  if isBuiltin(cmd):
    if symlinkOverrides(cmd) and approved(cmd):
      return execSymlinkCommand(cmd, rest)
    else:
      return 执行内置命令

  # 2) 符号连接注册表
  target = registry.resolve(cmd)     # realpath
  if target:
    return exec(target, rest)        # stdio 继承，退出码透传

  # 3) 未找到
  print usage
  exit 1
```

### 9.2 覆盖决策

- 符号连接命令默认不覆盖内置命令。
- 若 sidecar 声明 `overrideBuiltin: true` 且命令名与内置命令重名：
  - 首次执行时提示确认；非 TTY 环境拒绝并提示 `pth commands approve <name>`。
  - 批准后写入 `~/.config/pth/command-approvals.json`；`pth commands revoke <name>` 撤销。

## 10. `pth commands` 子命令族

新增顶层命令 `commands`（内置，硬编码在 switch 中）：

| 子命令 | 作用 |
|---|---|
| `pth commands list` | 列出内置命令 + 符号连接命令；显示来源、目标路径、覆盖/隐藏状态 |
| `pth commands doctor` | 扫描所有命令目录；报告损坏符号连接、不可执行、重名冲突 |
| `pth commands path` | 打印当前生效的发现目录 |
| `pth commands approve <name>` | 批准符号连接命令覆盖内置命令 |
| `pth commands revoke <name>` | 撤销覆盖批准 |
| `pth commands run <name> [args...]` | 显式运行某个符号连接命令（绕过内置优先） |

## 11. 安全模型

- v2 仅支持**本地命令目录**，不自动执行远程代码。
- 符号连接目标与 pth-cli 同权限运行；用户对自己机器上的命令负责。
- 覆盖内置命令必须显式批准，批准记录保存在用户目录。
- `fs.realpath` 解析后校验可执行位；损坏符号连接 → 明确报错，不静默执行。
- 日志/错误信息不输出完整环境变量，避免 secret 泄漏。
- 后续如需支持远程/共享命令，再引入签名与信任锚点。

## 12. 错误处理

| 场景 | 行为 |
|---|---|
| 符号连接损坏（`realpath` 失败） | `doctor` 报错；执行时提示“命令 `<name>` 目标缺失” |
| 目标不可执行 | 提示“目标无执行权限” |
| 重名命令 | 高优先级生效，低优先级标记 shadowed；doctor 提示 |
| 未批准覆盖 | 非交互拒绝；交互提示 |
| 子进程非零退出 | `pth` 以相同退出码退出（透传） |
| 命令目录不存在 | 视为无命令，跳过（不报错） |

## 13. 依赖与打包

- **无需新增 `tsx` 依赖**（v2 直接 `exec`，不编译）——相比 v1 是净简化。
- 实现仅依赖 Node 内置 `node:child_process` / `node:fs`。
- `pth-cli` 的 `files` 保持 `dist` + `deploy`；`commands/` 预留目录随包发布。

## 14. 测试与验收

### 14.1 单元测试
- 符号连接解析：正常 / 多级符号连接 / 损坏 / 不可执行。
- 发现优先级：项目 > env > user > package；同名 shadowed。
- 覆盖批准 / 撤销 / 非交互拒绝。
- 退出码透传、参数透传。

### 14.2 集成测试
- 建临时 `~/.config/pth/commands/hello → <脚本>`，执行 `pth hello` 验证输出与退出码。
- 用 shell / python 两种目标各测一次（证明不约束实现）。
- `pth commands list / doctor / path`。
- 同名覆盖：默认不覆盖 → 批准后覆盖 → 撤销恢复。

### 14.3 验收门禁
- `npm run lint`、`npm test`、`npm run build` 全绿。
- `pth commands doctor` 在干净环境无错误。
- 现有内置命令行为零变化（回归测试覆盖）。

## 15. 实施步骤

1. **解析**：新增 `src/cli/commands/symlink-registry.ts`（发现 + `realpath` + 可执行校验 + 优先级）。
2. **分发**：新增 `src/cli/commands/dispatch.ts`（`spawn` + stdio 继承 + 退出码透传 + 便利环境变量注入）。
3. **命令面**：在 `pth-cli.ts` 增加 `case "commands"`，实现 `list/doctor/path/approve/revoke/run`；并在默认分支前接入符号连接解析。
4. **覆盖批准**：`~/.config/pth/command-approvals.json` 读写与交互确认。
5. **可选元数据**：读取 `<name>.meta.json`（缺省容错）。
6. **测试**：补单元/集成测试。
7. **文档**：更新本设计为“已实现”状态，并在 README 增加 `pth commands` 用法。

## 16. 后续可选方向

- PATH 约定兜底：找不到符号连接时再查 PATH 上的 `pth-<name>`（git 风格）。
- `pth commands install <path>`：自动建立符号连接。
- 命令权限分级：`user / project / trusted`。
- 命令签名与校验。
- 将内置命令逐步迁移到注册表，实现统一 `list/doctor`。
