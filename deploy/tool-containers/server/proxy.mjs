#!/usr/bin/env node
/**
 * tool-server/proxy.mjs —— compiled 域回环 gateway（T2b）。
 *
 * 部分 Docker 引擎（OrbStack）不给仅连 internal 网络的容器分配 127.0.0.1 动态端口。
 * 本边车同时连 tools-compiled（internal）与 default 网络，把 127.0.0.1 动态端口
 * 原始 TCP 中继到 tools-compiled:8080；compiled 工具容器本体仍无出网能力。
 */

import { createServer, connect } from "node:net";

const TARGET_HOST = process.env.PROXY_TARGET_HOST ?? "tools-compiled";
const TARGET_PORT = Number(process.env.PROXY_TARGET_PORT ?? 8080);
const PORT = Number(process.env.PORT ?? 8080);

const server = createServer((client) => {
  const upstream = connect(TARGET_PORT, TARGET_HOST);
  let opened = false;
  const fail = (message) => {
    if (opened) return;
    opened = true;
    client.destroy();
    upstream.destroy();
    console.error(`proxy: ${message}`);
  };
  upstream.on("connect", () => {
    opened = true;
    client.pipe(upstream);
    upstream.pipe(client);
  });
  upstream.on("error", (error) => fail(`upstream ${TARGET_HOST}:${TARGET_PORT} failed: ${error.message}`));
  client.on("error", () => { if (!opened) fail("client closed before upstream connect"); });
  client.on("close", () => upstream.destroy());
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`compiled gateway ${PORT} → ${TARGET_HOST}:${TARGET_PORT}`);
});
