# PTH 部署 target 与配置简化实施计划

> 状态：**待实施**（设计已审订，本文档为唯一实施依据）
> 设计文档：`docs/pth/deploy-targets-and-config-simplification-design.md`（概念模型/矩阵/裁决以此为准）
> 分支：`feat/pth-exec-unified`（继续沿用，不另开分支）
> 已拍板决策（用户 2026-08-27）：
> 1. **`deploy/pth.deployment.json` 直接删除**（W4 执行；不保留、不迁移，check-pth-config 对照源只留 compose）；
> 2. 本期 target 仅 `local-container`（默认）+ `local-process`；remote-docker / k8s / podman 冻结至 v2.0；
> 3. 计划先行、按 wave 实施，每 wave 独立提交。

## 0. 全局约束与验收基线

### 0.1 硬约束

- **行为兼容**：不带 `--target` 的 `pth init|up|down|status|doctor|logs` 与现状逐字节一致。
  唯一例外：W0 的 `pth init` 默认开启密钥自动生成（本期需求本身）；旧行为由 `--no-generate` 保留。
- **现有测试零改动通过**：W1/W2 验收线 = `test/pth-cli/*.test.ts` 现有用例一行不改全绿
  （orchestrator/doctor/secrets/profiles 的 deps 注入 seam 不破）。
- **不新增生产依赖**：ioredis（root deps 已有）用于 local-process token 播种；其余全用 node 内建。
- **type-only import 纪律**：source 仅导出类型时必须 `import type`（fork 子进程 strip-types 崩溃教训，
  见 `e73786e`）。
- **monorepo 边界**：新代码在 `src/cli/runtime/`（src 侧可依赖 packages/\*；packages 不得反向依赖 src）。
- **提交规范**：`feat(cli): …`；文档 `docs(pth): …`；每 wave 一提交（W3 允许拆二）。

### 0.2 每 wave 验收命令

```bash
npm run lint                                # 全量静态检查（含边界/环/配置/文档链接）
npx vitest run test/pth-cli                 # 本特性域测试
```

W4 收尾追加全量串行基线：`npm test -- --maxWorkers=1`
（当前基线：314 文件通过 / 5 跳过 / 2728 测试，约 445s）。

### 0.3 已核事实（计划依据，实施时直接引用）

- token 播种格式（`packages/pth-console/src/launcher.ts` `seedOperatorToken`）：
  `SET auth:token:<token>` 值 `{"tenantId":<tenant>,"role":"platform-admin","source":"pth-operator"}`；
  播种同时回收同 tenant 的其他 `source=pth-operator` token（扫描 → 过滤 → DEL，回收失败不阻断）。
- `ConfigSource = ["default","env","runtime","file","unknown"]`（`packages/pth-contracts/src/system-inspection.ts`）。
- doctor 现有端口检查仅 `port-3000`；sandbox 8080 探活走 `compose exec`（容器路径）。
- 全仓库无任何脚本/代码依赖 example 里的 `dev-only-change-me-*` 值（已 grep 确认）——W0 自动生成无破坏面。
- launcher（init/up/down/status/logs）当前**无测试文件**；测试集中在 `test/pth-cli/runtime-*.test.ts`。
- `packages/pth-sandbox/src/main.ts` 是独立 server 入口；`PTH_COMPILED_CACHE_DIR` schema 默认
  `/data/compiled-cache/c`（容器路径，local-process 必须 preset 覆盖）。
- npm CLI 包（`scripts/build-pth-cli-package.sh`）**不含** engine 与 pth-sandbox 的 dist
  → local-process v1 仅支持仓库 checkout（见 W3.7 边界）。

---

## W0 配置简化：`pth init --generate` + `PTH_WORKSPACES_HOST` 收口

**目标**：`pth init` 之后零手改即可 `pth up`（local-container）；密钥全部强随机；宿主路径进 env 文件。

### 任务

