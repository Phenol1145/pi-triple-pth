export interface SessionMeta {
  version: number;
  sessionId: string;
  tenantId: string;
  project: string;
  model: string;
  thinkingLevel: string;
  status: "active" | "idle" | "archived";
  entryCount: number;
  lastEntrySeq: number;
  createdAt: string;
  updatedAt: string;
}

export interface SessionEntry {
  version: number;
  seq: number;
  id: string;
  parentId: string | null;
  role: "user" | "assistant" | "system" | "tool";
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  createdAt: string;
  [key: string]: unknown;
}

export interface Snapshot {
  version: number;
  seq: number;
  entries: SessionEntry[];
  createdAt: string;
}

export interface VersionSnapshotRecord {
  seq: number;
  skills: string[];
  prompts: string[];
  tools: string[];
  timestamp: string;
}

export type Settings = Record<string, unknown>;
