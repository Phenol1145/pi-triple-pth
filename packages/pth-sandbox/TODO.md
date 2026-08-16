# pth-sandbox 包待办（2026-08-15 拆分归位）

> 本包维护沙箱域 + 内核契约/运行时（用户裁决：kernel 契约包含在沙箱包内）。
> 长尾逐包评估后再动手（拆分决策 D）。

## 拆分后立即要做
- [x] 沙箱测试迁入本包 test/（sandbox-kernel* / py-kernel / bash-kernel / compiled / gdb / sandbox-bash / exec-api / kernel-host）
- [x] Dockerfile.sandbox / deploy compose context 指向本包路径，沙箱镜像构建与部署文档同步
- [x] sandbox 服务入口（dist/main.js）纳入 build/启动脚本

## 沙箱域长尾（归位）

> **执行入口（2026-08-16 补账）**：以下长尾统一由
> `docs/superpowers/plans/2026-08-16-pth-sandbox-hardening.md` 承接（S0–S2）；
> 本 TODO 只记账，checkbox 待计划对应阶段完成时勾平。
> 与模块化 v2 P2 的分工：grant 化 / cancel-ack-release / 输出与进程组 / KnowledgeBroker /
> liveness-readiness / `check-sandbox-env.sh` 路径修正归 v2 P2，不在此重复。

- [x] HIGH：Python 记忆桥 space 盖章改为请求层带外注入（程序不可伪造）→ **S0-1**（`b39af0f`）
- [x] HIGH：web.fetchText DNS rebinding 防护（与出站网络策略协同；字面量防护已上）→ **S0-2**（`78d3766`）
- [x] MEDIUM：kernel 池容量/回收/TTL 观测（N5 资源环 L3）→ **S1-1**（`3c8a6f4`）
- [x] MEDIUM：编译核 cache 磁盘上限/并发策略复核；gdb 会话上限与 idle 回收复核 → **S1-2 / S1-3**（`9230788`/`eb926c6`/`7de4ec4`）
- [x] MEDIUM：web.fetchText 改流式限量（下载完再判超限）→ **S0-3**（`ef92fef`）
- [x] MEDIUM：sandbox exec-api / kernel-host 健康与 degraded 路径观测 → **S1-5**（`004e9cc`）
- [x] LOW：readSource/toolstore symlink 防线（涉及沙箱文件面）→ **S0-4**（`4a3b466`，与 `packages/pth-memory/TODO.md` 协同）
- [x] LOW：sandbox-bash 与 kernel-host 协议文档/命名一致性 → **S2-1**（`08d44bc`）

## 评估结论（2026-08-15 拆分后；2026-08-16 补账；2026-08-16 S2-5 收账）
- 8 项长尾已全部落：S0（H8/H9/流式/symlink）+ S1（N5 L3/编译核/gdb/Bash/StreamJob/degraded）
  + S2-1（命名文档）各提交见上。
- 收账后保留在计划账本的边界：hostile matrix 5/6/7 以 v2 单元测试 + P0-3 smoke 承接；
  worker 级 grant 最小接线（任务/租户级动态绑定）为下一轮架构收口项。
