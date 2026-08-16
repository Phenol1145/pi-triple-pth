/**
 * contracts/program.ts —— 构件/程序 manifest 与通用 Result（模块化优化 P0）。
 *
 * components 与 programs 双方共享的纯类型上移 contracts（断开 components↔programs 文件级环）；
 * programs/types.ts 保留兼容 re-export。
 */
export interface ProgramManifest {
  name: string;
  description?: string;
  model?: string;
  provider?: string;
  thinking?: string;
  systemPrompt: string; // relative path within archive
  skills?: string[];
  tools?: string[];
  excludeTools?: string[];
  input?: {
    schema?: Record<string, unknown>;
  };
  timeoutSec?: number;
}

export type Result<T, E = string> =
  | { ok: true; value: T }
  | { ok: false; error: E };
