/**
 * obs-ipc.ts —— batch → 主进程观测请求通道（obs 扩展数据源）。
 * 协议：{kind:"obs-req", id, req, params} → 主进程响应 {kind:"obs-resp", id, data}
 * 复用现有 IPC（process.send/on("message")——与日志/metric 转发共存）。
 */

export interface ObsRequest {
  kind: "obs-req";
  id: string;
  req: string;
  params?: unknown;
}

export interface ObsResponse {
  kind: "obs-resp";
  id: string;
  data: unknown;
  error?: string;
}

const pending = new Map<string, { resolve: (d: unknown) => void; reject: (e: Error) => void }>();
let seq = 0;

if (typeof process !== "undefined" && process.send) {
  process.on("message", (msg: unknown) => {
    const m = msg as ObsResponse | null;
    if (m && m.kind === "obs-resp") {
      const p = pending.get(m.id);
      if (p) {
        pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error));
        else p.resolve(m.data);
      }
    }
  });
}

/** 向主进程请求观测数据（batch 内；非 batch 环境/主进程不可达时 reject） */
export function requestMain<T>(req: string, params?: unknown): Promise<T> {
  // batch 子进程标志（batch-process 启动设置）——防 vitest 池/主进程误用 IPC 通道
  if (process.env.PTH_BATCH_PROCESS !== "1" || typeof process === "undefined" || !process.send) {
    return Promise.reject(new Error("obs: 非 batch 进程（IPC 不可用）"));
  }
  const id = `obs-${Date.now().toString(36)}-${++seq}`;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`obs 请求超时: ${req}`));
    }, 10_000);
    pending.set(id, {
      resolve: (d) => {
        clearTimeout(timer);
        resolve(d as T);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    try {
      const send = process.send;
      if (!send) throw new Error("obs: IPC 不可用");
      (send as (msg: unknown) => void).call(process, { kind: "obs-req", id, req, params } satisfies ObsRequest);
    } catch (e) {
      clearTimeout(timer);
      pending.delete(id);
      reject(e as Error);
    }
  });
}
