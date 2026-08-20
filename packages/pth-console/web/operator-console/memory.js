/**
 * PTL Operator Console — memory 页视图模型（纯模块，无 DOM 依赖）。
 *
 * 双饼图：按 canonical MemoryType 的 count 与 UTF-8 字节数；全零输入 empty=true，
 * 绝不造 100% 切片。列表分页 cursor；每次过滤器变更重置 cursor。
 * recent revisions 固定 limit=10，与当前条目列表无关。
 */
export const MEMORY_PAGE_SIZE = 20;
export const MEMORY_MAX_LIMIT = 100;
export const MEMORY_REVISION_LIMIT = 10;

export function buildMemoryCharts(byType) {
  const types = ["setting", "wiki", "skill", "log", "index"];
  const rows = types.map((type) => {
    const row = byType?.[type] ?? {};
    const count = Number.isFinite(row.count) && row.count > 0 ? row.count : 0;
    const bytes = Number.isFinite(row.bytes) && row.bytes > 0 ? row.bytes : 0;
    return { type, count, bytes };
  });
  const countTotal = rows.reduce((sum, r) => sum + r.count, 0);
  const bytesTotal = rows.reduce((sum, r) => sum + r.bytes, 0);
  const empty = countTotal === 0 && bytesTotal === 0;
  const count = {
    total: countTotal,
    empty,
    slices: rows.map((r) => ({ type: r.type, value: r.count, ratio: countTotal === 0 ? 0 : r.count / countTotal })),
  };
  const bytes = {
    total: bytesTotal,
    empty,
    slices: rows.map((r) => ({ type: r.type, value: r.bytes, ratio: bytesTotal === 0 ? 0 : r.bytes / bytesTotal })),
  };
  return { count, bytes, empty };
}

export function createMemoryViewModel() {
  const filters = { type: "", kind: "", status: "", anchor: "" };
  let cursor = null;
  let entries = [];
  let total = 0;
  let summary = null;
  let revisions = [];
  let detail = null;
  let degraded = false;

  function setFilter(key, value) {
    if (!(key in filters)) throw new Error(`unknown memory filter: ${key}`);
    filters[key] = value;
    cursor = null; // 过滤变更重置 cursor
    return view();
  }

  function stripBodyFields(row) {
    const out = { ...row };
    delete out.content;
    delete out.body;
    delete out.prompt;
    delete out.token;
    delete out.secret;
    return out;
  }

  function ingestPage(page) {
    entries = Array.isArray(page?.items) ? page.items.map(stripBodyFields) : [];
    cursor = page?.cursor ?? null;
    total = Number.isFinite(page?.total) ? page.total : entries.length;
    return view();
  }

  function ingestSummary(next) {
    summary = next ?? null;
    return view();
  }

  function ingestRevisions(next) {
    revisions = Array.isArray(next) ? next.slice(0, MEMORY_REVISION_LIMIT) : [];
    return view();
  }

  function ingestDetail(next) {
    detail = next ?? null;
    return view();
  }

  function markDegraded(value) {
    degraded = Boolean(value);
    return view();
  }

  function view() {
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
