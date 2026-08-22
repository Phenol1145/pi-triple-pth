import { useCallback, useState } from "preact/hooks";
import { ApiError } from "../api";

export type LoadState = "loading" | "ready" | "error";

export interface UseLoadState {
  readonly loadState: LoadState;
  readonly errorCode: string;
  /** 执行加载函数；成功置 ready，失败映射 ApiError 并置 error。 */
  run: <T>(loader: () => Promise<T>) => Promise<T | undefined>;
  /** 只更新错误码，不改变 loadState；用于加载更多/次要请求的失败记录。 */
  fail: (error: unknown) => void;
}

export function useLoadState(): UseLoadState {
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [errorCode, setErrorCode] = useState("http-0");

  const fail = useCallback((error: unknown) => {
    setErrorCode(error instanceof ApiError ? error.code : "unknown-error");
  }, []);

  const run = useCallback(async <T,>(loader: () => Promise<T>): Promise<T | undefined> => {
    setLoadState("loading");
    try {
      const value = await loader();
      setLoadState("ready");
      return value;
    } catch (error) {
      fail(error);
      setLoadState("error");
      return undefined;
    }
  }, [fail]);

  return { loadState, errorCode, run, fail };
}
