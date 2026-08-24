# FRACTA engine backlog —— 待办设计方案

> 状态：**设计提案（未实现）**。收录 2026-08-22 P6-10/lean4/legacy 清理批/GHCR 钉版完成后
> 的全部已知待办；每项给出问题、方案草案、影响面与验收口径。实现后请回填结果并把条目移入
> `docs/fracta-engine-execution-topology.md` 的相应矩阵。
>
> 同源纪律：本文与 `fracta-engine-execution-topology.md` 一样，三仓（deps/pth/ptl）保持一致。

条目编号规则：`A` = 清理批直接收尾，`B` = 本轮实跑新暴露，`C` = 历史 backlog。

---

## A1. 全量测试基线 ✅（2026-08-22 收口）

- **问题**：`npx vitest run` 全量曾 600s 无输出被 kill；受影响面绿不等于全量绿。
- **方案**（已落地）：
  1. 全量可跑完（不再超时），基线为 **2662 总用例：2610 通过 / 43 失败 / 9 跳过**；
  2. 43 个失败全部来自 5 个无条件运行的集成/单元文件，非产品代码缺陷：
     `assembly-engineer / computational-chemist / lean4-prover / technical-educator`
     四个 professional 集成（缺外部工具链容器）+ `tool-containers`（GHCR 钉版后
     单元测试断言过期）；
  3. 给四个 professional 集成加 `PTH_PROFESSIONAL_INTEGRATION=1` 门控（默认 skip，
     真集成时显式开）；`tool-containers` 测试改为「去 digest 副本验证 fail-closed」。
- **验收**：`npm run test` 默认全量绿；`PTH_PROFESSIONAL_INTEGRATION=1` 时集成照常执行。

## A2. sandbox 池容量 ✅（2026-08-22 决策：保持 24）

- **问题**：compose 默认 `PTH_KERNEL_POOL_SIZE=24`，与 live 负载是否匹配需确认。
- **决策**：保持默认 **24/语言**（python/bash 各 24）；当前 batch worker 约 15，
  1.6x 余量足够，不调值。
- **护栏**：配置参量护栏另立 C11，本次不扩大默认值。

## B4. 宿主服务自恢复（launchd 托管）✅

- **状态**：✅ 已完成（2026-08-22；`pth-cli@1.6.5`）
- **问题**：宿主机重启后 local-lean/local-u8（宿主常驻进程）不自动恢复（2026-08-22 实证：
  容器靠 restart policy 回来，宿主服务需手动 `pth up`）。
- **方案**（草案）：
  1. `pth services install <id>`：读 `deploy/services/<id>/service.json`，生成
     `~/Library/LaunchAgents/com.awayfrom.pth.<id>.plist`——`ProgramArguments` = manifest
     command（解析 `pth` 真实路径），`EnvironmentVariables` = secrets 文件注入的
     `tokenEnv` + `PTH_WORKSPACES_HOST` + `pathDirs` 合成的 PATH，`KeepAlive=true`、
     `RunAtLoad=true`、日志指到 `~/.pi-triple/logs/services/<id>.log`；
  2. `pth services uninstall <id>` 对称移除；`pth services status` 同时显示「监督器视图」与
     「launchd 视图」，避免双托管打架（同一时刻只允许一种托管，install 前要求先 `services down`）;
  3. Linux 等价物（systemd user unit）同接口后置实现，先满足 macOS 主力场景。
- **影响面**：`src/pth/services/*`（新子命令），不动 supervisor 现有 spawn 语义。
- **验收**：重启宿主机后 60s 内 `pth status --all` 四个 runtime 全注册，无需手工干预。

## B5. engine 与 postgres 启动竞态 ✅

- **状态**：✅ 已完成（2026-08-22；engine 镜像重建验证）
- **问题**：宿主重启后 pi-platform 先于 postgres 就绪启动 → kernel 装配失败
  （`Connection terminated unexpectedly`），`/kernel/*` 503，需手动 `docker restart` 恢复。
