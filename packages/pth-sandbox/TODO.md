# pth-sandbox 包待办（2026-08-15 拆分归位）

> 本包维护沙箱域 + 内核契约/运行时（用户裁决：kernel 契约包含在沙箱包内）。
> 长尾逐包评估后再动手（拆分决策 D）。

## 拆分后立即要做
- [ ] 沙箱测试迁入本包 test/（sandbox-kernel* / py-kernel / bash-kernel / compiled / gdb / sandbox-bash / exec-api / kernel-host）
- [ ] Dockerfile.sandbox / deploy compose context 指向本包路径，沙箱镜像构建与部署文档同步
- [ ] sandbox 服务入口（dist/main.js）纳入 build/启动脚本

## 沙箱域长尾（归位）
- [ ] HIGH：Python 记忆桥 space 盖章改为请求层带外注入（程序不可伪造）
- [ ] HIGH：web.fetchText DNS rebinding 防护（与出站网络策略协同；字面量防护已上）
- [ ] MEDIUM：kernel 池容量/回收/TTL 观测（N5 资源环 L3）
- [ ] MEDIUM：编译核 cache 磁盘上限/并发策略复核；gdb 会话上限与 idle 回收复核
- [ ] MEDIUM：web.fetchText 改流式限量（下载完再判超限）
- [ ] MEDIUM：sandbox exec-api / kernel-host 健康与 degraded 路径观测
- [ ] LOW：readSource/toolstore symlink 防线（涉及沙箱文件面）
- [ ] LOW：sandbox-bash 与 kernel-host 协议文档/命名一致性

## 评估后待裁
- 低价值/设计储备项拆分完成后单独裁决（对照主 TODO）
