/**
 * components/tar-utils.ts —— tar 归档解析（模块专项 ② 大文件拆分：自 store.ts 抽出）。
 */
import path from "node:path";
import type { Result } from "@away_from/pth-contracts";

// ── tar extraction limits ──────────────────────────────────────

const MAX_FILES = 100;
const MAX_SINGLE_FILE_BYTES = 1_048_576;        // 1 MB
const MAX_TOTAL_BYTES = 20_971_520;              // 20 MB
const MAX_PATH_DEPTH = 8;

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

export interface TarEntry {
  name: string;
  size: number;
  typeflag: string;
  offset: number; // content offset in the buffer
}

export function parseTarEntries(buf: Buffer): Result<TarEntry[]> {
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

