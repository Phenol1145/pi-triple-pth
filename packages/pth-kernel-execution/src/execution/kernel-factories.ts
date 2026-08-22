/**
 * kernel/execution/kernel-factories.ts —— worker/manager 核工厂注入端口（模块化优化 P0）。
 *
 * 具体核实现（impls/kernels）在装配层（main/bootstrap）注入本端口；
 * kernel 内只按端口消费（断开 kernel→impls 反向边）。
 * 未注入即使用 → 明确报错（fail-fast），不会静默退化。
 */
export interface KernelExecFactory {
  createKernelManager(opts: unknown): unknown;
  createWorkerKernelWithManager(deps: unknown): unknown;
}

let current: KernelExecFactory | null = null;

export function setKernelExecFactory(factory: KernelExecFactory): void {
  current = factory;
}

export function getKernelExecFactory(): KernelExecFactory {
  if (!current) {
    throw new Error("kernel exec factory 未注入——装配层必须先 import impls/kernels/index.js（setKernelExecFactory）");
  }
  return current;
}
