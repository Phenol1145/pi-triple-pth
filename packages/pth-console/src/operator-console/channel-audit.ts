/**
 * operator-console/channel-audit.ts — 操作通道审计（append-only JSONL）
 *
 * 安全要点（N33 Task 5 Step 3）：
 *  - 字段面固定（OPERATOR_AUDIT_FIELDS），只含归一化 errorCode——
 *    任何输入正文、原生响应内容、token/secret 一律不得进入审计记录；
 *  - 每条记录编码为单行 JSON，一次有界 write（默认 ≤4096 字节）+ fsync 落盘；
 *  - 文件以 O_APPEND 打开并强制 0600 权限；读取时崩溃截断的最后一行被忽略，
 *    中间行损坏则 fail-closed 抛错。
 */

import { open, readFile } from "node:fs/promises";
import type { WorkMode } from "@away_from/shared";
import { isWorkMode } from "@away_from/shared";
import { isPlainObject } from "./contracts.js";

export const OPERATOR_AUDIT_CHANNEL = "work";
export const OPERATOR_AUDIT_MAX_RECORD_BYTES = 4096;

export const OPERATOR_AUDIT_EVENTS = Object.freeze([
  "preview",
  "submit",
  "submit-confirmed",
  "submit-failed",
] as const);
export type OperatorAuditEvent = (typeof OPERATOR_AUDIT_EVENTS)[number];

/** 归一化错误码（审计只记录码，不记录错误正文）。 */
export const OPERATOR_AUDIT_ERROR_CODES = Object.freeze([
  "PREVIEW_UNKNOWN",
  "PREVIEW_EXPIRED",
  "PREVIEW_CONSUMED",
  "PREVIEW_IN_FLIGHT",
  "DIGEST_MISMATCH",
  "IDEMPOTENCY_CONFLICT",
  "PENDING_LIMIT",
  "UNKNOWN_ACTION",
  "CROSS_TENANT_REF",
  "NATIVE_SUBMIT_ERROR",
] as const);
export type OperatorAuditErrorCode = (typeof OPERATOR_AUDIT_ERROR_CODES)[number];

export interface OperatorAuditRecord {
  readonly at: string;
  readonly channel: typeof OPERATOR_AUDIT_CHANNEL;
  readonly event: OperatorAuditEvent;
  readonly mode: WorkMode;
  readonly action: string;
  readonly tenant: string;
  readonly space: string;
  readonly previewId?: string;
  readonly previewDigest?: string;
  readonly nativeKind?: string;
  readonly nativeId?: string;
  readonly errorCode?: OperatorAuditErrorCode;
}

export const OPERATOR_AUDIT_FIELDS = Object.freeze([
  "at",
  "channel",
  "event",
  "mode",
  "action",
  "tenant",
  "space",
  "previewId",
  "previewDigest",
  "nativeKind",
  "nativeId",
  "errorCode",
] as const);

export interface OperatorChannelAudit {
  /** append-only 写入一条记录（一次有界 write + fsync）。 */
  record(entry: OperatorAuditRecord): Promise<void>;
  /** 读回全部完整记录；崩溃截断的最后一行被忽略。 */
  readAll(): Promise<readonly OperatorAuditRecord[]>;
}

const NON_EMPTY = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

/** 校验固定字段面与形状；返回规范化的 plain object（不含 undefined 键）。 */
export function assertOperatorAuditRecord(value: unknown): asserts value is OperatorAuditRecord {
  if (!isPlainObject(value)) {
    throw new Error("audit record must be a plain object");
  }
  for (const key of Object.keys(value)) {
    if (!(OPERATOR_AUDIT_FIELDS as readonly string[]).includes(key)) {
      throw new Error(`unknown audit record field "${key}"`);
    }
  }
  const r = value as Record<string, unknown>;
  if (!NON_EMPTY(r.at) || Number.isNaN(Date.parse(r.at))) {
    throw new Error("audit record at must be an ISO timestamp");
  }
  if (r.channel !== OPERATOR_AUDIT_CHANNEL) {
    throw new Error(`audit record channel must be "${OPERATOR_AUDIT_CHANNEL}"`);
  }
  if (typeof r.event !== "string" || !(OPERATOR_AUDIT_EVENTS as readonly string[]).includes(r.event)) {
    throw new Error(`audit record event must be one of ${OPERATOR_AUDIT_EVENTS.join("|")}`);
  }
  if (!isWorkMode(r.mode)) {
    throw new Error("audit record mode must be a canonical work mode");
  }
  if (!NON_EMPTY(r.action)) throw new Error("audit record action must be a non-empty string");
  if (!NON_EMPTY(r.tenant)) throw new Error("audit record tenant must be a non-empty string");
  if (!NON_EMPTY(r.space)) throw new Error("audit record space must be a non-empty string");
  for (const opt of ["previewId", "previewDigest", "nativeKind", "nativeId"] as const) {
    if (r[opt] !== undefined && !NON_EMPTY(r[opt])) {
      throw new Error(`audit record ${opt} must be a non-empty string when present`);
    }
  }
  if (
    r.errorCode !== undefined &&
    (typeof r.errorCode !== "string" ||
      !(OPERATOR_AUDIT_ERROR_CODES as readonly string[]).includes(r.errorCode))
  ) {
    throw new Error("audit record errorCode must be a normalized code");
  }
}

