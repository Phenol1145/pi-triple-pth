/**
 * toast.tsx — 全局 toast 系统（T2）。
 *
 * 运行时内容只经 Preact 文本节点渲染，不接受 HTML。
 */

import { useSyncExternalStore } from "preact/compat";
import type { ComponentChildren } from "preact";

export type ToastTone = "info" | "success" | "warning" | "error";

export interface ToastItem {
  id: number;
  tone: ToastTone;
  message: string;
}

const listeners = new Set<() => void>();
let nextId = 1;
let toasts: ToastItem[] = [];

function emit() {
  for (const listener of listeners) listener();
}

function dismiss(id: number) {
  toasts = toasts.filter((item) => item.id !== id);
  emit();
}

function push(tone: ToastTone, message: string) {
  const id = nextId++;
  toasts = [...toasts, { id, tone, message }];
  emit();
  if (typeof window !== "undefined") {
    window.setTimeout(() => dismiss(id), 4000);
  }
  return id;
}

export const toast = {
  info: (message: string) => push("info", message),
  success: (message: string) => push("success", message),
  warning: (message: string) => push("warning", message),
  error: (message: string) => push("error", message),
  dismiss,
};

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function Toaster(): ComponentChildren {
  const items = useSyncExternalStore(subscribe, () => toasts);
  if (items.length === 0) return null;
  return (
    <div class="ui-toaster" aria-live="polite" aria-atomic="false">
      {items.map((item) => (
        <div key={item.id} class={`ui-toast ui-toast--${item.tone}`} role="status">
          <span class="ui-toast__message">{item.message}</span>
          <button
            type="button"
            class="ui-toast__close"
            aria-label="关闭通知"
            onClick={() => dismiss(item.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