1. **`packages/pth-console/src/launcher.ts`**
   - 新增导出纯函数：
     ```ts
     export function renderSecretsFile(exampleText: string, opts: {
       generate: boolean;                      // false = 现状复制（--no-generate）
       workspacesHost?: string;                // 已解析的绝对路径；undefined = 不写入
       randomHex?: (bytes: number) => string;  // 默认 crypto randomBytes，测试注入
     }): string
     ```
     逐行处理 example 文本：7 个密钥键（`SANDBOX_SHARED_SECRET` / `PTH_EXECUTION_GRANT_SECRET` /
     `PTH_MEMORY_BRIDGE_TOKEN` / `POSTGRES_PASSWORD` / `REDIS_PASSWORD` /
     `LOCAL_EXEC_SHARED_SECRET` / `JUPYTER_SERVICE_TOKEN`）的值替换为 `randomHex(32)`（64 hex，
     满足 strict 全部长度线）；注释行/空行原样保留；`workspacesHost` 提供时追加段：
     ```
     # ── 宿主路径（非密钥）──
     PTH_WORKSPACES_HOST=<path>
     ```
   - `init()` 接线：flags `--no-generate`（默认 generate=on）、`--workspaces <path>`。
     workspaces 解析序：`--workspaces` > 环境 `PTH_WORKSPACES_HOST` > TTY 交互提示
     （`node:readline/promises`）；`~` 展开为 `os.homedir()`；校验绝对路径
     （posix `/` 开头或 win 盘符）。**非 TTY 且无任何来源 → 报错并附示例**（设计 §7.1）。
   - init 输出尾部追加待办提示：`local-process 需另填 DATABASE_URL / REDIS_URL`（统一打印，
     init 不感知 target）。
   - 保留 `--force` 语义；chmod 600 不变。
2. **`deploy/.env.pth.secrets.example`**：文件头注释改为"统一环境文件（密钥 + 宿主本地路径）"；
   尾部新增注释掉的 `# PTH_WORKSPACES_HOST=` 占位行（说明 compose `:?` 必填、init 自动写入）。
3. **`src/cli/runtime/runtime-doctor.ts`**：`PTH_WORKSPACES_HOST` 检查改为 env 优先、
   secrets 文件回退（复用 `runtime-secrets.ts` 的 `parseSecretsEnvFile`/`loadSecretsFile`）；
   fix 文案改为 `pth init --workspaces <abs-path>`（替代 export 提示）。
4. **orchestrator 无需改动**：secrets 注入子进程 env（`injectSecrets` 全量注入，workspaces 键随行），
   compose `--env-file` 自身也解析——两条通道同源。实施时以手工验证确认（见验收）。

### 测试

- 新 `test/pth-cli/launcher-init.test.ts`（launcher 首个测试文件）：
  `renderSecretsFile` 表驱动——① 7 键全部替换且 64-hex；② 无 `dev-only-change-me` 残留；
  ③ `generate:false` 文本原样；④ workspaces 追加/省略两分支；⑤ 注释与空行保留；
  ⑥ `~` 展开与非绝对路径报错（init 参数解析层，可用 fake 依赖）。
- `test/pth-cli/runtime-doctor.test.ts` 追加：env 缺失但 secrets 文件含 `PTH_WORKSPACES_HOST` → pass；
  两者皆缺 → fail 且 fix 文案含 `pth init --workspaces`。

### 验收

```bash
mv deploy/.env.pth.secrets /tmp/backup.env   # 保护现场
npm run build && node dist/cli/pth-cli.js init --workspaces /tmp/pth-ws
grep -c "dev-only-change-me" deploy/.env.pth.secrets   # 期望 0
stat -f "%Lp" deploy/.env.pth.secrets                   # 期望 600
grep -q "^PTH_WORKSPACES_HOST=/tmp/pth-ws" deploy/.env.pth.secrets
unset PTH_WORKSPACES_HOST; node dist/cli/pth-cli.js doctor   # workspaces 项 pass（读文件）
# 恢复：mv /tmp/backup.env deploy/.env.pth.secrets
```

