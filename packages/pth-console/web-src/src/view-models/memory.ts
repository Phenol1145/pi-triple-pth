/**
 * web-src/src/view-models/memory.ts — Operator Console memory 页视图模型（纯 TS，无 DOM）。
 *
 * 从 legacy web/operator-console/memory.js 迁移；双饼图 + 分页列表投影。
 */

export const MEMORY_PAGE_SIZE = 20;
export const MEMORY_MAX_LIMIT = 100;
export const MEMORY_REVISION_LIMIT = 10;

export interface MemoryTypeCount {
  count: number;
  bytes: number;
}

export interface MemoryChartSlice {
  type: string;
  value: number;
  ratio: number;
}

export interface MemoryChart {
  total: number;
  empty: boolean;
  slices: MemoryChartSlice[];
}

export interface MemoryCharts {
  count: MemoryChart;
  bytes: MemoryChart;
  empty: boolean;
}

export interface MemoryEntry {
  id?: string;
  type?: string | null;
  kind?: string;
  status?: string;
  anchors?: string[];
  version?: number | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  contentBytes?: number | null;
  content?: unknown;
  body?: unknown;
  prompt?: unknown;
  token?: unknown;
  secret?: unknown;
  [key: string]: unknown;
}

export interface MemoryPage {
  items?: MemoryEntry[];
  cursor?: string | null;
  total?: number;
}

export interface MemorySummary {
  byType?: Record<string, MemoryTypeCount>;
}

export function buildMemoryCharts(byType?: Record<string, MemoryTypeCount> | null): MemoryCharts {
  const types = ["setting", "wiki", "skill", "log", "index"];
  const rows = types.map((type) => {
    const row: MemoryTypeCount = byType?.[type] ?? { count: 0, bytes: 0 };
    const count = Number.isFinite(row.count) && row.count > 0 ? row.count : 0;
    const bytes = Number.isFinite(row.bytes) && row.bytes > 0 ? row.bytes : 0;
    return { type, count, bytes };
  });
  const countTotal = rows.reduce((sum, row) => sum + row.count, 0);
  const bytesTotal = rows.reduce((sum, row) => sum + row.bytes, 0);
  const empty = countTotal === 0 && bytesTotal === 0;
  const count: MemoryChart = {
    total: countTotal,
    empty,
    slices: rows.map((row) => ({ type: row.type, value: row.count, ratio: countTotal === 0 ? 0 : row.count / countTotal })),
  };
  const bytes: MemoryChart = {
    total: bytesTotal,
    empty,
    slices: rows.map((row) => ({ type: row.type, value: row.bytes, ratio: bytesTotal === 0 ? 0 : row.bytes / bytesTotal })),
  };
  return { count, bytes, empty };
}

export function createMemoryViewModel() {
  const filters: Record<string, string> = { type: "", kind: "", status: "", anchor: "" };
  let cursor: string | null = null;
  let entries: MemoryEntry[] = [];
  let total = 0;
  let summary: MemorySummary | null = null;
  let revisions: Array<Record<string, unknown>> = [];
  let detail: MemoryEntry | null = null;
  let degraded = false;

  function setFilter(key: string, value: string): MemoryView {
    if (!(key in filters)) throw new Error(`unknown memory filter: ${key}`);
    filters[key] = value;
    cursor = null;
    return view();
  }

  function stripBodyFields(row: MemoryEntry): MemoryEntry {
    const out = { ...row };
    delete out.content;
    delete out.body;
    delete out.prompt;
    delete out.token;
    delete out.secret;
    return out;
  }

  function ingestPage(page: MemoryPage): MemoryView {
    entries = Array.isArray(page?.items) ? page.items.map(stripBodyFields) : [];
    cursor = page?.cursor ?? null;
    total = Number.isFinite(page?.total) ? (page?.total as number) : entries.length;
    return view();
  }

  function ingestSummary(next: MemorySummary | null): MemoryView {
    summary = next ?? null;
    return view();
  }

  function ingestRevisions(next: unknown): MemoryView {
    revisions = Array.isArray(next) ? (next as Array<Record<string, unknown>>).slice(0, MEMORY_REVISION_LIMIT) : [];
    return view();
  }

  function ingestDetail(next: MemoryEntry | null): MemoryView {
    detail = next ?? null;
    return view();
  }

  function markDegraded(value: boolean): MemoryView {
    degraded = Boolean(value);
    return view();
  }

  function view(): MemoryView {
    return {
      filters: { ...filters },
      cursor,
      entries,
      total,
      summary: summary ?? { byType: {} },
      charts: buildMemoryCharts(summary?.byType),
      revisions,
      revisionsLimit: MEMORY_REVISION_LIMIT,
      detail,
      degraded,
      pageSize: MEMORY_PAGE_SIZE,
    };
  }

  return {
    setFilter,
    ingestPage,
    ingestSummary,
    ingestRevisions,
    ingestDetail,
    markDegraded,
    view,
  };
}

export interface MemoryView {
  filters: Record<string, string>;
  cursor: string | null;
  entries: MemoryEntry[];
  total: number;
  summary: MemorySummary;
  charts: MemoryCharts;
  revisions: Array<Record<string, unknown>>;
  revisionsLimit: number;
  detail: MemoryEntry | null;
  degraded: boolean;
  pageSize: number;
}
