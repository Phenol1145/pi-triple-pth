# PTH 部署目标（Deploy Target）与配置简化设计

> 状态：**设计（未实施）** · 2026-08-27
> 范围裁决（用户 2026-08-27）：本期只做 `local-container`（含容器运行时区分）与
> `local-process` 两个 target；生产级编排（k8s）与远程主机（remote-docker/ssh）**冻结至
> v2.0**——届时 engine 以编译类语言重写，部署面随之一起重做，本文仅为它们保留概念位。
> 本文档只出设计，不含实施。

## 1. 背景与目标

现状部署只有"本机 docker compose"一种形态，配置全靠手工编辑 env。两条改进主线：

1. **配置简化**：`pth init` 从零到可 `pth up` 零手改（密钥自动生成、宿主路径收口、target 预设）；
2. **多部署策略**：引入与 profile 正交的 **deploy target** 概念，覆盖
   - `local-container`：现状 compose 编排，新增**容器运行时检测与适配**（Docker Desktop / OrbStack / Colima / Apple container 等）；
   - `local-process`：无 Docker 裸机/单机信任域（开发机、CI、无容器环境）。

非目标（本期冻结）：remote-docker、k8s manifest 渲染、podman、生产级多机拓扑。

## 2. 现状基线（实施前事实）

| 层 | 事实 | 位置 |
|---|---|---|
| 配置真相源 | ~100 键 schema（group/scope/secret/runtime 标注） | `packages/pth-config/src/schema.ts` |
| 运行时配置 | ConfigCenter：env+默认值合并、快照打码、runtime set、explain | `packages/pth-config/src/config-center.ts` |
| 防回潮 | 禁 `process.env.PTH_*` 直读；compose 键覆盖率统计（对照 `docker-compose.yaml` + `pth.deployment.json`） | `scripts/check-pth-config.ts` |
| secrets | `pth init` 仅复制 example + chmod 600；7 个 dev-only 值需手改；5 个核心密钥 compose `:?` fail-closed | `deploy/.env.pth.secrets(.example)` |
| 编排 | `pth up --profile core\|tools\|lean4\|u8\|jupyter\|full`；顺序 doctor→secrets→数据层→可选组件→engine→verify | `src/cli/runtime/runtime-orchestrator.ts` |
| 体检 | docker/compose、secrets、端口、镜像、宿主 facts（PATH_HAS_LEAN/U8_BUILT/PTH_WORKSPACES_HOST） | `src/cli/runtime/runtime-doctor.ts` |
| compose | 4 服务（postgres/redis/pi-platform/sandbox）+ 双网络 + 限额；dev 叠加手工 `-f` | `deploy/docker-compose{,.dev}.yaml` |
| 分发 | npm 包 `@away_from/pth-cli`（裁剪 dist + deploy/） | `scripts/build-pth-cli-package.sh` |
| 历史双源 | `pth.deployment.json` 已被裁决废弃，仅作 check 对照物（deployment.md §6 注记） | `deploy/pth.deployment.json` |
| 可复用执行面 | `local-spawn-backend`（execution/v1.1 host spawn 后端）已存在；`PTH_EXEC_SANDBOX_ALIAS=off` 可关 sandbox 自动合成；`PTH_PYTHON_MODE=kernel` 为代码内默认（本地 REPL 池）；`packages/pth-sandbox/src/main.ts` 是独立 server 入口 | 各对应源文件 |

关键痛点（设计要消除的）：

1. `pth init` 后仍需手改 7 个密钥 + 手 `export PTH_WORKSPACES_HOST`，"init 完即可 up"不成立；
2. 无"在哪跑/怎么跑"概念，策略不可插拔（orchestrator 硬编码 spawn `docker compose`）；
3. 同一 `docker` CLI 背后的运行时能力不齐（host-gateway、bind mount、compose 支持度），现状零检测零适配；
4. 无容器环境下完全不可部署（PG/Redis/engine/sandbox 全部假定 compose 供给）；
5. `pth.deployment.json` 双源悬置（只是对照物，却与 compose 并列维护）。

## 3. 概念模型：target × profile 正交

```
profile（起哪些组件）:  core / tools / lean4 / u8 / jupyter / full     —— 已有，不变
target （在哪/怎么跑）:  local-container（默认，= 现状）
                        local-process（无 Docker 单机信任域）
                        —— v2.0 概念位：remote-docker / k8s（本期不实现）
```