### 提交

`feat(cli): pth init 自动生成强随机密钥并收口 PTH_WORKSPACES_HOST`

---

## W1 deploy target 抽象 + local-container 搬入 + 运行时检测

**目标**：引入 target 概念与容器运行时指纹检测；默认路径行为零变化（现有测试不改一行全绿）。

### 任务

1. **新 `src/cli/runtime/targets/types.ts`**
   ```ts
   export type DeployTargetId = "local-container" | "local-process";
   export interface TargetContext {
     repoRoot: string; env: NodeJS.ProcessEnv; envFile: string;
     runner: CommandRunner;            // 复用 runtime-orchestrator 的类型（移入本文件并 re-export）
     timeoutMs: number; log: (line: string) => void;
   }
   export interface DeployTarget {
     readonly id: DeployTargetId;
     envPresets(opts: { sandbox: "process" | "none" }): Record<string, string>;
     upData(ctx: TargetContext, services: readonly string[]): Promise<void>;
     down(ctx: TargetContext, forward: string[]): Promise<void>;
     engineUp(ctx: TargetContext, forward: string[]): Promise<void>;
     statusData?(ctx: TargetContext): Promise<string[]>;   // 额外状态行
   }
   ```
   `CommandRunner` 等共享类型迁入本文件，`runtime-orchestrator.ts` 改为 import（保持 re-export 兼容现有测试 import 路径——先查测试 import 了什么再定 re-export 面）。
2. **新 `src/cli/runtime/targets/local-container.ts`**：现状编排逻辑原样搬入
   （compose argv 构造、`waitHealthy`、`runPthUp` 委托）。`envPresets()` 返回
   `{ PTH_PYTHON_MODE: "sandbox-kernel", PTH_BASH_MODE: "sandbox-kernel", PTH_EXEC_SANDBOX_ALIAS: "on", PTH_CONFIG_STRICT: "1" }`（与 compose 现状一致的静态值；container 下不真正注入，仅供 status/config 展示——**W1 不接线 preset 注入**，见 §W3）。
3. **新 `src/cli/runtime/targets/detect.ts`**
   ```ts
   export type ContainerRuntime = "docker-desktop" | "orbstack" | "colima"
     | "rancher-desktop" | "docker-generic" | "apple-container" | "none";
   export function classifyContainerRuntime(input: {
     dockerAvailable: boolean; contextName?: string; socketPath?: string;
     infoOperatingSystem?: string; appleContainerAvailable: boolean;
   }): ContainerRuntime
   export async function detectContainerRuntime(runner: CommandRunner): Promise<{
     runtime: ContainerRuntime; evidence: string[];
   }>
   ```
   检测序：`docker version`（不可用 → 探 `container --version` → apple-container/none）→
   `docker context show`（orbstack/colima/rancher-desktop 前缀）→
   `docker info --format '{{json .}}'` 取 `OperatingSystem`（Docker Desktop）→
   socket 路径回退（`/.orbstack/`、`/.colima/`）→ `docker-generic` 兜底。
   指纹规则即设计 §5.1 表；全部子调用经注入的 runner（测试零进程）。
4. **`src/cli/runtime/runtime-doctor.ts`**：新增 `container-runtime` 检查项
   - 识别成功 → pass（报告 runtime + 关键 evidence）；
   - docker 不可用但 apple container 可用 → **fail**：「apple-container 无 compose/internal 网络原语，
     本期不支持；请安装 Docker Desktop / OrbStack / Colima 任一」；
   - 全不可用 → 维持现有 `docker` fail 项（不重复）。
   - `--runtime <id>` flag：覆盖检测结果（逃生舱；非法值 fail-fast 列合法值）。
