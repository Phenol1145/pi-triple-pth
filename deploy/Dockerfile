# ---- Builder stage ----
FROM node:22-slim AS builder

WORKDIR /app

# 依赖清单先行（GPT 文档 P0-②——源码变化不失效依赖层——npm ci 缓存命中）
COPY package.json package-lock.json tsconfig.json ./
# npm workspaces（packages/* 的 package.json——@pi-triple/infra 等 workspace 包链接必需）
COPY packages/shared/package.json packages/shared/
COPY packages/infra/package.json packages/infra/
COPY packages/framework/package.json packages/framework/
COPY packages/mailbox/package.json packages/mailbox/
RUN npm ci

COPY packages/ ./packages/
COPY src/ ./src/
RUN npx tsc

# ---- Runtime stage ----
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends curl \
    binutils \
    qemu-user \
    binutils-x86-64-linux-gnu \
    binutils-riscv64-linux-gnu \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV DATA_DIR=/data

# 依赖清单先行（源码/文档变化不失效依赖层——GPT 文档 P0-②）
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/infra/package.json packages/infra/
COPY packages/framework/package.json packages/framework/
COPY packages/mailbox/package.json packages/mailbox/
RUN npm ci --omit=dev

# packages 全量（源码 + 本地预编译 dist——workspace 链接后的产物——GPT 文档 P0-②：manifest 先行已保住依赖层缓存）
COPY --chown=node:node packages/ ./packages/

COPY --chown=node:node --from=builder /app/dist ./dist
# 自修改（v1）：容器带源码只读面（worker readSource 读 src/ 修改 PTH 自己——dist 运行 + src 可读）
COPY --chown=node:node src/ ./src/
# PTL（packages/framework——仓库拆分后 ptl bin 归属 framework 包，bin 文件名为 dist/pit.js——2026-08-13 N9）
COPY --chown=node:node --from=builder /app/packages/framework/dist /app/packages/framework/dist

COPY --chown=node:node config/ ./config/
# 扩展代码库 + 策略 + 命名编译单元（/data/toolstore——compose 卷持久化；空卷首挂复制镜像内容）
COPY --chown=node:node toolstore/ /data/toolstore/
COPY --chown=node:node scripts/drain.sh ./scripts/
COPY --chown=node:node scripts/seed-wiki.ts ./scripts/
RUN chmod +x scripts/*.sh

# /data 目录创建即指定属主（GPT 文档 P0-①——install -d -o node——免递归 chown）
RUN install -d -o node -g node /data/components /data/agent-dir /data/sessions /data/agent-lab /data/workspaces /data/platform /data/tenants

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

CMD ["node", "dist/pth/main.js"]