function encodeRecord(entry: OperatorAuditRecord): Buffer {
  // 固定字段顺序输出，杜绝键序漂移；undefined 键不落盘。
  const ordered: Record<string, unknown> = {};
  for (const key of OPERATOR_AUDIT_FIELDS) {
    const v = (entry as unknown as Record<string, unknown>)[key];
    if (v !== undefined) ordered[key] = v;
  }
  return Buffer.from(`${JSON.stringify(ordered)}\n`, "utf8");
}

export function createOperatorChannelAudit(opts: {
  filePath: string;
  maxRecordBytes?: number;
}): OperatorChannelAudit {
  if (!NON_EMPTY(opts.filePath)) {
    throw new Error("channel audit filePath must be a non-empty string");
  }
  const maxRecordBytes = opts.maxRecordBytes ?? OPERATOR_AUDIT_MAX_RECORD_BYTES;
  if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes <= 0) {
    throw new Error("channel audit maxRecordBytes must be a positive safe integer");
  }
  const filePath = opts.filePath;

  return {
    async record(entry) {
      assertOperatorAuditRecord(entry);
      let line = encodeRecord(entry);
      if (line.byteLength > maxRecordBytes) {
        throw new Error(
          `audit record exceeds the bounded write limit (${line.byteLength} > ${maxRecordBytes} bytes)`,
        );
      }
      // O_APPEND（"a+"：追加写 + 读取文件尾用于截断修复）；0600 创建权限 + fchmod 兜底。
      const handle = await open(filePath, "a+", 0o600);
      try {
        await handle.chmod(0o600);
        // 崩溃截断修复：文件尾若不是换行（上一条记录写了一半），先补一个换行，
        // 让截断残片自成一行（读取侧跳过），本次记录仍是一次有界 write。
        const size = (await handle.stat()).size;
        if (size > 0) {
          const tail = Buffer.alloc(1);
          await handle.read(tail, 0, 1, size - 1);
          if (tail[0] !== 0x0a) {
            line = Buffer.concat([Buffer.from("\n", "utf8"), line]);
          }
        }
        await handle.write(line, 0, line.byteLength);
        await handle.sync();
      } finally {
        await handle.close();
      }
    },
    async readAll() {
      let raw: string;
      try {
        raw = await readFile(filePath, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw err;
      }
      const lines = raw.split("\n");
      if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
      const entries: OperatorAuditRecord[] = [];
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i]!;
        if (line === "") continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          // 崩溃截断残片（截断行本身或修复后自成一行的残片）：跳过，不阻断后续记录。
          continue;
        }
        // 能完整 JSON 解析但不符合固定字段面 = 篡改/损坏信号：fail-closed。
        assertOperatorAuditRecord(parsed);
        entries.push(parsed);
      }
      return entries;
    },
  };
}

/** 内存通道审计（server 未配置审计落盘路径时的缺省；同样走固定字段校验）。 */
export function createInMemoryChannelAudit(): OperatorChannelAudit {
  const entries: OperatorAuditRecord[] = [];
  return {
    async record(entry) {
      assertOperatorAuditRecord(entry);
      entries.push(JSON.parse(JSON.stringify(entry)) as OperatorAuditRecord);
    },
    async readAll() {
      return entries.map((e) => JSON.parse(JSON.stringify(e)) as OperatorAuditRecord);
    },
  };
}