- **方案**（二选一，倾向 a）：
  - a. **engine 侧自愈**：kernel 装配失败进入重试环（指数退避，上限如 60s×10），装配成功后
    `/kernel/*` 自动转 200；healthcheck 保持现状（进程活着即容器不重启，避免重启风暴）；
  - b. **compose 侧门控**：pi-platform 的 `depends_on: postgres: condition: service_healthy`
    已存在的话，问题在 postgres「healthy 但连接仍被断」的窗口——需把 pg 的 healthcheck 改成
    真实 `pg_isready` + 认证探测。
- **影响面**：a = `src/pth/bootstrap/*` 装配路径；b = `deploy/docker-compose.yaml`。
- **验收**：`docker stop/start postgres` 或宿主重启后，不手工干预，`/api/v1/kernel/status`
  在 ≤2min 内回到 200。

## B6. 全局 `pth` 的安装形态 ✅

- **状态**：✅ 已完成（2026-08-22；`npm i -g --prefix ~/.npm-global @away_from/pth-cli@1.6.5` 验证）
- **问题**：当前 `/usr/local/bin/pth` 是仓内 `dist/cli/pth-cli.js` 的软链；
  `npm run clean` 或移动仓库即失效。
- **方案**：改用 `npm i -g @away_from/pth-cli@<ver>`（已发布 1.6.4）作为标准安装；
  仓内开发用 `npm link` 显式声明。文档（README + POSITIONING）写明两种形态与取舍。
  注意：pth-cli 的 `deploy/` 随包发布，`PTH_SERVICES_DIR` 等默认路径基于包目录，需验证
  全局安装后 services/tools 清单解析仍正确（当前 live 验证基于仓内路径）。
- **影响面**：文档 + 一次安装验证；不改代码（若路径解析有问题再补 `PTH_*_DIR` env 覆盖）。
- **验收**：干净环境 `npm i -g @away_from/pth-cli` 后 `pth doctor --profile full` 可用。

## B7. tools 钉版默认策略 ✅

- **状态**：✅ 已完成（2026-08-22；决策 = 有 digest 默认用钉版）
- **问题**：GHCR digest 已钉版，但 `pth tools up` 默认本地构建，钉版镜像只在显式 `--pull`
  时使用；钉版成果默认不生效。
- **方案**（需拍板，倾向 b）：
  - a. 维持现状，文档写明「生产用 `--pull`」；
  - b. `pth tools up` 默认行为改为：manifest 有 digest → 用钉版镜像；无 digest → 本地构建；
    `--build` 强制本地重建，`--pull` 强制拉取（语义不变，只是默认值随钉版状态变化）；
  - c. 增加 `pth tools pin-status` 提示当前钉版/漂移（镜像 digest vs manifest digest）。
- **影响面**：`src/pth/tools/cli.ts`（`toolsUp` 默认分支）。
- **验收**：钉版状态下冷启 `pth tools up` 直接跑 GHCR 镜像；`pth tools verify` 通过。

## B8. `pth status --all` 的 jupyter 显示 ✅

- **状态**：✅ 已完成（2026-08-22；`pth-cli@1.6.5`）
- **问题**：jupyter 行显示 `compose compose -`，无健康态（它是独立 compose project，
  不走 core compose ps）。
- **方案**：status 聚合时对 jupyter 单独跑 `docker compose -p pi-triple-jupyter ps --format json`
  + 南面 `:8889/health` 探测（容器内或经 engine backend 注册表），输出
  `running/healthy + 北面 8888 可达性`。
- **影响面**：`src/cli/runtime/runtime-orchestrator.ts`（orchestrateStatusAll）。
- **验收**：`pth status --all` jupyter 行与 `docker compose -p pi-triple-jupyter ps` 一致。

## B9. adversarial 审核链派发断裂（2026-08-24 理论推导实证）

- **问题**：`system-triggers.ts` 的 skill/tool 提案审核 trigger 只带 `tags:["adversarial"]`
  无 role 字段；`adversarial` 注册为 governance 类标签（不参与 routeRole），
  `checkTaskRouting` 实测返回「缺少角色标签」拒绝发布，trigger-engine 捕获后记日志跳过——
  **审核任务永远发布不出去**，对抗性审核链静默空转。
