import { useCallback, useEffect, useState } from "preact/hooks";
import { apiFetch, ApiError } from "../api";
import {
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorState,
  PageHeader,
  Pagination,
  Skeleton,
  Table,
} from "../ui";
import "./memory.css";

interface MemoryItem {
  id: string;
  type: string | null;
  kind: string;
  status: string;
  anchors: string[];
  version: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  contentBytes: number | null;
}

interface MemoryPageResponse {
  items: MemoryItem[];
  cursor: string | null;
  total: number;
}

interface MemorySummary {
  byType: Record<string, { count: number; bytes: number }>;
  totals?: { count: number; bytes: number };
}

interface RevisionRow {
  action: string;
  revision: number | null;
  time: string;
  type: string;
}

export default function MemoryPage() {
  const [summary, setSummary] = useState<MemorySummary | null>(null);
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [errorCode, setErrorCode] = useState("http-0");
  const [typeFilter, setTypeFilter] = useState("");
  const [detail, setDetail] = useState<MemoryItem | null>(null);
  const [revisions, setRevisions] = useState<RevisionRow[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const loadFirstPage = useCallback(async () => {
    setLoadState("loading");
    try {
      const [nextSummary, page] = await Promise.all([
        apiFetch<MemorySummary>("/api/v1/memory/summary"),
        apiFetch<MemoryPageResponse>(
          `/api/v1/memory/entries?limit=20${typeFilter ? `&type=${encodeURIComponent(typeFilter)}` : ""}`,
        ),
      ]);
      setSummary(nextSummary);
      setItems(page.items ?? []);
      setCursor(page.cursor);
      setLoadState("ready");
    } catch (error) {
      setErrorCode(error instanceof ApiError ? error.code : "unknown-error");
      setLoadState("error");
    }
  }, [typeFilter]);

  useEffect(() => {
    void loadFirstPage();
  }, [loadFirstPage]);

  const loadMore = async () => {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const page = await apiFetch<MemoryPageResponse>(
        `/api/v1/memory/entries?limit=20&cursor=${encodeURIComponent(cursor)}${typeFilter ? `&type=${encodeURIComponent(typeFilter)}` : ""}`,
      );
      setItems((prev) => [...prev, ...(page.items ?? [])]);
      setCursor(page.cursor);
    } catch (error) {
      setErrorCode(error instanceof ApiError ? error.code : "unknown-error");
    } finally {
      setLoadingMore(false);
    }
  };

  const openDetail = async (item: MemoryItem) => {
    setDetail(item);
    setRevisions([]);
    setDetailLoading(true);
    try {
      const rows = await apiFetch<RevisionRow[]>(
        `/api/v1/memory/entries/${encodeURIComponent(item.id)}/revisions`,
      );
      setRevisions(rows ?? []);
    } catch {
      setRevisions([]);
    } finally {
      setDetailLoading(false);
    }
  };

  const typeRows = Object.entries(summary?.byType ?? {}).map(([type, value]) => ({
    type,
    count: value.count,
    bytes: value.bytes,
  }));

  return (
    <section class="page page-memory" data-page-root="memory">
      <PageHeader
        title="Memory"
        description="五类记忆的只读浏览：列表、详情与 revision 历史。"
        actions={<Button onClick={() => void loadFirstPage()}>刷新</Button>}
      />
      {loadState === "loading" ? <Skeleton variant="table" /> : null}
      {loadState === "error" ? (
        <ErrorState
          title="Memory 数据加载失败"
          description={`稳定错误码：${errorCode}`}
          action={<Button onClick={() => void loadFirstPage()}>重试</Button>}
        />
      ) : null}
      {loadState === "ready" ? (
        <div class="memory-layout">
          <Card title="类型概览">
            <Table
              columns={[
                { key: "type", label: "类型" },
                { key: "count", label: "数量" },
                { key: "bytes", label: "字节" },
              ]}
              rows={typeRows}
              rowKey={(row) => row.type}
            />
          </Card>
          <Card title="条目">
            <div class="memory-filters">
              <select
                class="memory-filter"
                value={typeFilter}
                onChange={(event) => setTypeFilter((event.target as HTMLSelectElement).value)}
              >
                <option value="">全部类型</option>
                {["setting", "wiki", "skill", "log", "index"].map((type) => (
                  <option value={type} key={type}>{type}</option>
                ))}
              </select>
            </div>
            {items.length === 0 ? (
              <EmptyState title="没有记忆条目" description="调整类型筛选后重试。" />
            ) : (
              <>
                <Table
                  columns={[
                    { key: "id", label: "ID" },
                    { key: "type", label: "类型", render: (row) => <Badge>{row.type ?? "—"}</Badge> },
                    { key: "kind", label: "Kind" },
                    { key: "status", label: "状态", render: (row) => <Badge>{row.status}</Badge> },
                    {
                      key: "contentBytes",
                      label: "正文大小",
                      render: (row) =>
                        row.contentBytes === null ? "—" : `${row.contentBytes} B`,
                    },
                    {
                      key: "updatedAt",
                      label: "更新时间",
                      render: (row) =>
                        row.updatedAt ? new Date(row.updatedAt).toLocaleString() : "—",
                    },
                  ]}
                  rows={items as Array<MemoryItem & Record<string, unknown>>}
                  rowKey={(row) => row.id}
                />
                <Pagination
                  mode="cursor"
                  hasMore={cursor !== null}
                  loading={loadingMore}
                  onLoadMore={() => void loadMore()}
                />
              </>
            )}
          </Card>
        </div>
      ) : null}
      <Dialog
        open={detail !== null}
        onClose={() => setDetail(null)}
        title={detail?.id ?? "Memory 详情"}
        actions={<Button onClick={() => setDetail(null)}>关闭</Button>}
      >
        {detail ? (
          <div class="memory-detail">
            <p>
              类型 <Badge>{detail.type ?? "—"}</Badge> · kind {detail.kind} · 状态{" "}
              <Badge>{detail.status}</Badge>
            </p>
            <p>
              版本 {detail.version ?? "—"} · 正文约 {detail.contentBytes ?? 0} 字节 · 更新于{" "}
              {detail.updatedAt ? new Date(detail.updatedAt).toLocaleString() : "—"}
            </p>
            <h4>Revision 历史</h4>
            {detailLoading ? (
              <Skeleton variant="text" lines={3} />
            ) : revisions.length === 0 ? (
              <EmptyState title="无 revision" description="该条目没有可展示的历史。" />
            ) : (
              <Table
                columns={[
                  { key: "revision", label: "Revision" },
                  { key: "action", label: "动作" },
                  { key: "type", label: "类型" },
                  {
                    key: "time",
                    label: "时间",
                    render: (row) =>
                      row.time ? new Date(row.time).toLocaleString() : "—",
                  },
                ]}
                rows={revisions as Array<RevisionRow & Record<string, unknown>>}
                rowKey={(row, index) => `${row.revision}-${index}`}
              />
            )}
          </div>
        ) : null}
      </Dialog>
    </section>
  );
}
