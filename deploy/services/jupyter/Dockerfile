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

# 北面内置终端跑 pth CLI：镜像构建期 npm registry 不可达时暂缓安装；
# 后续经 pip/npm 离线包或镜像内 pth-cli tgz 注入（P5b 跟进，不影响南面 vertical）。

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 8888 8889
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
