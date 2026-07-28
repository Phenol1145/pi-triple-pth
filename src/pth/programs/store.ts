/**
 * ProgramStore — agent program storage backed by filesystem + Redis.
 *
 * File layout: DATA_DIR/programs/<tenantId>/<name>/<version>/
 * Redis keys:
 *   programs:<tenantId>                    Set of program names
 *   program:<tenantId>:<name>:latest       Integer (latest version)
 *   program:<tenantId>:<name>:<N>          JSON manifest
 *   program:<tenantId>:<name>:<N>:bytes    Integer (archive size, for GC)
 *
 * Safety: hand-written ustar reader rejects path traversal, symlinks,
 * absolute paths, and enforces file count / single-file / total-byte limits.
 */

import fs from "node:fs";
import path from "node:path";
import type { Redis } from "ioredis";
import type { ProgramManifest, ProgramInfo, ProgramVersion, Result } from "./types.js";

// ── tar extraction limits ──────────────────────────────────────

const MAX_FILES = 100;
const MAX_SINGLE_FILE_BYTES = 1_048_576;        // 1 MB
const MAX_TOTAL_BYTES = 20_971_520;              // 20 MB
const MAX_PATH_DEPTH = 8;
const MAX_VERSIONS = 10;

// ── ustar constants ────────────────────────────────────────────

const BLOCK_SIZE = 512;
const USTAR_MAGIC = "ustar\0";

function readOctal(buf: Buffer, offset: number, len: number): number {
  let s = "";
  for (let i = 0; i < len; i++) {
    const ch = buf[offset + i]!;
    if (ch === 0 || ch === 0x20) break; // null or space terminates
    s += String.fromCharCode(ch);
  }
  if (s.length === 0) return 0;
  return parseInt(s, 8);
}

function isZeroBlock(buf: Buffer): boolean {
  for (let i = 0; i < BLOCK_SIZE; i++) {
    if (buf[i] !== 0) return false;
  }
  return true;
}

interface TarEntry {
  name: string;
  size: number;
  typeflag: string;
  offset: number; // content offset in the buffer
}

function parseTarEntries(buf: Buffer): Result<TarEntry[]> {
  const entries: TarEntry[] = [];
  let offset = 0;
  let totalBytes = 0;

  while (offset + BLOCK_SIZE <= buf.length) {
    const header = buf.subarray(offset, offset + BLOCK_SIZE);
    offset += BLOCK_SIZE;

    // Two consecutive zero blocks → end of archive
    if (isZeroBlock(header)) {
      const next = buf.subarray(offset, offset + BLOCK_SIZE);
      if (offset + BLOCK_SIZE <= buf.length && isZeroBlock(next)) {
        break;
      }
      // single zero block, could be padding — continue
      continue;
    }

    const magic = header.toString("utf-8", 257, 263);
    if (magic !== USTAR_MAGIC) {
      return { ok: false, error: `invalid tar magic at byte ${offset - BLOCK_SIZE}` };
    }

    const name = header.toString("utf-8", 0, 100).replace(/\0/g, "");
    const typeflag = header.toString("utf-8", 156, 157).replace(/\0/g, "");
    const size = readOctal(header, 124, 12);

    // ── safety checks ─────────────────────────────────────
    if (name.length === 0) {
      return { ok: false, error: "empty entry name in tar" };
    }
    if (path.isAbsolute(name) || name.startsWith("/")) {
      return { ok: false, error: `absolute path rejected: ${name}` };
    }
    if (name.includes("..")) {
      return { ok: false, error: `path traversal rejected: ${name}` };
    }
    if (typeflag === "2") {
      return { ok: false, error: `symlink rejected: ${name}` };
    }
    const depth = name.split("/").length - 1;
    if (depth > MAX_PATH_DEPTH) {
      return { ok: false, error: `path depth ${depth} exceeds max ${MAX_PATH_DEPTH}: ${name}` };
    }

    if (size > MAX_SINGLE_FILE_BYTES) {
      return { ok: false, error: `file too large (${size} > ${MAX_SINGLE_FILE_BYTES}): ${name}` };
    }

    if (entries.length >= MAX_FILES) {
      return { ok: false, error: `too many files (max ${MAX_FILES})` };
    }

    totalBytes += size;
    if (totalBytes > MAX_TOTAL_BYTES) {
      return { ok: false, error: `total decompressed bytes exceeds ${MAX_TOTAL_BYTES}` };
    }

    entries.push({ name, size, typeflag, offset });

    // Skip content (padded to 512-byte boundary)
    const contentBlocks = Math.ceil(size / BLOCK_SIZE);
    offset += contentBlocks * BLOCK_SIZE;
  }

  return { ok: true, value: entries };
}

