/**
 * PTH agent program manifest (agent.json schema).
 */
import type { ProgramManifest, Result } from "@away_from/pth-contracts";

export type { ProgramManifest, Result };

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
