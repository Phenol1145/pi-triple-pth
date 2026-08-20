import { useSyncExternalStore } from "preact/compat";

export interface Store<T> {
  get(): T;
  set(next: T | ((prev: T) => T)): void;
  update(patch: Partial<T>): void;
  subscribe(listener: () => void): () => void;
}

/**
 * Tiny external store usable with useSyncExternalStore.
 * Keeps app-level state (session, theme) outside the component tree.
 */
export function createStore<T extends object>(initial: T): Store<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of listeners) {
      listener();
    }
  };
  return {
    get() {
      return value;
    },
    set(next) {
      value = typeof next === "function" ? (next as (prev: T) => T)(value) : next;
      emit();
    },
    update(patch) {
      value = { ...value, ...patch };
      emit();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export function useStore<T extends object>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get);
}