// ── store ──────────────────────────────────────────────────────

export class ProgramStore {
  constructor(
    private redis: Redis,
    private dataDir: string,
  ) {}

  private programsDir(): string {
    return path.join(this.dataDir, "programs");
  }

  private keySet(tenantId: string): string {
    return `programs:${tenantId}`;
  }

  private keyLatest(tenantId: string, name: string): string {
    return `program:${tenantId}:${name}:latest`;
  }

  private keyUpdated(tenantId: string, name: string): string {
    return `program:${tenantId}:${name}:updatedAt`;
  }

  private keyVersion(tenantId: string, name: string, version: number): string {
    return `program:${tenantId}:${name}:${version}`;
  }

  private keyBytes(tenantId: string, name: string, version: number): string {
    return `program:${tenantId}:${name}:${version}:bytes`;
  }

  private rootDir(tenantId: string, name: string, version: number): string {
    return path.join(this.programsDir(), tenantId, name, String(version));
  }

  /**
   * Save a program. Accepts raw tar buffer (already decompressed from gzip by caller).
   * Assigns an incremental version atomically via Redis INCR.
   */
  async save(
    tenantId: string,
    manifest: ProgramManifest,
    archive: Buffer,
  ): Promise<Result<ProgramVersion>> {
    const parseResult = parseTarEntries(archive);
    if (!parseResult.ok) return parseResult;

    const entries = parseResult.value;

    // Extract agent.json content to validate manifest match
    const agentEntry = entries.find((e) => e.name === "agent.json");
    if (!agentEntry) {
      return { ok: false, error: "missing agent.json in archive" };
    }
    const agentContent = archive.subarray(agentEntry.offset, agentEntry.offset + agentEntry.size).toString("utf-8");
    let archiveManifest: ProgramManifest;
    try {
      archiveManifest = JSON.parse(agentContent);
    } catch {
      return { ok: false, error: "agent.json is not valid JSON" };
    }
    if (archiveManifest.name !== manifest.name) {
      return { ok: false, error: "archive agent.json name does not match manifest" };
    }

    // Atomic version assignment
    const version = await this.redis.incr(`program:${tenantId}:${manifest.name}:next`);

    // Write files to disk
    const root = this.rootDir(tenantId, manifest.name, version);
    fs.mkdirSync(root, { recursive: true });

    try {
      for (const entry of entries) {
        const filePath = path.join(root, entry.name);
        const dir = path.dirname(filePath);

        // Extra defense: after join, verify we're still under root
        if (!filePath.startsWith(root + path.sep) && filePath !== root) {
          return { ok: false, error: `path escape after join: ${entry.name}` };
        }

        fs.mkdirSync(dir, { recursive: true });
        const content = archive.subarray(entry.offset, entry.offset + entry.size);
        fs.writeFileSync(filePath, content);
      }
    } catch (err: any) {
      // Clean up partial extraction
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ok */ }
      return { ok: false, error: `extraction failed: ${err.message}` };
    }

    // Update Redis
    await this.redis.sadd(this.keySet(tenantId), manifest.name);
    await this.redis.set(this.keyLatest(tenantId, manifest.name), String(version));
    await this.redis.set(this.keyVersion(tenantId, manifest.name, version), JSON.stringify(manifest));
    await this.redis.set(this.keyBytes(tenantId, manifest.name, version), String(archive.length));
    await this.redis.set(this.keyUpdated(tenantId, manifest.name), String(Date.now()));

