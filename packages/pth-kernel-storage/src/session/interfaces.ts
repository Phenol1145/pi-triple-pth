import type { SessionMeta, SessionEntry, Snapshot, VersionSnapshotRecord, Settings } from "./types.js";

export interface SessionStore {
  appendEntry(tenant: string, sessionId: string, entry: SessionEntry): Promise<void>;
  getEntries(tenant: string, sessionId: string, fromSeq?: number): Promise<SessionEntry[]>;
  getMeta(tenant: string, sessionId: string): Promise<SessionMeta | null>;
  saveMeta(tenant: string, sessionId: string, meta: SessionMeta): Promise<void>;
  saveSnapshot(tenant: string, sessionId: string, snapshot: Snapshot): Promise<void>;
  getLatestSnapshot(tenant: string, sessionId: string): Promise<Snapshot | null>;
  listSessions(tenant: string, project?: string): Promise<SessionMeta[]>;
  deleteSession(tenant: string, sessionId: string): Promise<void>;
  saveVersionSnapshot(tenant: string, sessionId: string, record: VersionSnapshotRecord): Promise<void>;
  getLatestVersionSnapshot(tenant: string, sessionId: string): Promise<VersionSnapshotRecord | null>;
}

export interface SettingsStore {
  get(tenant: string, project?: string): Promise<Settings>;
  set(tenant: string, settings: Partial<Settings>, project?: string): Promise<void>;
}

export interface CredentialProvider {
  getApiKey(tenant: string, provider: string): Promise<string | null>;
}
