# deploy/tool-containers/Dockerfile.tool —— 三域统一 tool container 镜像（T2）。
# 域工具安装分支：network 已装真实 yt-dlp；compiled/secrets 首期住户在 T3 迁移轮安装
# （本镜像提供 bf 演示解释器 + 明确 127 占位符，保证协议面/注册面可验收）。
FROM node:22-slim

ARG TOOL_DOMAIN
ENV TOOL_DOMAIN=${TOOL_DOMAIN}

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash curl ca-certificates procps python3 python3-pip build-essential \
    && rm -rf /var/lib/apt/lists/*

# 构建期可联网（compiled 域运行时离线由 compose internal 网络保证）
RUN case "${TOOL_DOMAIN}" in \
      network)  pip3 install --break-system-packages --no-cache-dir yt-dlp ;; \
      compiled|secrets) echo "${TOOL_DOMAIN} 首期住户 T3 迁移轮安装" ;; \
      *)        echo "unknown tool domain: ${TOOL_DOMAIN}" && exit 1 ;; \
    esac

COPY server/ /opt/tool-server/
WORKDIR /opt/tool-server
RUN npm init -y >/dev/null 2>&1 \
    && npm install --no-audit --no-fund --omit=dev @away_from/shared@1.6.0 ws@8.18.0 node-pty@1.1.0

# T2 工具面：bf 演示解释器 + 未迁移住户占位符（T3 替换为生产二进制）
COPY server/bin/bf.mjs /usr/local/bin/bf
COPY server/bin/not-installed.sh /usr/local/bin/not-installed.sh
RUN chmod 755 /usr/local/bin/bf /usr/local/bin/not-installed.sh \
    && chmod -R a+rX /opt/tool-server \
    && case "${TOOL_DOMAIN}" in \
         compiled) ln -s not-installed.sh /usr/local/bin/bfc \
                   && ln -s not-installed.sh /usr/local/bin/v13-asm-toolchain ;; \
         secrets)  ln -s not-installed.sh /usr/local/bin/agent-reach \
                   && ln -s not-installed.sh /usr/local/bin/chatgpt-share ;; \
       esac

USER node
EXPOSE 8080
CMD ["node", "/opt/tool-server/tool-server.mjs"]