5. **`src/cli/runtime/runtime-orchestrator.ts`**
   - `hasOrchestrationFlags` 增 `--target` / `--runtime`；
   - `parseOrchestratedArgs` 增 `target`（默认 `local-container`；非法值报错并列合法值）、
     `runtimeOverride`；`--target`/`--runtime` 不进 forward（加入跳过集）；
   - `orchestrateUp/Down/StatusAll` 经 `resolveTarget(parsed.target)` 取实现后分派；
     local-container 路径保持现状调用序（doctor → 数据层 → 可选组件 → engine）。
6. **`src/cli/pth-cli.ts`**：usage 文案加 `--target` / `--runtime`；`up/down/status` 的
   orchestration 判定随 `hasOrchestrationFlags` 自动获得。

### 测试

- 新 `test/pth-cli/runtime-detect.test.ts`：六类 runtime 指纹 fixture 表驱动
  （context 优先于 info 字段；docker 在时 apple 被忽略；全缺 → none）；`--runtime` 覆盖。
- `runtime-doctor.test.ts` 追加：container-runtime 三态（pass/fail-apple/沿用 docker fail）。
- `runtime-orchestrator.test.ts` 追加（**不改旧用例**）：
  `--target local-container --profile core` 与无 target 行为等价（runner 调用序列快照一致）；
  `--target bogus` 报错文案含合法值列表。

### 验收

`npm run lint` 绿；`npx vitest run test/pth-cli` 全绿（旧用例零改动）；
`node dist/cli/pth-cli.js doctor` 输出含 `container-runtime` 行且本机识别正确。

### 提交

`feat(cli): deploy target 抽象与容器运行时指纹检测（默认行为零变化）`

---

## W2 容器运行时能力适配

**目标**：能力差异落地为 doctor 检查项与修复提示（不 fork compose 文件）。允许与 W1 合并提交。

### 任务

1. `detect.ts` 增 `runtimeCapabilities(runtime): { compose: boolean; hostGateway: "yes" | "colima-caveat" | "no" }`
   静态表（设计 §5.2）。
2. doctor 新检查项 `colima-host-addressing`：runtime=colima **且** profile 含
   `local-lean`/`local-u8` 时触发（PTH_EXEC_BACKENDS 经 `host.docker.internal` 回环）：
   `colima status` 解析 host 寻址是否开启；解析失败/不可判定 → **warn**（不误伤）；
   明确未开启 → fail + fix `colima stop && colima start --network-address`。
3. apple-container fail 文案补全（若 W1 已含则此处只加测试）。
4. `--runtime` 贯通：orchestrator 传给 doctor（up 前体检与独立 doctor 同源）。

### 测试

- doctor：colima 三态（开/warn/fail）与非 colima 不触发；profile 不含 lean/u8 不触发。
- 能力表快照测试。

### 验收

`npx vitest run test/pth-cli` 绿；`pth doctor --profile full` 在 colima 机上可见新项（手工，可选）。

### 提交

`feat(cli): 容器运行时能力检查（colima host 寻址提示 / apple-container 显式报错）`

---

## W3 local-process target

**目标**：无 Docker 单机信任域可跑 core（+lean4/u8）profile；隔离缺失显式声明。

### 任务

1. **新 `src/cli/runtime/process-supervisor.ts`**
   ```ts
   export interface SpawnDetachedOpts {
     name: string; cmd: string; args: string[];
     env: NodeJS.ProcessEnv; runDir: string;   // 默认 ~/.pi-triple/run
   }
   spawnDetached(opts): Promise<{ pid: number }>   // detached + stdio→<runDir>/<name>.log + unref + 写 <name>.pid
   stopDetached(name, opts?): Promise<void>        // SIGTERM → 5s 宽限 → SIGKILL → 清 pidfile（kill 可注入）
   detachedStatus(name): Promise<{ running: boolean; pid?: number }>  // pidfile + kill(pid, 0)
   ```
