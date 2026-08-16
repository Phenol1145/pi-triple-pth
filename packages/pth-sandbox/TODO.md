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

- [ ] HIGH：Python 记忆桥 space 盖章改为请求层带外注入（程序不可伪造）→ **S0-1**
  - 现状：`_PTH_SPACE`/`PTH_MEMORY_SPACE` 仍在任务可写命名空间/env；body 自报 space 在 PTH 侧已被拒，但盖章本身是软治理
- [ ] HIGH：web.fetchText DNS rebinding 防护（与出站网络策略协同；字面量防护已上）→ **S0-2**
- [ ] MEDIUM：kernel 池容量/回收/TTL 观测（N5 资源环 L3）→ **S1-1**
  - 已部分实现：`/kernel/status` + `obs.kernels()` 存在；缺 `obs.resource()` 聚合与池计数器
- [ ] MEDIUM：编译核 cache 磁盘上限/并发策略复核；gdb 会话上限与 idle 回收复核 → **S1-2 / S1-3**
  - 已实现：cache maxEntries/maxBytes/磁盘淘汰/并发信号量、gdb 会话上限+30min idle 回收
  - 残余：cache key 不含 compiler 身份；gdb 会话 id 竞态与 GDB MI pending 关联
- [ ] MEDIUM：web.fetchText 改流式限量（下载完再判超限）→ **S0-3**
- [ ] MEDIUM：sandbox exec-api / kernel-host 健康与 degraded 路径观测 → **S1-5**
  - 已部分实现：PTH 侧 degraded 监控（`sandbox-bash.ts` + `routes-self.ts`）；sandbox 侧缺 degraded 状态
  - liveness/readiness 拆分不在此项（归 v2 P2-6）
- [ ] LOW：readSource/toolstore symlink 防线（涉及沙箱文件面）→ **S0-4**（与 `packages/pth-memory/TODO.md` 同一行协同）
- [ ] LOW：sandbox-bash 与 kernel-host 协议文档/命名一致性 → **S2-1**

## 评估结论（2026-08-15 拆分后；2026-08-16 补账）
- 本包项全部**保留**：H8/H9 安全纵深最高优先；N5 资源环 L3 与编译核/gdb 容量复核次之；无砍项。
- 补账结论：8 项中 2 项已有部分实现（编译核/gdb、健康观测）——按残余缺口拆入计划，不重做已有部分。
