/**
 * PTH agent program manifest (agent.json schema).
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

export interface ProgramInfo {
  name: string;
  latestVersion: number;
  updatedAt: number;
}

export interface ProgramVersion {
  name: string;
  version: number;
  root: string; // absolute path to program directory on disk
  manifest: ProgramManifest;
}

export type Result<T, E = string> =
  | { ok: true; value: T }
  | { ok: false; error: E };
