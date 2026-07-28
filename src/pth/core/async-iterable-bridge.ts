export interface BridgeHandle<T> {
  iterable: AsyncIterable<T>;
  push(item: T): void;
  done(): void;
  error(err: Error): void;
  isOverflowed(): boolean;
}

export function createBridge<T>(opts: { maxQueueSize: number }): BridgeHandle<T> {
  const queue: T[] = [];
  let resolve: (() => void) | null = null;
  let finished = false;
  let errorValue: Error | null = null;
  let overflowed = false;

  function notify() {
    if (resolve) {
      const r = resolve;
      resolve = null;
      r();
    }
  }

  const iterable: AsyncIterable<T> = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<T>> {
          while (true) {
            if (queue.length > 0) {
              return { value: queue.shift()!, done: false };
            }
            if (errorValue) throw errorValue;
            if (finished) return { value: undefined as any, done: true };
            await new Promise<void>((r) => { resolve = r; });
          }
        },
        async return(): Promise<IteratorResult<T>> {
          finished = true;
          return { value: undefined as any, done: true };
        },
      };
    },
  };

  return {
    iterable,
    push(item: T) {
      if (finished) return;
      if (queue.length >= opts.maxQueueSize) {
        overflowed = true;
        return;
      }
      queue.push(item);
      notify();
    },
    done() {
      finished = true;
      notify();
    },
    error(err: Error) {
      errorValue = err;
      finished = true;
      notify();
    },
    isOverflowed() {
      return overflowed;
    },
  };
}