- **方案**（草案）：两个 trigger 定义补 `role: "controller:adversarial"`（flow 显式派发，
  与 governance 标签语义一致——memory-sweep-trigger 同款）。
- **影响面**：`packages/pth-kernel-execution/src/execution/system-triggers.ts`（一行级 ×2）。
- **验收**：提案事件触发后审核任务真实落池且路由到 controller:adversarial；回归测试覆盖。
- **出处**：`docs/pth/report/role-lineage-runtime-derivation.md` 回路 C1。

## B10. 观测-调节调度源缺失（2026-08-24 理论推导实证）

- **问题**：全仓没有任何 trigger/调度器向 sensor:*（七观测点）/controller:*（九调节点）
  派单；治理角色不走 delegate、派发需 flow 显式 role——sensor/controller 只能等操作者
  手工 API 派单，**观测回路不是自闭环**，D2 分化裁决（controller:worker-opt）随之空转。
- **方案**（草案）：观测巡检调度机制（memory-sweep-trigger 同构——定期/按 A/B 周期
  n 轮边界向观测点与调节点派单）；调度周期与点位覆盖策略待定（全点位逐一派单 vs
  根角色派单后族内下分——后者依赖 A5 delegate 软约束，倾向前者）。
- **影响面**：`system-triggers.ts`（新增 schedule trigger 族）或新 trigger 模块；
  与 controller:router 实装、A/B 优化周期落地同属治理回路自闭环工作流。
- **验收**：sensor 七点位/controller 九点位按周期自动收到观测/调节任务并产出
  observation-report / modification-plan。
- **出处**：`docs/pth/report/role-lineage-runtime-derivation.md` 回路 B1/D2。

## C9. P5 体验收尾（三小项）✅

- **状态**：✅ 已完成（2026-08-22；裸表达式 value 捕获 + interrupt 文案 + execute_result 渲染）
- **问题**：
  1. python 裸表达式 cell（`x=1+2; x`）notebook 执行返回空 stdout（`print` 正常）；
  2. JupyterLab 内 interrupt 交互未定稿；
  3. pi-kernel 表达式回显样式待打磨。
- **方案**：
  1. 南面 nbclient/execution 通道改用「表达式值捕获」：最后一个表达式语句走
     `eval` 语义取 completion value（对齐 sandbox-kernel 的 `single/program/auto` 三模式，
     复用现有 `x-sandbox-kernel-exec` 语义），而非只收 stdout；
  2. interrupt 映射到 engine notebook cancel（P5d 已有端点）+ Lab 前端按钮态收敛；
  3. pi-kernel 侧按 `value` 类型分级渲染（标量/容器/错误），样式走 ptl 设计系统。
- **影响面**：jupyter 南面执行桥 + pi-kernel provider（ptl）+ engine notebook facade。
- **验收**：`x=1+2; x` 回 `3`；Lab interrupt 后 cell 标记 cancelled 且会话可继续；
  表达式回显样式过 ptl 视觉走查。

## C10. doctor 端口探针加固 ✅

- **状态**：✅ 已完成（2026-08-22；`pth-cli@1.6.5`）
- **问题**：OrbStack(macOS) 下 3000 已被 pi-platform 占用，doctor 仍报「空闲」
  （bind 探测语义与 Docker 端口代理行为不一致）。
- **方案**：端口探测从「尝试 bind」改为「尝试连接 + 可选 HTTP 指纹」：
  连不上 = 空闲；连上且响应匹配已知服务 = 占用并标注归属；连上但不明协议 = 占用（未知）。
  对 `:?` 必填端口（如 `PTH_WORKSPACES_HOST` 类配置）保持阻断语义。
- **影响面**：`src/cli/runtime/runtime-doctor.ts`。
- **验收**：栈运行中 `pth doctor --profile full` 对 3000 报「占用（pi-platform）」而非空闲；
  栈停止时报空闲。

## C11. 配置参量护栏 ✅（2026-08-22 A2 新立；首批已落地）

