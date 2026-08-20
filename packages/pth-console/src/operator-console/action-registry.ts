import { isWorkMode, type WorkMode } from "@away_from/shared";
import type { OperatorModeAdapter } from "./contracts.js";

export type { OperatorModeAdapter } from "./contracts.js";
export type {
  OperatorAcceptanceProjection,
  OperatorCommandPreview,
  OperatorContext,
  OperatorFormDescriptor,
  NativeWorkProjection,
  NativeWorkRef,
} from "./contracts.js";

/** 以 (mode, action) 为唯一键的原生动作登记表。 */
export interface OperatorActionRegistry {
  register<TInput = unknown>(adapter: OperatorModeAdapter<TInput>): void;
  get(mode: WorkMode, action: string): OperatorModeAdapter;
  has(mode: WorkMode, action: string): boolean;
  list(): readonly OperatorModeAdapter[];
}

function isAdapterObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

const ADAPTER_METHODS = [
  "describe",
  "preview",
  "submit",
  "inspect",
  "evaluate",
] as const;

function assertOperatorModeAdapter(
  value: unknown,
): asserts value is OperatorModeAdapter {
  if (!isAdapterObject(value)) {
    throw new Error("invalid adapter: expected a plain adapter object");
  }
  if (!isWorkMode(value.mode)) {
    throw new Error("invalid adapter: unknown work mode");
  }
  if (typeof value.action !== "string" || value.action.trim() === "") {
    throw new Error("invalid adapter: action must be a non-empty string");
  }
  for (const method of ADAPTER_METHODS) {
    if (typeof value[method] !== "function") {
      throw new Error(`invalid adapter: missing ${method}() method`);
    }
  }
}

export function operatorActionKey(mode: WorkMode, action: string): string {
  return `${mode}:${action}`;
}

function assertOperatorActionKey(
  mode: unknown,
  action: unknown,
): asserts mode is WorkMode {
  if (!isWorkMode(mode)) {
    throw new Error("unknown operator action: invalid work mode");
  }
  if (typeof action !== "string" || action.trim() === "") {
    throw new Error("unknown operator action: invalid action");
  }
}

export function createOperatorActionRegistry(): OperatorActionRegistry {
  const adapters = new Map<string, OperatorModeAdapter>();

  return {
    register(adapter) {
      assertOperatorModeAdapter(adapter);
      const key = operatorActionKey(adapter.mode, adapter.action);
      if (adapters.has(key)) {
        throw new Error(`duplicate operator action registration: ${key}`);
      }
      adapters.set(key, adapter);
    },
    get(mode, action) {
      assertOperatorActionKey(mode, action);
      const key = operatorActionKey(mode, action);
      const found = adapters.get(key);
      if (!found) {
        throw new Error(`unknown operator action: ${key}`);
      }
      return found;
    },
    has(mode, action) {
      assertOperatorActionKey(mode, action);
      return adapters.has(operatorActionKey(mode, action));
    },
    list() {
      return [...adapters.values()];
    },
  };
}
