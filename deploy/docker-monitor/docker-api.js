/**
 * Docker Engine API 客户端（unix socket 直连——零依赖）。
 * 参考 API：GET /containers/json?all=true、GET /containers/:id/stats?stream=false
 */
import { request } from "node:http";

const SOCKET = process.env.DOCKER_SOCKET ?? "/var/run/docker.sock";

/**
 * GET unix socket 路径 → JSON
 * @param {string} path docker API 路径（如 /containers/json?all=true）
 * @returns {Promise<unknown>}
 */
export function dockerGet(path) {
  return new Promise((resolve, reject) => {
    const req = request(
      { socketPath: SOCKET, path, method: "GET" },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`docker API ${res.statusCode}: ${body.slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error(`invalid json from docker API ${path}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** @typedef {{Id?:string, Names?:string[], Image?:string, State?:string, Status?:string, Ports?:Array<{IP?:string,PublicPort?:number,PrivatePort?:number,Type?:string}>, Health?:{Status?:string}}} ContainerEntry */

/** @returns {Promise<ContainerEntry[]>} */
export async function getContainers() {
  return dockerGet("/containers/json?all=true");
}

/** @param {string} id @returns {Promise<Record<string, unknown>>} */
export async function getContainerStats(id) {
  return dockerGet(`/containers/${id}/stats?stream=false`);
}

/** @param {string} id @returns {Promise<Record<string, unknown>>} */
export async function inspectContainer(id) {
  return dockerGet(`/containers/${id}/json`);
}

/** 可注入的默认 Docker 客户端（直连本机 unix socket，只读）。 */
export const defaultDockerClient = {
  getContainers,
  inspectContainer,
  getContainerStats,
};
