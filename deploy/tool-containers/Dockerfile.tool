# deploy/tool-containers/Dockerfile.tool —— 三域统一 tool container 镜像（T3）。
# 真实住户：compiled=beef+bf/bfc；network=yt-dlp；secrets=agent-reach+chatgpt-share。
FROM node:22-slim

ARG TOOL_DOMAIN
ENV TOOL_DOMAIN=${TOOL_DOMAIN}

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash curl ca-certificates procps python3 python3-pip build-essential \
    git beef tcc libc6-dev \
    && rm -rf /var/lib/apt/lists/*

# 构建期可联网（compiled 域运行时离线由 compose internal 网络保证）
RUN case "${TOOL_DOMAIN}" in \
      network)  pip3 install --break-system-packages --no-cache-dir yt-dlp ;; \
      secrets)  pip3 install --break-system-packages --no-cache-dir \
                  "agent-reach @ git+https://github.com/Panniantong/agent-reach@main" ;; \
      compiled) apt-get update && apt-get install -y --no-install-recommends \
                  binutils qemu-user binutils-x86-64-linux-gnu \
                  binutils-aarch64-linux-gnu binutils-riscv64-linux-gnu \
                  && rm -rf /var/lib/apt/lists/* ;; \
      *)        echo "unknown tool domain: ${TOOL_DOMAIN}" && exit 1 ;; \
    esac

COPY server/ /opt/tool-server/
WORKDIR /opt/tool-server
RUN npm init -y >/dev/null 2>&1 \
    && npm install --no-audit --no-fund --omit=dev @away_from/shared@1.6.0 ws@8.18.0 node-pty@1.1.0

# 域工具落位（T3 真实住户；v13-asm-toolchain 留 T4）
COPY server/bin/bfc-tools/ /opt/tools/bfc/
COPY server/bin/chatgpt-share /opt/tools/chatgpt-share/chatgpt-share
COPY server/bin/not-installed.sh /usr/local/bin/not-installed.sh
RUN chmod 755 /opt/tools/bfc/bf /opt/tools/bfc/bfc /opt/tools/chatgpt-share/chatgpt-share /usr/local/bin/not-installed.sh \
    && chmod -R a+rX /opt/tool-server \
    && case "${TOOL_DOMAIN}" in \
         compiled) ln -sf /opt/tools/bfc/bf /usr/local/bin/bf \
                   && ln -sf /opt/tools/bfc/bfc /usr/local/bin/bfc ;; \
         secrets)  ln -sf /opt/tools/chatgpt-share/chatgpt-share /usr/local/bin/chatgpt-share ;; \
       esac

USER node
EXPOSE 8080
CMD ["node", "/opt/tool-server/tool-server.mjs"]
