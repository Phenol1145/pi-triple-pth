import { useEffect, useState } from "preact/hooks";
import { sessionExpiryMs, sessionStore } from "../session";
import { cycleTheme, themeStore, type Theme } from "../theme";
import { useStore } from "../store";
import { Badge } from "../ui";

const THEME_LABELS: Record<Theme, string> = {
  light: "浅色",
  dark: "深色",
  system: "跟随系统",
};

function formatCountdown(ms: number): string {
  if (ms <= 0) {
    return "已过期";
  }
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  }
  return `${seconds}s`;
}

function SessionPill() {
  const session = useStore(sessionStore);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  if (session.state === "bootstrapping") {
    return <Badge tone="neutral">会话加载中…</Badge>;
  }
  if (session.state === "expired") {
    return <Badge tone="warning">会话失效</Badge>;
  }
  if (session.state === "failed") {
    return <Badge tone="danger">连接异常</Badge>;
  }

  const expiryMs = sessionExpiryMs(session.expiresAt);
  const countdown =
    expiryMs === null ? "无到期信息" : formatCountdown(expiryMs - now);
  const tone = expiryMs !== null && expiryMs - now <= 0 ? "warning" : "success";
  const principal = session.operatorPrincipalId ?? "operator";
  return (
    <span class="session-pill" title={`会话到期倒计时 ${countdown}`}>
      <Badge tone={tone}>{principal}</Badge>
      <span class="session-pill__countdown">{countdown}</span>
    </span>
  );
}

export interface TopbarProps {
  onOpenPalette: () => void;
}

export function Topbar(props: TopbarProps) {
  const { theme } = useStore(themeStore);
  return (
    <header class="topbar">
      <div class="topbar__brand">
        <span class="topbar__logo" aria-hidden="true">
          PTL
        </span>
        <span class="topbar__title">PTL Operator Console</span>
      </div>
      <div class="topbar__meta">
        <SessionPill />
        <button
          type="button"
          class="ui-button ui-button--ghost topbar__theme-toggle"
          onClick={cycleTheme}
          aria-label={`切换主题（当前：${THEME_LABELS[theme]}）`}
        >
          {THEME_LABELS[theme]}
        </button>
        <button
          type="button"
          class="ui-button ui-button--ghost topbar__palette-button"
          onClick={props.onOpenPalette}
          aria-label="打开命令面板（Ctrl+K）"
        >
          ⌘K / Ctrl+K
        </button>
      </div>
    </header>
  );
}
