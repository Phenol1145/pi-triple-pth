import type { PageId } from "../app";

export interface NavPage {
  id: PageId;
  label: string;
}

export const NAV_PAGES: ReadonlyArray<NavPage> = [
  { id: "overview", label: "Overview" },
  { id: "work", label: "Work" },
  { id: "debug", label: "Debug" },
  { id: "memory", label: "Memory" },
  { id: "config", label: "Config" },
];

export interface SidebarProps {
  activePage: PageId;
  onNavigate: (page: PageId) => void;
}

export function Sidebar(props: SidebarProps) {
  return (
    <nav class="sidebar" aria-label="Console pages">
      {NAV_PAGES.map((page) => {
        const active = page.id === props.activePage;
        return (
          <button
            key={page.id}
            type="button"
            class={`ui-button ui-button--ghost${active ? " is-active" : ""}`}
            aria-current={active ? "page" : undefined}
            onClick={() => props.onNavigate(page.id)}
          >
            {page.label}
          </button>
        );
      })}
    </nav>
  );
}