- 两个维度自由组合（受组件兼容矩阵约束，§6.4）；
- CLI 形态：`pth up [--target local-container] [--profile core] …`，**不带 `--target` 严格等于现状行为**（向后兼容硬约束）；
- target 只改变"组件如何被拉起/探活/停止"，**不改变组件间协议与端口契约**（compose 网络 ≈ localhost 端口映射；secrets/env 键集合不变）。

## 4. Target 接口（代码结构预案）

```
src/cli/runtime/targets/
  types.ts            # DeployTarget 接口 + TargetContext
  local-container.ts  # 现状 orchestrator 逻辑的搬入与收口（含运行时适配 §5）
  local-process.ts    # §6
  detect.ts           # 容器运行时检测（§5.1）
```

```ts
interface DeployTarget {
  readonly id: "local-container" | "local-process";
  doctor(ctx: TargetContext): Promise<DoctorReport>;     // target 专属体检项并入现有 doctor
  up(ctx: TargetContext): Promise<void>;                 // 复用 profile 组件序（数据层→可选→engine）
  down(ctx: TargetContext): Promise<void>;
  status(ctx: TargetContext): Promise<void>;
  envPresets(): Record<string, string>;                  // target 默认 env（§7.3）
}
```

`runtime-orchestrator.ts` 改为 target 驱动的薄编排：组件序/健康等待/token 同源播种逻辑保留，"怎么拉起 compose 服务 or 本地进程"下沉到 target 实现。**已有 orchestrator 测试以 deps 注入为主，target 重构必须保持这些 seam 不破。**

## 5. local-container：容器运行时检测与适配

### 5.1 运行时识别（detect.ts）

统一入口仍是 `docker` CLI（OrbStack/Colima 均提供 docker CLI shim 与 context），识别依据三层指纹（按序取先命中者）：

| 运行时 | 检测指纹 | 备注 |
|---|---|---|
| Docker Desktop | `docker info` `OperatingSystem` 含 "Docker Desktop"；socket `/var/run/docker.sock` | 基线 |
| OrbStack | `docker context show` = `orbstack`；或 socket 路径含 `/.orbstack/`；或 `orb version` 可执行 | host.docker.internal 原生可用 |
| Colima | `docker context show` 前缀 `colima`；socket 含 `/.colima/`；`colima status` | 见 §5.2 host-gateway 注意 |
| Rancher Desktop | context = `rancher-desktop` | 能力同 Docker Desktop（探测即可，不专门适配） |
| Apple container | `container --version` 可执行且 `docker` 不可用/或用户显式指定 | **compose 不可用**——见 §5.3 |

### 5.2 能力差异矩阵（影响 PTH compose 的项）

| 能力 | Desktop | OrbStack | Colima | 影响面 |
|---|---|---|---|---|
| `docker compose` v2 | ✔ | ✔ | ✔ | 编排本体 |
| `extra_hosts: host-gateway` | ✔ | ✔ | ⚠ 指向 lima VM 网关；mac 宿主需 Colima ≥0.6 的 `network.address` 或 `host.docker.internal` 注入 | local-lean/local-u8 经 host.docker.internal 回环（compose P2 通道） |
| bind mount 属主/性能 | osxfs/virtiofs | virtiofs（快） | virtiofs/sshfs 可选；uid 映射差异 | `PTH_WORKSPACES_HOST` 卷（容器 node uid=1000） |
| `internal: true` 网络 | ✔ | ✔ | ✔ | sandbox 零出口契约 |
| 端口发布 | ✔ | ✔（含域名） | ✔（需 reachableAddress） | :3000/:8080 |

适配策略：**不 fork compose 文件**，差异全部收进 doctor 检查 + 提示（Colima 未开 host 寻址 → fail 项附修复命令 `colima start --network-address`）；确实不可适配的（Apple container 无 compose）走 §5.3。

### 5.3 Apple container（`container` CLI）处置

macOS 26+ 的原生 `container`：无 daemon、无 compose、无 `internal` 网络原语、DNS 域独立。
PTH 的 compose 依赖（服务依赖序/healthcheck/internal 网络/命名卷）无法直接映射。

**裁决（设计）**：本期识别并**显式报错**（"apple-container 需要 compose 兼容层，本期不支持；请安装 Docker Desktop/OrbStack/Colima 任一"），不做 compose→`container run` 渲染器。理由：渲染器等于重写编排语义（网络/健康检查/卷），收益小且与 v2.0 编译 engine 的部署重做重叠。doctor 检测到**只有** apple container 可用时给出上述 fail 项。

