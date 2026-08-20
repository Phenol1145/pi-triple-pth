import type { ComponentType } from "preact";
import { Suspense, lazy } from "preact/compat";
import { useCallback, useEffect, useState } from "preact/hooks";
import { refreshSession, sessionStore } from "./session";
import { useStore } from "./store";
import { CommandPalette } from "./components/CommandPalette";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { PageSkeleton } from "./components/PageSkeleton";
import { Sidebar } from "./components/Sidebar";
import { Topbar } from "./components/Topbar";
import { Button } from "./ui";
import { Toaster } from "./toast";

export type PageId = "overview" | "work" | "debug" | "memory" | "config";

const OverviewPage = lazy(() => import("./pages/overview"));
const WorkPage = lazy(() => import("./pages/work"));
const DebugPage = lazy(() => import("./pages/debug"));
const MemoryPage = lazy(() => import("./pages/memory"));
const ConfigPage = lazy(() => import("./pages/config"));

const PAGE_COMPONENTS: Record<PageId, ComponentType> = {
  overview: OverviewPage,
  work: WorkPage,
  debug: DebugPage,
  memory: MemoryPage,
  config: ConfigPage,
};

function SessionBanner() {
  const session = useStore(sessionStore);

  if (session.state === "expired") {
    return (
      <div class="banner banner--warn" role="alert">
        <span>会话已失效，需要新的一次性链接。请向管理员索取新的访问链接。</span>
      </div>
    );
  }
  if (session.state === "failed") {
    return (
      <div class="banner banner--danger" role="alert">
        <span>
          无法连接服务器，控制台处于降级模式。数据可能不是最新。
        </span>
        <Button variant="ghost" onClick={() => void refreshSession()}>
          重试连接
        </Button>
      </div>
    );
  }
  return null;
}

export function App() {
  const [page, setPage] = useState<PageId>("overview");
  const [paletteOpen, setPaletteOpen] = useState(false);

  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);
  const navigate = useCallback((next: PageId) => setPage(next), []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const ActivePage = PAGE_COMPONENTS[page];

  return (
    <div class="shell">
      <Topbar onOpenPalette={openPalette} />
      <SessionBanner />
      <div class="shell__body">
        <Sidebar activePage={page} onNavigate={navigate} />
        <main class="content">
          <ErrorBoundary region="当前页面">
            <Suspense fallback={<PageSkeleton />}>
              <ActivePage key={page} />
            </Suspense>
          </ErrorBoundary>
        </main>
      </div>
      <CommandPalette
        open={paletteOpen}
        onClose={closePalette}
        onNavigate={navigate}
      />
      <Toaster />
    </div>
  );
}