2. **新 `src/cli/runtime/token-seed.ts`**：ioredis 复刻 launcher 播种语义（§0.3 事实）：
   `SET auth:token:<token>` + 同 tenant `source=pth-operator` 旧 token 回收；client 可注入。
   与 `launcher.ts` 的 compose-exec 版本**互留注释指向**（已知双实现；统一化列 backlog，不在本期）。
3. **新 `src/cli/runtime/targets/local-process.ts`**
   - `envPresets({ sandbox })`（设计 §7.3 表，落为静态函数 + 单测快照）：
     - 公共：`PTH_CONFIG_STRICT=0`、`SANDBOX_URL=http://127.0.0.1:8080`、
       `PTH_SANDBOX_KERNEL_URL=http://127.0.0.1:8080`、`PTH_WORKSPACES_PATH=<PTH_WORKSPACES_HOST 值>`、
       `PTH_COMPILED_CACHE_DIR=<~/.pi-triple/compiled-cache/c>`（覆盖容器路径默认值）；
     - `sandbox=process`：`PTH_PYTHON_MODE/PTH_BASH_MODE=sandbox-kernel`、`PTH_EXEC_SANDBOX_ALIAS=on`；
     - `sandbox=none`：二者 `kernel`、`PTH_EXEC_SANDBOX_ALIAS=off`。
   - **PTH_EXEC_BACKENDS 程序化生成**（container 下 compose 硬编码 JSON 的 target 对应物）：
     sandbox(process 时) → `http://127.0.0.1:8080` profile `sandbox-untrusted` tokenEnv `SANDBOX_SHARED_SECRET`；
     local-lean/u8（profile 含时）→ `127.0.0.1:8787/8788` profile `host` tokenEnv `LOCAL_EXEC_SHARED_SECRET`
     **无 pathMapping**（engine 本机直跑，workspaces 即宿主路径）。
   - 数据层：`upData/down` no-op（log「外部数据层，跳过生命周期管理」）；
     doctor 增 TCP 探活（`net.connect`，2s 超时）：解析 `REDIS_URL`/`DATABASE_URL` 的 host:port，
     不可达 → fail（fix：启动本机服务或修正 URL）；缺失 → fail（fix：`deploy/.env.pth.secrets` 填两 URL）。
   - engine up：前置 `dist/pth/main.js` 存在（fix：`npm run build`）→ spawnDetached
     （env = secrets ∪ preset ∪ 生成的 PTH_EXEC_BACKENDS；preset 只填缺省键，**用户 env 文件优先**）→
     轮询 `http://127.0.0.1:3000/health` → `token-seed.ts` 播种 → 验证 `/api/v1/self/version`。
   - sandbox process：前置 `packages/pth-sandbox/dist/main.js` 存在 → spawnDetached（env 含
     三个共享密钥 + 编译缓存 preset）→ 轮询 `http://127.0.0.1:8080/ready`。
   - down：`stopDetached("pth-sandbox")` → `stopDetached("pth-engine")`（反向）。
   - doctor 端口检查：local-process 下追加 8080 占用检查（复用现有 ports 机制；container 路径不加）。
   - **首次 up 信任域声明**（一次性 stderr 醒目块：无容器隔离/零出口契约不成立/street 默认关，
     可用 `--yes-i-know` 跳过交互确认；非 TTY 缺 flag → 报错退出）。
4. **orchestrator 兼容矩阵**（设计 §6.4）：`local-process` × `tools`/`jupyter` → fail-fast
   文案含 `--without tools`；lean4/u8 放行。
5. `pth-cli.ts` usage 更新（`--target local-process`、`--sandbox`）。
6. **（可选 P2，允许裁掉）** `pth config` 的 preset 来源标注：CLI 侧对照 target preset 表渲染，
   不动 contracts `ConfigSource`（避免 contracts 变更面）。若做：仅 `configList()` 输出加列。
7. **边界声明（写入 deployment.md，W4）**：local-process v1 仅支持仓库 checkout；
   npm 全局包支持 = backlog（评估 esbuild 单文件 bundle engine+sandbox，本期不做）。