### 5.4 `--runtime` 覆盖与 doctor 项

- `pth doctor` 新增 `container-runtime` 检查项：报告识别结果（desktop/orbstack/colima/rancher/apple/none）+ 关键能力位（compose ✔/✘、host-gateway ✔/⚠）；
- `pth up --runtime <id>` 显式覆盖检测结果（检测错判的逃生舱）；检测失败且未指定 → 沿用"docker 可用即过"的现状语义（不引入新 fail）。

## 6. local-process：无 Docker 单机信任域

### 6.1 信任域与安全语义（诚实声明）

local-process 面向**开发机/CI/单用户信任环境**：无容器隔离、sandbox 零出口网络契约不成立、
`PTH_CONFIG_STRICT` 默认降为 `0`（用户可显式开）。CLI 在首次 `up` 时打印一次性声明。
**不降低**任何协议校验（secrets 仍然必填，只是允许本地生成值）。

### 6.2 组件映射

| profile 组件 | local-container 形态 | local-process 形态 |
|---|---|---|
| redis/postgres | compose 服务 | **外部供给**：`REDIS_URL`/`DATABASE_URL` 指向本机或托管实例；doctor TCP 探活，不托管生命周期（up/down 跳过，status 探活展示） |
| sandbox | compose 容器 | **二选一**（`--sandbox process\|none`，默认 `process`）：`process` = 以本地 node 子进程跑 `packages/pth-sandbox` server（保留 kernel-pool/exec-api 语义与端口契约，仅失去 namespace 隔离）；`none` = 关闭 sandbox，`PTH_EXEC_SANDBOX_ALIAS=off` + `PTH_PYTHON_MODE/BASH_MODE=kernel`（本地 REPL 池，= 现有 dev 模式） |
| engine | compose 容器 | 本地 `node dist/pth/main.js` 子进程（dev 仓内可 `tsx watch`）；端口 :3000 |
| tools / local-lean / local-u8 | 宿主工具容器 / service | 不变（本来就是宿主侧）；tools（docker 工具容器）在 local-process 下不可用 → doctor fail 并提示 `--without tools` |
| jupyter | service（compose） | 冻结：jupyter compose 依赖 docker，local-process + jupyter 组合直接报错（或后续映射为本机 jupyter，非本期） |

### 6.3 进程生命周期

- 新增 `src/cli/runtime/process-supervisor.ts`：spawn（detached）+ pidfile/日志目录（`~/.pi-triple/run/<component>.{pid,log}`）+ 健康轮询复用现有 `waitHealthy` 的 HTTP 变体（`/health`、`/ready`）；
- `down` 读 pidfile 优雅终止（SIGTERM→超时 SIGKILL）；`status` = pid 存活 + /health 聚合；
- engine 启动复用现有 token 播种逻辑（Redis 由外部供给，`redis-cli` 或 engine 自举 API 写入——实施时定，优先复用现有 seed 通道）；
- 不做跨重启守护（无 systemd/launchd 集成——那是 v2.0 生产级的事）。

### 6.4 组件兼容矩阵（非法组合 fail-fast）

| 组合 | 结论 |
|---|---|
| local-process + tools | ✘（docker 依赖） |
| local-process + jupyter | ✘（本期） |
| local-process + lean4/u8 | ✔（宿主执行器天然本地） |
| local-container + 任意 | ✔（现状） |

## 7. 配置简化

### 7.1 `pth init --generate`（默认开启，`--no-generate` 关）

- 7 个密钥全部 `randomBytes` 生成（复用 orchestrator 的 `generatedToken` 强度；核心密钥满足 strict 长度线：grant ≥32、shared/bridge ≥16，一律直接给 64-hex）；
- `PTH_WORKSPACES_HOST`：优先 `--workspaces <path>`；否则交互提示（TTY 时）；非 TTY 且未给 → fail 并附示例。**写入 env 文件**，终结"必须手 export"的割裂；
- 生成后文件即"零手改可 up"（local-container）；local-process 另需 `DATABASE_URL`/`REDIS_URL`，init 打印待填清单；
- 已存在文件仍需 `--force`（现状语义保留）。

### 7.2 env 文件归一

维持**单文件** `deploy/.env.pth.secrets` 作为 compose `--env-file` 与编排器唯一输入（兼容已有部署与文档）；允许写入非密钥宿主路径键（`PTH_WORKSPACES_HOST` 等），文件头注释更新为"统一环境文件（密钥 + 宿主本地路径）"。不引入第二个 env 文件（多文件 = 新的割裂源）。

