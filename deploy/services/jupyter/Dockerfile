# jupyter 单容器双面（P5）：
#  - 北面：JupyterLab :8888（人 + 内置终端跑 pth CLI；token 不进浏览器）
#  - 南面：execution/v1.1 :8889（engine 唯一客户端——无头 notebook 执行）
# 基础镜像用本机已缓存的 quay.io/jupyter/minimal-notebook（python-3.13），
# jupyter-notebook 7.6.1 与 committed lock 一致；不依赖 Docker Hub。
FROM quay.io/jupyter/minimal-notebook:python-3.13

USER root

# 南面 Node 运行时（ExecutionHttpServer + LocalBackend）
RUN mamba install -y -q -n base -c conda-forge 'nodejs>=20,<24' \
    && fix-permissions "${CONDA_DIR}" \
    && fix-permissions "/home/${NB_USER}"

# 南面 execution/v1.1 服务（self-contained npm app）
WORKDIR /opt/jupyter-south
COPY package.json package.json
RUN npm install --omit=dev --no-audit --no-fund
COPY server server

# P5c：engine kernel provider（cell 转发 engine notebook API，不本地执行）
COPY kernels /tmp/kernels
RUN python -m jupyter kernelspec install /tmp/kernels/pi-kernel \
    --name pi-kernel --prefix /usr/local \
    && rm -rf /tmp/kernels

# 北面内置终端跑 pth CLI：轻量透传——宿主机 pth 依赖树由 compose 只读挂载到
# /opt/pth-host（PTH_HOST_PTH_ROOT），镜像不打包 pth（2026-08-22 用户裁决）。
COPY pth-wrapper.sh /usr/local/bin/pth
RUN chmod +x /usr/local/bin/pth

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 8888 8889
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
