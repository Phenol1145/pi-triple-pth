import { useCallback, useEffect, useState } from "preact/hooks";
import { apiFetch, ApiError } from "../api";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  PageHeader,
  Skeleton,
  Table,
  Tabs,
} from "../ui";
import "./config.css";

interface ConfigEntry {
  key: string;
  group: string;
  type: string;
  scope: string;
  source: string;
  runtimeMutable: boolean;
  restartRequired: boolean;
  description: string;
  secret: boolean;
  defaultValue: unknown;
  effectiveValue: unknown;
  sourceDetail: unknown;
}

interface RoleEntry {
  id: string;
  parent: string | null;
  revision: string;
  family: string;
  tags: string[];
  capabilities: string[];
  actionTools: string[];
  thinking: string;
  acceptanceRole: string | null;
  defaultReplicas: number | null;
  loadPolicyRef: string;
  budgetPolicyRef: string;
}

type ConfigTab = "ptl" | "pth" | "roles";

function displayValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export default function ConfigPage() {
  const [tab, setTab] = useState<ConfigTab>("ptl");
  const [ptl, setPtl] = useState<ConfigEntry[]>([]);
  const [pth, setPth] = useState<ConfigEntry[]>([]);
  const [roles, setRoles] = useState<RoleEntry[]>([]);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [errorCode, setErrorCode] = useState("http-0");
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    setLoadState("loading");
    try {
      const [ptlPayload, pthPayload, rolesPayload] = await Promise.all([
        apiFetch<{ items: ConfigEntry[] }>("/api/v1/config/ptl"),
        apiFetch<{ items: ConfigEntry[] }>("/api/v1/config/pth"),
        apiFetch<{ items: RoleEntry[] }>("/api/v1/roles"),
      ]);
      setPtl(ptlPayload.items ?? []);
      setPth(pthPayload.items ?? []);
      setRoles(rolesPayload.items ?? []);
      setLoadState("ready");
    } catch (error) {
      setErrorCode(error instanceof ApiError ? error.code : "unknown-error");
      setLoadState("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const filterEntries = (entries: ConfigEntry[]) =>
    search
      ? entries.filter(
          (entry) =>
            entry.key.includes(search) ||
            entry.group.includes(search) ||
            entry.description.includes(search),
        )
      : entries;

  const entries = tab === "ptl" ? ptl : pth;
  const filteredEntries = filterEntries(entries);
  const filteredRoles = search
    ? roles.filter(
        (role) =>
          role.id.includes(search) ||
          (role.parent ?? "").includes(search) ||
          role.family.includes(search),
      )
    : roles;

  return (
    <section class="page page-config" data-page-root="config">
      <PageHeader
        title="Config"
        description="PTL/PTH 脱敏配置与 Runtime Catalog 角色目录。"
        actions={<Button onClick={() => void load()}>刷新</Button>}
      />
      {loadState === "loading" ? <Skeleton variant="table" /> : null}
      {loadState === "error" ? (
        <ErrorState
          title="Config 数据加载失败"
          description={`稳定错误码：${errorCode}`}
          action={<Button onClick={() => void load()}>重试</Button>}
        />
      ) : null}
      {loadState === "ready" ? (
        <div class="config-layout">
          <Tabs
            ariaLabel="Config 分类"
            items={[
              { id: "ptl", label: "PTL", count: ptl.length },
              { id: "pth", label: "PTH", count: pth.length },
              { id: "roles", label: "Roles", count: roles.length },
            ]}
            value={tab}
            onChange={(value) => setTab(value as ConfigTab)}
          />
          <div class="config-toolbar">
            <input
              class="config-search"
              value={search}
              placeholder="搜索 key / group / 描述"
              onInput={(event) => setSearch((event.target as HTMLInputElement).value)}
            />
          </div>
          {tab !== "roles" ? (
            filteredEntries.length === 0 ? (
              <Card>
                <EmptyState title="没有匹配的配置" description="调整搜索词后重试。" />
              </Card>
            ) : (
              <Card padding="none">
                <Table
                  columns={[
                    { key: "key", label: "Key" },
                    { key: "group", label: "分组" },
                    { key: "type", label: "类型" },
                    {
                      key: "source",
                      label: "来源",
                      render: (row) => <Badge>{row.source}</Badge>,
                    },
                    {
                      key: "effectiveValue",
                      label: "生效值",
                      render: (row) =>
                        row.secret ? <Badge tone="warning">***</Badge> : displayValue(row.effectiveValue),
                    },
                    {
                      key: "restartRequired",
                      label: "重启",
                      render: (row) =>
                        row.restartRequired ? <Badge tone="warning">需要</Badge> : <Badge>否</Badge>,
                    },
                  ]}
                  rows={filteredEntries as Array<ConfigEntry & Record<string, unknown>>}
                  rowKey={(row) => row.key}
                />
              </Card>
            )
          ) : filteredRoles.length === 0 ? (
            <Card>
              <EmptyState title="没有匹配的角色" description="调整搜索词后重试。" />
            </Card>
          ) : (
            <Card padding="none">
              <Table
                columns={[
                  { key: "id", label: "Role" },
                  { key: "parent", label: "父角色" },
                  { key: "revision", label: "Revision" },
                  {
                    key: "family",
                    label: "代际",
                    render: (row) => (row.family ? <Badge>{row.family}</Badge> : "—"),
                  },
                  {
                    key: "capabilities",
                    label: "能力",
                    render: (row) =>
                      row.capabilities.length === 0
                        ? "—"
                        : row.capabilities.map((capability: string) => (
                            <Badge key={capability}>{capability}</Badge>
                          )),
                  },
                  {
                    key: "acceptanceRole",
                    label: "验收角色",
                    render: (row) => row.acceptanceRole ?? "—",
                  },
                ]}
                rows={filteredRoles as Array<RoleEntry & Record<string, unknown>>}
                rowKey={(row) => row.id}
              />
            </Card>
          )}
        </div>
      ) : null}
    </section>
  );
}
