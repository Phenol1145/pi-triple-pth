export interface AgentEvent {
  seq: number;
  type: string;
  data: Record<string, unknown>;
  terminal?: boolean;
  timestamp: string;
}

export interface VersionSnapshot {
  skills: string[];
  prompts: string[];
  tools: string[];
  timestamp: string;
}

export interface ManagedSessionInfo {
  sessionId: string;
  tenantId: string;
  project: string;
  state: "idle" | "busy" | "evicting";
  model: string;
  createdAt: string;
  lastAccess: string;
}

export interface CreateSessionOpts {
  tenantId: string;
  project: string;
  provider?: string;
  model?: string;
  thinkingLevel?: string;
}

export type Result<T, E = string> =
  | { ok: true; data: T }
  | { ok: false; error: E };