- **状态**：✅ 首批已完成（2026-08-22；`pth-cli@1.6.5` / `pth-sandbox@1.6.2`）
- **问题**：`PTH_CONFIG_SCHEMA` 的 `d()` 仅声明类型/默认值/描述，无 `min/max` 元数据；
  sandbox 侧 `posNum()` 只做「非正/非数字回退默认」，没有上限校验——写 `PTH_KERNEL_POOL_SIZE=100000`
  会真的尝试建 10 万条池条目；doctor 也不检查「池容量 vs batch worker 数」等合理性。
- **方案**：
  1. `d()` 增加可选 `min/max`（数字键）与 `pattern`（字符串键）元数据；
  2. 启动/`pth doctor` 对越界配置 fail-closed 或显式阻断提示（敏感/必填键 fail-closed，
     可选键 warn+回退默认）；
  3. 首批覆盖 `PTH_KERNEL_POOL_SIZE`（min=1, max=256）、`PTH_COMPILED_CONCURRENCY`、
     `PTH_BATCH_MIN/MAX`、`PTH_DEBUG_SESSIONS` 等资源型参数；
  4. compose 注释同步写默认值与护栏范围。
- **影响面**：`src/pth/config/schema.ts`、`src/cli/runtime/runtime-doctor.ts`、
  `packages/pth-sandbox/src/config.ts`、`deploy/docker-compose.yaml`。
- **验收**：越界配置（如 pool=0 / pool=100000）在 doctor/启动时被明确拒绝或回退并告警；
  合法范围内行为不变。

---

## 已完成项（本批之前回填）

- ~~N28 复验~~：2026-08-22 重新验收 **GO**（`docs/pth/n28-feasibility-envelope.json`；
  恢复 35 文件 typecheck；P0/P1 修复全部红→绿）。
- ~~N29 复验~~：2026-08-22 重新验收 **MIN_INNER_LOOP_GO**（`docs/pth/n29-minimal-intake-acceptance.json`；
  D-5 签名 acceptance envelope + 启动验签；默认 `PTH_KNOWLEDGE_INTAKE_MODE=off` 保持）。
- ~~legacy `/kernel/*` 租约路由清理~~：2026-08-22 完成（`@away_from/pth-sandbox@1.6.1`，
  live 六路由 404 + /sessions 全链路绿）。
- ~~GHCR release~~：2026-08-22 完成（三域多架构推送 + digest 钉版 + live `--pull` 切换）。
- ~~operator token 累积~~：2026-08-22 完成（P6-10 种新收旧 + 一次性清史；
  `@away_from/pth-console@1.6.2` / `@away_from/pth-cli@1.6.4`）。
- ~~lean4 runtime 未注册~~：2026-08-22 完成（elan 入 PATH + local-lean 重启，
  注册态 `assembly, lean4, jupyter, u8`）。
- ~~A1 全量测试基线~~：2026-08-22 完成（默认全量 2662 用例 0 失败；professional 集成
  `PTH_PROFESSIONAL_INTEGRATION=1` 门控）。
- ~~A2 池容量~~：2026-08-22 决策保持 24/语言；护栏 C11 落地。
- ~~B4 launchd 自恢复~~：2026-08-22 完成（`pth services install/uninstall`；非 GUI 会话如实报错）。
- ~~B5 engine↔pg 竞态~~：2026-08-22 完成（指数退避重试；live 停 pg 启动自愈）。
- ~~B6 全局 pth 安装形态~~：2026-08-22 完成（`--prefix ~/.npm-global` 验证；
  `pth doctor/services` 路径解析正确；标准流程需 `pth init`）。
- ~~B7 tools 钉版默认策略~~：2026-08-22 完成（有 digest 默认用钉版；live 验证）。
- ~~B8 status jupyter 显示~~：2026-08-22 完成（compose ps + secrets 插值，显示 running/healthy）。
- ~~C9 P5 体验三小项~~：2026-08-22 完成（裸表达式 value 捕获；interrupt 文案；
  execute_result 渲染）。
- ~~C10 doctor 端口探针~~：2026-08-22 完成（TCP connect + HTTP 指纹；3000 报占用 pi-platform）。
- ~~C11 配置参量护栏~~：2026-08-22 首批完成（schema min/max + doctor warn + sandbox clamp）。
