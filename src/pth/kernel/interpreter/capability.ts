import type { LlmFn } from "./llm-fn.js";
import type { Interpreter } from "./types.js";
import type { DataWorldAccess } from "../storage/index.js";

/**
 * 能力注入：context 默认空，只注入白名单。
 * 不注入 fs/child_process/net——语言层面无能力。
 * 任务动词面收窄：tasks 只暴露 peek/submit（claim/reject 由 TaskLoop 机械控制）。
 */
export function buildCapabilities(deps: {
  llm: LlmFn;
  dataWorld: DataWorldAccess;
  bash?: Interpreter;
  python?: Interpreter;
}): Record<string, unknown> {
  return {
    llm: deps.llm,
    // Finding F1（Important）修复：memory 整体注入时其方法 retrieve/write/bumpHitCount 均用
    // this.pool——裸对象注入后若被解构/提取（`const { retrieve } = memory; retrieve()`）this 丢失。
    // bindAll 为所有函数属性（含原型链类方法）逐个 bind，非函数属性（pool 句柄）不注入 vm（安全边界）。
    memory: bindAll(deps.dataWorld.memory),
    skills: {
      get: async (name: string) => {
        // v1：skill 数据对象读取（Spec C skills 表——v1 独立表占位）
        // 简化：返回空（v1 不实现完整 skill 加载，Spec B 任务接入时扩展）
        return undefined;
      },
    },
    tasks: {
      // Finding F1 修复：peek/submit 是方法提取——vm 里 `tasks.peek()` 的 this 是 capabilities.tasks
      // 对象而非 TaskStore 实例 → this.pool undefined → TypeError（真实 PgTaskStore 用 this.pool.query）。
      peek: deps.dataWorld.tasks.candidates.bind(deps.dataWorld.tasks),
      submit: deps.dataWorld.tasks.submit.bind(deps.dataWorld.tasks),
    },
    ...(deps.bash ? { bash: deps.bash } : {}),
    ...(deps.python ? { python: deps.python } : {}),
  };
}

/**
 * bindAll：为对象的所有函数属性逐个 bind 到原对象，返回包装对象（防方法提取丢 this）。
 * 类方法位于 prototype（Object.keys 只能拿到自身可枚举属性），故沿原型链收集
 * （到 Object.prototype 为止；constructor 除外）。非函数属性不拷贝——底层句柄
 * （如 pool）不注入 vm context（与「context 默认空、只注入白名单」的能力模型一致）。
 */
function bindAll<T extends object>(obj: T): T {
  const out: Record<string, unknown> = {};
  const targets: Array<[string, (...args: unknown[]) => unknown]> = [];
  let proto: object | null = obj;
  const seen = new Set<string>();
  while (proto !== null && proto !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (seen.has(key)) continue;
      seen.add(key);
      const desc = Object.getOwnPropertyDescriptor(proto, key);
      if (desc && typeof desc.value === "function" && key !== "constructor") {
        targets.push([key, desc.value]);
      }
    }
    proto = Object.getPrototypeOf(proto);
  }
  for (const [key, fn] of targets) out[key] = fn.bind(obj);
  return out as T;
}