    // Garbage-collect old versions
    await this.prune(tenantId, manifest.name);

    return {
      ok: true,
      value: { name: manifest.name, version, root, manifest },
    };
  }

  /** Delete all versions of a program. */
  async delete(tenantId: string, name: string): Promise<Result<void>> {
    const latest = await this.redis.get(this.keyLatest(tenantId, name));
    if (latest === null) {
      return { ok: false, error: `program "${name}" not found` };
    }
    const maxVer = parseInt(latest, 10);

    // Delete Redis keys
    await this.redis.del(this.keyLatest(tenantId, name));
    await this.redis.del(this.keyUpdated(tenantId, name));
    for (let v = 1; v <= maxVer; v++) {
      await this.redis.del(this.keyVersion(tenantId, name, v));
      await this.redis.del(this.keyBytes(tenantId, name, v));
    }
    await this.redis.del(`program:${tenantId}:${name}:next`);
    await this.redis.srem(this.keySet(tenantId), name);

    // Delete on-disk directory
    const dir = path.join(this.programsDir(), tenantId, name);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }

    return { ok: true, value: undefined };
  }

  /** List all programs for a tenant (name + latestVersion + updatedAt). */
  async list(tenantId: string): Promise<ProgramInfo[]> {
    const names = await this.redis.smembers(this.keySet(tenantId));
    const result: ProgramInfo[] = [];

    for (const name of names) {
      const latest = await this.redis.get(this.keyLatest(tenantId, name));
      if (!latest) continue;
      const version = parseInt(latest, 10);
      const updatedAt = parseInt((await this.redis.get(this.keyUpdated(tenantId, name))) ?? "0", 10);
      result.push({
        name,
        latestVersion: version,
        updatedAt,
      });
    }

    result.sort((a, b) => a.name.localeCompare(b.name));
    return result;
  }

  /** Get a specific version (or latest if version is undefined) of a program. */
  async get(
    tenantId: string,
    name: string,
    version?: number,
  ): Promise<Result<ProgramVersion>> {
    let ver: number;
    if (version !== undefined) {
      ver = version;
    } else {
      const latest = await this.redis.get(this.keyLatest(tenantId, name));
      if (latest === null) {
        return { ok: false, error: `program "${name}" not found` };
      }
      ver = parseInt(latest, 10);
    }

    const raw = await this.redis.get(this.keyVersion(tenantId, name, ver));
    if (!raw) {
      return { ok: false, error: `program "${name}" v${ver} not found` };
    }
    const manifest: ProgramManifest = JSON.parse(raw);
    const root = this.rootDir(tenantId, name, ver);
    if (!fs.existsSync(root)) {
      return { ok: false, error: `program "${name}" v${ver} files missing on disk` };
    }

    return { ok: true, value: { name, version: ver, root, manifest } };
  }

  /** Copy program files to a destination directory (for run materialization). */
  async materialize(
    tenantId: string,
    name: string,
    version: number,
    destDir: string,
  ): Promise<Result<void>> {
    const result = await this.get(tenantId, name, version);
    if (!result.ok) return result;

    const root = result.value.root;
    if (!fs.existsSync(root)) {
      return { ok: false, error: "program directory missing" };
    }

    fs.mkdirSync(destDir, { recursive: true });
    fs.cpSync(root, destDir, { recursive: true });
    return { ok: true, value: undefined };
  }

  // ── internal ─────────────────────────────────────────────

  /** Remove versions beyond MAX_VERSIONS. */
  private async prune(tenantId: string, name: string): Promise<void> {
    const latest = await this.redis.get(this.keyLatest(tenantId, name));
    if (!latest) return;
    const maxVer = parseInt(latest, 10);
    const oldest = maxVer - MAX_VERSIONS;

    for (let v = 1; v <= oldest; v++) {
      // Delete Redis keys
      await this.redis.del(this.keyVersion(tenantId, name, v));
      await this.redis.del(this.keyBytes(tenantId, name, v));
      // Delete on-disk
      const dir = this.rootDir(tenantId, name, v);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
    }
  }
}

export type { ProgramManifest, ProgramInfo, ProgramVersion, Result };