### 测试

- 新 `test/pth-cli/process-supervisor.test.ts`：fake spawn/kill——pidfile 写入/清理、
  SIGTERM→宽限→SIGKILL 升级序列、已死 pid 幂等。
- 新 `test/pth-cli/token-seed.test.ts`：fake client——SET 键值格式、回收过滤
  （同 tenant+source 才 DEL）、回收失败不阻断。
- 新 `test/pth-cli/target-local-process.test.ts`：preset 快照（process/none 两档）、
  backends JSON 生成（含/不含 lean/u8）、URL 解析（带认证/IPv6/缺端口）、兼容矩阵报错文案。
- `runtime-orchestrator.test.ts` 追加：全 mock 的 local-process up 顺序断言
  （数据层跳过 → sandbox spawn → engine spawn → seed → verify）。

### 验收

单测与 lint 绿。手工冒烟（可选）：本机起 redis/pg →
`pth init --workspaces $PWD/.ws` → 填两 URL →
`pth up --target local-process --profile core --sandbox process` →
`pth submit "return {ok:1}" --role developer` → `pth wait <id>` completed。

### 提交

`feat(cli): local-process 部署 target（supervisor/token-seed/预设/兼容矩阵）`

---

## W4 收尾：删双源 + 文档 + 全量回归

### 任务

1. **删除 `deploy/pth.deployment.json`**（已拍板）；`scripts/check-pth-config.ts` 的
   `COMPOSE_FILES` 只留 `deploy/docker-compose.yaml`；`npm run check:pth-config` 绿。
2. **`docs/pth/deployment.md`**：
   - §2 安装步骤重写（init --generate / workspaces 收口 / target 概念）；
   - 新增「部署 target」章节：local-container（运行时矩阵 + colima 注意）/ local-process
     （信任域声明、sandbox 两档、外部数据层、仓库 checkout 边界）；
   - §6 历史注记更新：`pth.deployment.json` 已移除（指向设计与本计划）。
3. 检查 `README.md` 快速开始段与 `pth init/up` 描述，同步必要处（如无则不改）。
4. `npm run docs:manifest` 重生成；**复核 `release-notes-v1.8.0.md` 条目保持
   `releases/draft`**（生成器会重分类手改条目——被重排则手工恢复，同本次）。
5. 全量串行：`npm test -- --maxWorkers=1`（对照 §0.2 基线）。
6. 设计文档状态改「已实施（W0–W4）」；本计划标「已实施」。

### 提交（允许拆二）

`chore(deploy): 移除 pth.deployment.json 双源` + `docs(pth): 部署 target 文档与状态收尾`

---

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| orchestrator 重构回归 | W1 验收线 = 现有测试零改动全绿；local-container 逻辑原样搬入不重写 |
| colima 指纹/status 解析不实 | 不可判定一律 warn 降级，绝不 fail 误伤 |
| detached 进程泄漏/端口冲突 | pidfile + kill(pid,0) 幂等；doctor 端口检查复用；down 反向序 |
| token-seed 双实现漂移 | 互留注释指向；统一化列 backlog |
| init --generate 破坏外部依赖 | 已 grep 确认无 dev-only 值依赖；`--no-generate` 保留旧行为 |
| npm 包用户误用 local-process | doctor 对 engine/sandbox dist 缺失 fail-fast 并说明「仅仓库 checkout」 |
| manifest 重生成冲掉手改条目 | W4 显式复核步骤（release-notes 条目） |

## 检查清单（实施时逐项勾选）

- [ ] W0 任务/测试/验收/提交
- [ ] W1 任务/测试/验收（现有测试零改动）/提交
- [ ] W2 任务/测试/验收/提交
- [ ] W3 任务/测试/验收（+可选 P2 决策记录）/提交
- [ ] W4 删除/文档/manifest 复核/全量串行/状态更新/提交
- [ ] 设计文档与本计划状态同步为「已实施」
