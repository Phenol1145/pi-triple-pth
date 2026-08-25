# ---- Builder stage ----
FROM node:22-slim AS builder

WORKDIR /app


# 依赖清单先行（源码变化不失效依赖层——npm ci 缓存命中）
COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
# npm workspaces（全部 9 个 workspace 包的 package.json——workspace 链接必需；
# 缺任何一个都会让根 package.json 的 file: 依赖在 npm ci 时找不到目标）
COPY packages/pth-contracts/package.json packages/pth-contracts/
COPY packages/pth-config/package.json packages/pth-config/
COPY packages/pth-memory/package.json packages/pth-memory/
COPY packages/pth-sandbox/package.json packages/pth-sandbox/
COPY packages/pth-kernel-storage/package.json packages/pth-kernel-storage/
COPY packages/pth-kernel-interpreter/package.json packages/pth-kernel-interpreter/
COPY packages/pth-kernel-execution/package.json packages/pth-kernel-execution/
COPY packages/pth-console/package.json packages/pth-console/
COPY packages/pth-cli/package.json packages/pth-cli/
ARG NPM_CONFIG_REGISTRY
RUN npm ci

COPY packages/ ./packages/
COPY src/ ./src/
COPY scripts/copy-framework-web-assets.mjs scripts/copy-runtime-assets.mjs ./scripts/
# 依赖拓扑序构建（与根 package.json build 脚本一致；shared/infra 为 npm 已发布包）：
# contracts → config → memory → sandbox → kernel-storage → kernel-interpreter → kernel-execution → console → web → 根 tsc
RUN npx tsc -p packages/pth-contracts \
    && npx tsc -p packages/pth-config \
    && npx tsc -p packages/pth-memory \
    && npx tsc -p packages/pth-sandbox \
    && npx tsc -p packages/pth-kernel-storage \
    && npx tsc -p packages/pth-kernel-interpreter \
    && npx tsc -p packages/pth-kernel-execution \
    && npx tsc -p packages/pth-console \
    && npm run build:web -w @away_from/pth-console \
    && node scripts/copy-framework-web-assets.mjs \
    && npx tsc \
    && node scripts/copy-runtime-assets.mjs

# ---- Runtime stage ----
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends curl \
    ca-certificates \
    binutils \
    qemu-user \
    binutils-x86-64-linux-gnu \
    binutils-riscv64-linux-gnu \
    git \
    && rm -rf /var/lib/apt/lists/*

# P2：Lean 工具链（elan/lean/lake）已移出 engine 镜像——
# 由宿主本地执行器（execution/v1.1，`ptl local-exec`，backend id `local-lean`）提供。
# 镜像构建不再依赖 Lean 网络源。

WORKDIR /app

ENV DATA_DIR=/data

# 依赖清单先行（源码/文档变化不失效依赖层）
COPY package.json package-lock.json ./
# npm workspaces（全部 9 个 workspace 包的 package.json——workspace symlink 必需）
COPY --chown=node:node packages/pth-contracts/package.json packages/pth-contracts/
COPY --chown=node:node packages/pth-config/package.json packages/pth-config/
COPY --chown=node:node packages/pth-memory/package.json packages/pth-memory/
COPY --chown=node:node packages/pth-sandbox/package.json packages/pth-sandbox/
COPY --chown=node:node packages/pth-kernel-storage/package.json packages/pth-kernel-storage/
COPY --chown=node:node packages/pth-kernel-interpreter/package.json packages/pth-kernel-interpreter/
COPY --chown=node:node packages/pth-kernel-execution/package.json packages/pth-kernel-execution/
COPY --chown=node:node packages/pth-console/package.json packages/pth-console/
COPY --chown=node:node packages/pth-cli/package.json packages/pth-cli/
ARG NPM_CONFIG_REGISTRY
RUN npm ci --omit=dev

# 仅拷入各包构建产物（不拷源码/test/tsconfig——减小镜像体积+攻击面）
COPY --chown=node:node --from=builder /app/packages/pth-contracts/dist ./packages/pth-contracts/dist
COPY --chown=node:node --from=builder /app/packages/pth-config/dist ./packages/pth-config/dist
COPY --chown=node:node --from=builder /app/packages/pth-memory/dist ./packages/pth-memory/dist
COPY --chown=node:node --from=builder /app/packages/pth-sandbox/dist ./packages/pth-sandbox/dist
COPY --chown=node:node --from=builder /app/packages/pth-kernel-storage/dist ./packages/pth-kernel-storage/dist
COPY --chown=node:node --from=builder /app/packages/pth-kernel-interpreter/dist ./packages/pth-kernel-interpreter/dist
COPY --chown=node:node --from=builder /app/packages/pth-kernel-execution/dist ./packages/pth-kernel-execution/dist
COPY --chown=node:node --from=builder /app/packages/pth-console/dist ./packages/pth-console/dist
# v1.3 专业运行时：batch 进程启动读取 committed lock（生产唯一版本事实）
COPY --chown=node:node deploy/professional-runtime-lock.json ./deploy/professional-runtime-lock.json
# 执行目标矩阵：execution-target-registry 以 import.meta.url 相对路径读 deploy/executor-matrix.json
COPY --chown=node:node deploy/executor-matrix.json ./deploy/executor-matrix.json

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
RUN install -d -o node -g node /data/components /data/agent-dir /data/sessions /data/agent-lab /data/workspaces /data/platform /data/tenants /data/artifacts

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

CMD ["node", "dist/pth/main.js"]
