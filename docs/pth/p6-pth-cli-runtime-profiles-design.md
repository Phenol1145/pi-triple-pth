# P6：pth CLI 运行时生命周期统一入口设计

> 状态：**已实现（2026-08-22，P6-1..P6-8 全绿；`@away_from/pth-cli@1.6.2` 已发布）**。
> 关联：`docs/fracta-engine-execution-topology.md` §5.8、`docs/POSITIONING.md` §4、
> `docs/pth/deployment.md`。

## 1. 目标

让 `pth` 成为唯一部署/运行入口：一条命令按**用户需要的运行时剖面**拉起全部依赖；
每层 ready 后才进入下一层；缺失前置给出可执行修复指引；失败可重入（幂等）。
细粒度命令（`pth tools` / `pth services` / `pth local-exec`）保留为调试与逃生舱。

## 2. 命令面（增量演进，现有命令保持兼容）

| 命令 | 职责 |
|---|---|
| `pth init` | 生成 `deploy/.env.pth.secrets`（0600）；初始化 `~/.pi-triple/` 目录 |
| `pth doctor`（P6-1 新增） | 宿主机前置体检：docker、镜像、`PTH_WORKSPACES_HOST`、端口、elan/lean、u8 构建状态、secrets 完整性、数据层可达性 |
| `pth up [--profile X] [--with a,b] [--without a,b] [--rebuild]`（P6-3） | 按剖面编排拉起（§4） |
| `pth down [--profile X] [--all] [--volumes]` | 反向停止 |
| `pth status [--all]`（P6-6） | 聚合：engine/redis/pg/sandbox + tools + services + 专业 runtime 注册态 |
| `pth tools …` / `pth services …` | 现有细粒度手工面，语义不变 |

## 3. 运行时剖面（按需启动容器运行时）

定义 `deploy/runtime-profiles.json`（配置可变层，用户可编辑；区别于 topology §5.10 的
T0 源码层与 T1 `catalog/data/**`，本文件按 T2 配置管理并随 P6-2 建立 schema 校验）：

| profile | 包含 | 典型需求 |
|---|---|---|
| `core`（默认） | pi-platform + sandbox + postgres + redis | 普通 LLM 任务 |
| `tools` | core + compiled/network/secrets 工具容器 | 汇编/bf/yt-dlp/凭据工具 |
| `lean4` | core + `local-lean` | Lean4 证明 |
| `u8` | core + `local-u8` | U8 VM 编译/运行 |
| `jupyter` | core + `jupyter`（双面 + pi-kernel） | notebook 人机交互 |
| `full` | 全部 | 完整平台 |

- `--with a,b` / `--without a,b` 是剖面的临时增删；剖面本身只是便捷组合。
- 剖面文件声明依赖；CLI 不硬编码组件清单。
- 宿主机事实依赖：`core` 也要求 `PTH_WORKSPACES_HOST`（compose workspaces bind mount `:?`）；
  `doctor` 与 `pth init` 必须把它列为必检项而不是 profile 可选项。

## 4. 部署流程（顺序决定 engine 能否发现后端）

engine 在 batch 启动时一次性 probe `PTH_EXEC_BACKENDS`；**后起的服务它看不到**。
统一入口必须把 engine 放到后端全部 ready 之后：

```
1. doctor：env / 端口 / 工具链 / 镜像 / secrets 检查（失败即停 + 修复命令）
2. 加载 deploy/.env.pth.secrets → 注入子进程 env（token 不进命令行历史）
3. 数据层：redis → postgres → sandbox（compose 分服务 up + health wait）
4. 生成 operator token（一次生成、复用同值：Redis 种子 + engine --token + JUPYTER_ENGINE_TOKEN）
5. 宿主服务（按 profile）：local-lean / local-u8（PATH 注入工具链）
6. 工具容器（tools profile）：build → up → loopback registry → verify
7. jupyter（jupyter profile）：compose up（JUPYTER_ENGINE_TOKEN 已在步骤 4 生成）
   → south /health + 北 8888 可达
8. 最后 engine（pi-platform）——local-lean/local-u8/jupyter 已 ready，启动 probe 全绿；
   以步骤 4 的 token 执行 `pth up --token`（种子 + 验证）
9. verify：compose ps healthy / tools verify / services status / engine /health /
   专业 runtime satisfiesLock / pi-kernel cell 往返
```

`pth down` 反向：engine → jupyter/tools → host services → sandbox/pg/redis。
core 栈当前实现为一次 compose down 的原子组；P6-3 若需要逐服务反向，先给 launcher
增加分服务 down 原语，否则保持“core 原子组 + 外围反向”语义并写明。

## 5. 关键决策

- **编排层不重写现有命令**：复用 `runPthUp` / `toolsCommand` / `servicesCommand`；
  `pth up --all` 只是顺序 + env + verify 的组合层。
  **前置重构（P6-3 范围）**：现有 `runPthUp` 是「数据层 + 应用层 + token + verify」的一体命令，
  没有“只起数据层/跳过 engine”开关，token 也在 engine 启动后才生成——必须先拆出
  `upServices(subset)` / `generateToken()` / `seedToken()` 原语，否则 §4 顺序无法实现。
- **secrets 注入自动化**：`*_SECRET/TOKEN/PASSWORD` 从 env-file 读取并注入子进程；
  `PTH_WORKSPACES_HOST` 属于宿主机事实（workspaces 绝对路径），缺失报错并提示，
  不代为猜测。
- **token 同源**：engine operator token 与 `JUPYTER_ENGINE_TOKEN` 同值；tools/services
  token 继续走 `~/.pi-triple/*.json` 回环注册表（0600）。
- **幂等**：每层已有健康实例则跳过（现有 up 语义保留）；失败可整单重跑。

## 6. 实现清单（依赖序）

- ✅ P6-1 `pth doctor`：前置检查 + 修复指引（`src/cli/runtime/runtime-doctor.ts`）。
- ✅ P6-2 `deploy/runtime-profiles.json`：schema + 校验 + 单测（`src/cli/runtime/runtime-profiles.ts`）。
- ✅ P6-3 编排器：`pth up/down --profile/--with/--without/--all`（`src/cli/runtime/runtime-orchestrator.ts`）。
- ✅ P6-4 env 自动注入：secrets 文件 → 子进程环境（`runtime-secrets.ts`）。
- ✅ P6-5 token 编排：operator token 在 jupyter 之前生成、同源注入 `JUPYTER_ENGINE_TOKEN`，
  engine 侧 `pth up --token` 复用同一值。
- ✅ P6-6 `pth status --all`：core/services/tools + 专业 runtime 注册态聚合。
- ✅ P6-7 重发 `@away_from/pth-cli@1.6.2`：tarball 含 jupyter 部署物与 `deploy/runtime-profiles.json`。
- ✅ P6-8 部署文档三仓对齐：deployment.md / POSITIONING / topology。

## 7. 验收

1. 干净宿主机：`pth init && pth doctor` 通过。
2. `pth up --profile full` 一次成功，profile 内全部组件 healthy（core 4 + lean4 + u8 +
   tools 三域 + jupyter，按 §3 清单逐项核对）。
3. 中间任一服务失败 → 明确报错、可重入；重跑 `pth up --profile full` 幂等。
4. `pth down --all` 后容器/进程/注册表清理干净。
5. 全新 `npm install -g @away_from/pth-cli` 后重复 1–4 通过。