### 7.3 target 预设（代码内表格，非用户负担）

`DeployTarget.envPresets()` 返回该 target 的默认 env，注入优先级：**用户 env 文件 > target preset > schema 默认**。例如：

| 键 | local-container | local-process |
|---|---|---|
| `PTH_PYTHON_MODE`/`PTH_BASH_MODE` | `sandbox-kernel` | `sandbox process`→`sandbox-kernel`；`none`→`kernel` |
| `PTH_EXEC_SANDBOX_ALIAS` | `on` | `process`→`on`；`none`→`off` |
| `SANDBOX_URL`/`PTH_SANDBOX_KERNEL_URL` | `http://sandbox:8080` | `http://127.0.0.1:8080` |
| `PTH_CONFIG_STRICT` | `1` | `0` |
| `PTH_WORKSPACES_PATH` | `/data/workspaces` | `$PTH_WORKSPACES_HOST` 同值 |

预设只覆盖 target 差异键；~100 键的其余默认值不动（schema 仍是唯一真相源——preset 不进 schema，避免双源）。

## 8. CLI 面变化汇总

```
pth init [--generate] [--workspaces <path>] [--force]
pth doctor [--target T] [--profile P]            # 新增 container-runtime / 外部数据层探活项
pth up   [--target local-container|local-process] [--profile P] [--sandbox process|none]
         [--runtime desktop|orbstack|colima|...] [--with a,b] [--without a,b]
pth down / status 同上（target 感知）
```

- 无 `--target` 的一切既有命令行为逐字节保留（含 npm 包用户的 `pth init && pth up` 流程）；
- `pth config` 输出增加 target preset 来源标注（`source` 增 `preset` 一档，ConfigCenter.explain 兼容扩展）。

## 9. `pth.deployment.json` 处置（决策点）

建议：**删除文件**，`check-pth-config.ts` 覆盖率对照只留 `docker-compose.yaml`，`deployment.md §6` 历史注记同步更新为"已移除"。
理由：它已无任何运行时消费者，保留即双源维护成本；v2.0 若重启声明式渲染（k8s/remote），届时以编译 engine 的新部署面重新设计，不继承此文件。
备选：保留作覆盖率对照（现状）。→ 实施前需用户拍板。

## 10. 测试策略

- `detect.ts`：纯函数解析 `docker info`/context 输出 → 表驱动单测（各运行时指纹 fixture）；
- `local-process` supervisor：注入 fake runner/spawn，pidfile 生命周期、SIGTERM→SIGKILL 升级、健康超时；
- 编排层：现有 orchestrator 测试 seam（deps 注入）不变，新增 target 维度参数化用例；
- `init --generate`：密钥强度/长度断言、文件权限 600、幂等/`--force`；
- 组件兼容矩阵：非法组合报错文案快照；
- 集成冒烟（手工/可选）：OrbStack 与 Colima 各跑一次 `pth doctor`；local-process 起 core + 提交 hello 任务。

## 11. 实施 Wave 划分（规划，不在本期执行）

- **W0 配置简化**：init --generate + workspaces 收口 + env 文件注释更新（无 target 概念也能独立落地）；
- **W1 target 抽象**：targets/types + local-container 搬入（行为零变化为验收线）+ doctor container-runtime 检测；
- **W2 运行时适配**：Colima host-gateway 检查项、--runtime 覆盖、apple-container 显式报错；
- **W3 local-process**：supervisor + sandbox process/none + 外部数据层探活 + preset 表 + 兼容矩阵；
- **W4 收尾**：`pth.deployment.json` 处置（待拍板）、deployment.md 重写、docs manifest 更新、全量串行测试。

## 12. 冻结项 / 既有裁决不变

- `local-container` 默认 target；不带 `--target` = 现状行为（硬兼容约束）；
- 安全语义不降级：secrets 必填、协议校验、strict 模式行为在 container target 下逐字节保留；local-process 的隔离缺失以显式声明而非隐式放松呈现；
- remote-docker / k8s / podman / 生产级拓扑：**v2.0 冻结**（编译 engine 重写时一并设计）；
- `runtime-profiles.json` profile 语义与组件清单不动；
- PTH 执行模式（tool-call/asp/ptc/pulse）、human_requests 契约等既有裁决与本设计无交集，不受影响。
