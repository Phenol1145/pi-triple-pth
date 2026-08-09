# PTH 开发模式（dev loop——秒级反馈）

> 改代码 → tsx watch 自动重启（主进程 + batch）→ 立即验证——**秒级循环**（免 rebuild）。
> 依据：[修改流程优化实施计划](../superpowers/plans/2026-08-10-pth-dev-loop-speedup.md)。

---

## 启动 dev 模式

```bash
# dev 模式（tsx watch——改 src 秒级热重启）
docker compose -f docker-compose.yaml -f docker-compose.dev.yaml up -d pi-platform

# 首次需 build dev 镜像（devDeps——tsx/typescript）
docker compose -f docker-compose.yaml -f docker-compose.dev.yaml build pi-platform
```

## 开发循环

```
1. 改 src/pth/kernel/...（host——自动同步到容器（src 挂载））
2. tsx watch 检测文件变化 → 自动重启主进程（~1-2s）+ batch 重新 spawn（tsx——PTH_BATCH_TS=1）
3. 立即验证：curl /health / 提交任务 / 看日志
→ 改 → 等 ~1-2s → 验证（秒级循环——免 rebuild）
```

## 验证热更新生效

```bash
# 看 tsx watch 重启
docker logs pi-platform-pi-platform-1 2>&1 | grep kernel_assembled

# 确认 batch 是 tsx（Kernel 代码热更新）
docker exec pi-platform-pi-platform-1 sh -c 'for p in $(ls /proc/ | grep -E "^[0-9]+$"); do cmd=$(tr "\0" " " < /proc/$p/cmdline 2>/dev/null); echo "$p: $cmd"; done | grep batch-process'
# → 应显示：node --import tsx src/pth/kernel/execution/batch-process.ts
```

## 切回生产模式

```bash
# 生产（普通 compose——rebuild 后跑——dist 编译产物）
docker compose up -d pi-platform        # 或 build + up（改了代码要 rebuild）
```

## 已知边界（dev 模式的代价——接受）

1. **执行中任务中断**：tsx watch 重启 → 运行中的 agent 任务中断（调试完切生产跑长任务）
2. **sandbox 容器**：改 sandbox 源码（src/sandbox/）仍需 rebuild sandbox 容器（dev 挂载只挂 pi-platform）
3. **数据面保留**：pg/redis/卷不受 dev 重启影响
4. **生产隔离**：dev 仅开发（生产用普通 compose——dist 运行——不改生产语义）
