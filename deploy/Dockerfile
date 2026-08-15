# ---- Builder stage ----
FROM node:22-slim AS builder

WORKDIR /app

# 依赖清单先行（GPT 文档 P0-②——源码变化不失效依赖层——npm ci 缓存命中）
COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
# npm workspaces（所有包的 package.json——workspace 链接必需）
COPY packages/shared/package.json packages/shared/
COPY packages/infra/package.json packages/infra/
COPY packages/framework/package.json packages/framework/
COPY packages/mailbox/package.json packages/mailbox/
COPY packages/pth-memory/package.json packages/pth-memory/
COPY packages/pth-sandbox/package.json packages/pth-sandbox/
COPY packages/dev-container/package.json packages/dev-container/
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
# npm workspaces（所有包的 package.json——workspace symlink 必需）
COPY --chown=node:node packages/shared/package.json packages/shared/
COPY --chown=node:node packages/infra/package.json packages/infra/
COPY --chown=node:node packages/framework/package.json packages/framework/
COPY --chown=node:node packages/mailbox/package.json packages/mailbox/
COPY --chown=node:node packages/pth-memory/package.json packages/pth-memory/
COPY --chown=node:node packages/pth-sandbox/package.json packages/pth-sandbox/
COPY --chown=node:node packages/dev-container/package.json packages/dev-container/
RUN npm ci --omit=dev

# 仅拷入各包构建产物（不拷源码/test/tsconfig/TODO——减小镜像体积+攻击面）
COPY --chown=node:node --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --chown=node:node --from=builder /app/packages/infra/dist ./packages/infra/dist
COPY --chown=node:node --from=builder /app/packages/framework/dist ./packages/framework/dist
COPY --chown=node:node --from=builder /app/packages/mailbox/dist ./packages/mailbox/dist
COPY --chown=node:node --from=builder /app/packages/pth-memory/dist ./packages/pth-memory/dist
COPY --chown=node:node --from=builder /app/packages/pth-sandbox/dist ./packages/pth-sandbox/dist
COPY --chown=node:node --from=builder /app/packages/dev-container/dist ./packages/dev-container/dist

COPY --chown=node:node --from=builder /app/dist ./dist
# 自修改（v1）：容器带源码只读面（worker readSource 读 src/ 修改 PTH 自己——dist 运行 + src 可读）
COPY --chown=node:node src/ ./src/

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
