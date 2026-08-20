import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { PageId } from "../app";
import { setTheme } from "../theme";
import { NAV_PAGES } from "./Sidebar";

interface PaletteAction {
  id: string;
  label: string;
  hint: string;
  run: () => void;
}

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  onNavigate: (page: PageId) => void;
}

/**
 * Ctrl+K command palette backed by a native <dialog>.
 * Arrow keys move the selection, Enter runs it, Escape / backdrop closes.
 */
export function CommandPalette(props: CommandPaletteProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const actions = useMemo<ReadonlyArray<PaletteAction>>(() => {
    const navigation: PaletteAction[] = NAV_PAGES.map((page) => ({
      id: `page-${page.id}`,
      label: `前往 ${page.label}`,
      hint: "页面",
      run: () => props.onNavigate(page.id),
    }));
    const themes: PaletteAction[] = [
      { id: "theme-light", label: "主题：浅色", hint: "外观", run: () => setTheme("light") },
      { id: "theme-dark", label: "主题：深色", hint: "外观", run: () => setTheme("dark") },
      {
        id: "theme-system",
        label: "主题：跟随系统",
        hint: "外观",
        run: () => setTheme("system"),
      },
    ];
    const reload: PaletteAction = {
      id: "reload",
      label: "重新加载控制台",
      hint: "操作",
      run: () => window.location.reload(),
    };
    return [...navigation, ...themes, reload];
  }, [props.onNavigate]);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
      return actions;
    }
    return actions.filter((action) =>
      action.label.toLowerCase().includes(normalized),
    );
  }, [actions, query]);

  // Open the dialog when mounted (the component renders only while open).
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }
    if (!dialog.open) {
      dialog.showModal();
    }
    const handleNativeClose = () => props.onClose();
    dialog.addEventListener("close", handleNativeClose);
    return () => dialog.removeEventListener("close", handleNativeClose);
  }, [props.onClose]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  if (!props.open) {
    return null;
  }

  const runAction = (action: PaletteAction | undefined) => {
    if (!action) {
      return;
    }
    action.run();
    props.onClose();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => Math.min(index + 1, filtered.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      runAction(filtered[activeIndex]);
    }
    // Escape is handled natively by <dialog> -> "close" event.
  };

  const onBackdropClick = (event: MouseEvent) => {
    if (event.target === dialogRef.current) {
      props.onClose();
    }
  };

  return (
    <dialog
      ref={dialogRef}
      class="palette"
      aria-label="命令面板"
      onKeyDown={onKeyDown}
      onClick={onBackdropClick}
    >
      <div class="palette__panel">
        <input
          class="palette__input"
          type="text"
          placeholder="输入命令或页面名称…"
          value={query}
          onInput={(event) =>
            setQuery((event.target as HTMLInputElement).value)
          }
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autofocus
        />
        <ul class="palette__list" role="listbox">
          {filtered.length === 0 ? (
            <li class="palette__empty">没有匹配的命令</li>
          ) : (
            filtered.map((action, index) => (
              <li key={action.id} role="option" aria-selected={index === activeIndex}>
                <button
                  type="button"
                  class={`palette__item${index === activeIndex ? " is-active" : ""}`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => runAction(action)}
                >
                  <span class="palette__item-label">{action.label}</span>
                  <span class="palette__item-hint">{action.hint}</span>
                </button>
              </li>
            ))
          )}
        </ul>
      </div>
    </dialog>
  );
}
