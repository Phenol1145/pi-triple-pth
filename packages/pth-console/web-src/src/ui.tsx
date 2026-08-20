import type { ComponentChildren, JSX } from "preact";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";

/* ------------------------------------------------------------------ */
/* Button                                                              */
/* ------------------------------------------------------------------ */

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

export interface ButtonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  type?: "button" | "submit" | "reset";
  /** Shows a CSS-only spinner and disables the button while work is in flight. */
  loading?: boolean;
  disabled?: boolean;
  /** Pressed state for toggle-style buttons (aria-pressed). */
  active?: boolean;
  onClick?: () => void;
  ariaLabel?: string;
  children: ComponentChildren;
}

export function Button(props: ButtonProps) {
  const {
    variant = "secondary",
    size = "md",
    type = "button",
    loading = false,
    disabled = false,
    active = false,
    onClick,
    ariaLabel,
    children,
  } = props;
  const className = [
    "ui-button",
    `ui-button--${variant}`,
    `ui-button--${size}`,
    active ? "is-active" : "",
    loading ? "is-loading" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      type={type}
      class={className}
      disabled={disabled || loading}
      aria-busy={loading ? true : undefined}
      aria-pressed={active ? true : undefined}
      aria-label={ariaLabel}
      onClick={onClick}
    >
      {loading ? <span class="ui-button__spinner" aria-hidden="true" /> : null}
      <span class="ui-button__label">{children}</span>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Badge                                                               */
/* ------------------------------------------------------------------ */

export type BadgeTone =
  | "neutral"
  | "info"
  | "success"
  | "warning"
  | "danger";

export interface BadgeProps {
  tone?: BadgeTone;
  /** Renders a small colored dot before the label. */
  dot?: boolean;
  children: ComponentChildren;
}

export function Badge(props: BadgeProps) {
  const { tone = "neutral", dot = false, children } = props;
  return (
    <span class={`ui-badge ui-badge--${tone}`}>
      {dot ? <span class="ui-badge__dot" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Card                                                                */
/* ------------------------------------------------------------------ */

export type CardPadding = "none" | "sm" | "md" | "lg";

export interface CardProps {
  title?: string;
  /** Slot rendered on the right side of the card header. */
  actions?: ComponentChildren;
  /** Slot rendered below the body, separated by a divider. */
  footer?: ComponentChildren;
  padding?: CardPadding;
  children: ComponentChildren;
}

export function Card(props: CardProps) {
  const { title, actions, footer, padding = "md", children } = props;
  const hasHeader = title !== undefined || actions !== undefined;
  return (
    <section class={`ui-card ui-card--pad-${padding}`}>
      {hasHeader ? (
        <header class="ui-card__header">
          {title ? <h3 class="ui-card__title">{title}</h3> : null}
          {actions ? <div class="ui-card__actions">{actions}</div> : null}
        </header>
      ) : null}
      <div class="ui-card__body">{children}</div>
      {footer ? <footer class="ui-card__footer">{footer}</footer> : null}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* PageHeader                                                          */
/* ------------------------------------------------------------------ */

export interface PageHeaderProps {
  title: string;
  description?: string;
  /** Slot rendered on the right side (typically Button/Badge actions). */
  actions?: ComponentChildren;
}

export function PageHeader(props: PageHeaderProps) {
  const { title, description, actions } = props;
  return (
    <header class="ui-page-header">
      <div class="ui-page-header__text">
        <h2 class="ui-page-header__title">{title}</h2>
        {description ? (
          <p class="ui-page-header__description">{description}</p>
        ) : null}
      </div>
      {actions ? <div class="ui-page-header__actions">{actions}</div> : null}
    </header>
  );
}

/* ------------------------------------------------------------------ */
/* Tabs                                                                */
/* ------------------------------------------------------------------ */

export interface TabItem {
  id: string;
  label: string;
  count?: number;
}

export interface TabsProps {
  items: ReadonlyArray<TabItem>;
  value: string;
  onChange: (id: string) => void;
  ariaLabel?: string;
}

/**
 * Tab strip with roving tabindex. Arrow keys move between tabs,
 * Home/End jump to the edges; selection follows focus.
 */
export function Tabs(props: TabsProps) {
  const { items, value, onChange, ariaLabel } = props;
  const baseId = useId();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const activeIndex = useMemo(() => {
    const index = items.findIndex((item) => item.id === value);
    return index >= 0 ? index : 0;
  }, [items, value]);

  const focusTab = (index: number) => {
    const count = items.length;
    if (count === 0) {
      return;
    }
    const clamped = ((index % count) + count) % count;
    const item = items[clamped];
    tabRefs.current[clamped]?.focus();
    if (item && item.id !== value) {
      onChange(item.id);
    }
  };

  const onKeyDown = (event: JSX.TargetedKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      focusTab(activeIndex + 1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      focusTab(activeIndex - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusTab(0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusTab(items.length - 1);
    }
  };

  return (
    <div
      class="ui-tabs"
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
    >
      {items.map((item, index) => {
        const selected = item.id === value;
        return (
          <button
            key={item.id}
            ref={(el) => {
              tabRefs.current[index] = el;
            }}
            type="button"
            role="tab"
            id={`${baseId}-tab-${item.id}`}
            aria-selected={selected}
            aria-controls={`${baseId}-panel-${item.id}`}
            tabIndex={selected ? 0 : -1}
            class={`ui-tabs__tab${selected ? " is-active" : ""}`}
            onClick={() => onChange(item.id)}
          >
            <span class="ui-tabs__label">{item.label}</span>
            {item.count !== undefined ? (
              <span class="ui-tabs__count">{item.count}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Table                                                               */
/* ------------------------------------------------------------------ */

export interface TableColumn<T> {
  key: string;
  label: string;
  sortable?: boolean;
  /** Custom cell renderer; defaults to String(row[key]). */
  render?: (row: T) => ComponentChildren;
  /** Value accessor used for sorting; defaults to row[key]. */
  sortValue?: (row: T) => string | number | null | undefined;
}

export interface TableProps<T> {
  columns: ReadonlyArray<TableColumn<T>>;
  rows: ReadonlyArray<T>;
  rowKey: (row: T, index: number) => string;
  /** Rendered in a full-width row when rows is empty. */
  empty?: ComponentChildren;
  caption?: string;
  /** Wraps the table in a horizontally scrollable container (default true). */
  responsive?: boolean;
}

type SortDirection = "asc" | "desc";

function compareValues(
  a: string | number | null | undefined,
  b: string | number | null | undefined,
): number {
  if (a === null || a === undefined) {
    return b === null || b === undefined ? 0 : 1;
  }
  if (b === null || b === undefined) {
    return -1;
  }
  if (typeof a === "number" && typeof b === "number") {
    return a - b;
  }
  return String(a).localeCompare(String(b));
}

/**
 * Accessible data table with client-side sorting. Sorting is presentational
 * state only; callers keep ownership of the row data.
 */
export function Table<T extends Record<string, unknown>>(props: TableProps<T>) {
  const { columns, rows, rowKey, empty, caption, responsive = true } = props;
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");

  const sortedRows = useMemo(() => {
    if (!sortKey) {
      return rows;
    }
    const column = columns.find((c) => c.key === sortKey);
    if (!column) {
      return rows;
    }
    const read = (row: T): string | number | null | undefined =>
      column.sortValue ? column.sortValue(row) : (row[column.key] as never);
    const direction = sortDirection === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => direction * compareValues(read(a), read(b)));
  }, [columns, rows, sortKey, sortDirection]);

  const toggleSort = (column: TableColumn<T>) => {
    if (!column.sortable) {
      return;
    }
    if (sortKey === column.key) {
      if (sortDirection === "asc") {
        setSortDirection("desc");
      } else {
        setSortKey(null);
        setSortDirection("asc");
      }
    } else {
      setSortKey(column.key);
      setSortDirection("asc");
    }
  };

  const table = (
    <table class="ui-table">
      {caption ? <caption class="ui-table__caption">{caption}</caption> : null}
      <thead>
        <tr>
          {columns.map((column) => {
            const sorted = sortKey === column.key;
            const ariaSort = sorted
              ? sortDirection === "asc"
                ? "ascending"
                : "descending"
              : undefined;
            return (
              <th key={column.key} scope="col" aria-sort={ariaSort}>
                {column.sortable ? (
                  <button
                    type="button"
                    class={`ui-table__sort${sorted ? " is-sorted" : ""}`}
                    onClick={() => toggleSort(column)}
                  >
                    {column.label}
                    <span class="ui-table__sort-icon" aria-hidden="true">
                      {sorted
                        ? sortDirection === "asc"
                          ? "↑"
                          : "↓"
                        : "↕"}
                    </span>
                  </button>
                ) : (
                  column.label
                )}
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {sortedRows.length === 0 ? (
          <tr>
            <td class="ui-table__empty" colSpan={columns.length}>
              {empty ?? "暂无数据"}
            </td>
          </tr>
        ) : (
          sortedRows.map((row, index) => (
            <tr key={rowKey(row, index)}>
              {columns.map((column) => (
                <td key={column.key}>
                  {column.render
                    ? column.render(row)
                    : String(row[column.key] ?? "")}
                </td>
              ))}
            </tr>
          ))
        )}
      </tbody>
    </table>
  );

  if (!responsive) {
    return table;
  }
  return <div class="ui-table-wrap">{table}</div>;
}

/* ------------------------------------------------------------------ */
/* Dialog                                                              */
/* ------------------------------------------------------------------ */

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Slot rendered in the footer (typically Buttons). */
  actions?: ComponentChildren;
  children: ComponentChildren;
}

/**
 * Modal dialog on the native <dialog> element: focus trapping and Escape
 * come from showModal(); clicking the backdrop closes via onClose.
 */
export function Dialog(props: DialogProps) {
  const { open, onClose, title, actions, children } = props;
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }
    const handleClose = () => onClose();
    dialog.addEventListener("close", handleClose);
    return () => dialog.removeEventListener("close", handleClose);
  }, [onClose]);

  const onBackdropClick = (
    event: JSX.TargetedMouseEvent<HTMLDialogElement>,
  ) => {
    // A click on the <dialog> element itself (not its children) is a
    // backdrop click.
    if (event.target === dialogRef.current) {
      dialogRef.current?.close();
    }
  };

  return (
    <dialog ref={dialogRef} class="ui-dialog" onClick={onBackdropClick}>
      <div class="ui-dialog__panel">
        <header class="ui-dialog__header">
          <h2 class="ui-dialog__title">{title}</h2>
          <button
            type="button"
            class="ui-dialog__close"
            aria-label="关闭对话框"
            onClick={() => dialogRef.current?.close()}
          >
            ×
          </button>
        </header>
        <div class="ui-dialog__body">{children}</div>
        {actions ? <footer class="ui-dialog__actions">{actions}</footer> : null}
      </div>
    </dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Skeleton                                                            */
/* ------------------------------------------------------------------ */

export interface SkeletonProps {
  variant?: "text" | "card" | "table";
  /** Number of text lines (variant="text", default 3). */
  lines?: number;
  /** Number of skeleton rows (variant="table", default 4). */
  rows?: number;
  /** Number of skeleton columns (variant="table", default 4). */
  columns?: number;
}

/** Placeholder shimmer while content loads. Purely decorative. */
export function Skeleton(props: SkeletonProps) {
  const { variant = "text", lines = 3, rows = 4, columns = 4 } = props;
  if (variant === "card") {
    return (
      <div class="ui-skeleton ui-skeleton--card" aria-hidden="true">
        <div class="ui-skeleton__bar ui-skeleton__bar--title" />
        <div class="ui-skeleton__bar" />
        <div class="ui-skeleton__bar ui-skeleton__bar--short" />
      </div>
    );
  }
  if (variant === "table") {
    const cells = Array.from({ length: columns });
    return (
      <div class="ui-skeleton ui-skeleton--table" aria-hidden="true">
        {Array.from({ length: rows }).map((_, rowIndex) => (
          <div class="ui-skeleton__row" key={rowIndex}>
            {cells.map((_, cellIndex) => (
              <div class="ui-skeleton__bar" key={cellIndex} />
            ))}
          </div>
        ))}
      </div>
    );
  }
  return (
    <div class="ui-skeleton ui-skeleton--text" aria-hidden="true">
      {Array.from({ length: lines }).map((_, index) => (
        <div
          class={`ui-skeleton__bar${
            index === lines - 1 ? " ui-skeleton__bar--short" : ""
          }`}
          key={index}
        />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* EmptyState / ErrorState                                             */
/* ------------------------------------------------------------------ */

export interface EmptyStateProps {
  title: string;
  description?: string;
  /** Slot for a recovery/next-step control (typically a Button). */
  action?: ComponentChildren;
}

export function EmptyState(props: EmptyStateProps) {
  const { title, description, action } = props;
  return (
    <div class="ui-empty-state">
      <p class="ui-empty-state__title">{title}</p>
      {description ? (
        <p class="ui-empty-state__description">{description}</p>
      ) : null}
      {action ? <div class="ui-empty-state__action">{action}</div> : null}
    </div>
  );
}

export interface ErrorStateProps {
  title: string;
  description?: string;
  /** Slot for a recovery control (typically a retry Button). */
  action?: ComponentChildren;
}

export function ErrorState(props: ErrorStateProps) {
  const { title, description, action } = props;
  return (
    <div class="ui-empty-state ui-error-state" role="alert">
      <p class="ui-empty-state__title ui-error-state__title">{title}</p>
      {description ? (
        <p class="ui-empty-state__description">{description}</p>
      ) : null}
      {action ? <div class="ui-empty-state__action">{action}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Pagination                                                          */
/* ------------------------------------------------------------------ */

export type PaginationProps =
  | {
      /** Cursor mode: a single "load more" control for API cursors. */
      mode?: "cursor";
      hasMore: boolean;
      loading?: boolean;
      onLoadMore: () => void;
    }
  | {
      /** Numeric mode: page buttons for offset-based lists. */
      mode: "numeric";
      page: number;
      total: number;
      pageSize?: number;
      onPage: (page: number) => void;
    };

export function Pagination(props: PaginationProps) {
  if (props.mode === "numeric") {
    const { page, total, pageSize = 20, onPage } = props;
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const pages = Array.from({ length: pageCount }, (_, i) => i + 1);
    return (
      <nav class="ui-pagination" aria-label="分页">
        <Button
          variant="ghost"
          size="sm"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
        >
          上一页
        </Button>
        <div class="ui-pagination__pages">
          {pages.map((p) => (
            <button
              key={p}
              type="button"
              class={`ui-pagination__page${p === page ? " is-active" : ""}`}
              aria-current={p === page ? "page" : undefined}
              onClick={() => onPage(p)}
            >
              {p}
            </button>
          ))}
        </div>
        <Button
          variant="ghost"
          size="sm"
          disabled={page >= pageCount}
          onClick={() => onPage(page + 1)}
        >
          下一页
        </Button>
      </nav>
    );
  }
  const { hasMore, loading = false, onLoadMore } = props;
  return (
    <div class="ui-pagination ui-pagination--cursor">
      {hasMore ? (
        <Button variant="secondary" loading={loading} onClick={onLoadMore}>
          加载更多
        </Button>
      ) : (
        <span class="ui-pagination__end">已加载全部</span>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Progress                                                            */
/* ------------------------------------------------------------------ */

export interface ProgressProps {
  /** 0–100. Values outside the range are clamped. */
  value: number;
  label?: string;
}

export function Progress(props: ProgressProps) {
  const clamped = Math.min(100, Math.max(0, props.value));
  return (
    <div class="ui-progress">
      {props.label ? <span class="ui-progress__label">{props.label}</span> : null}
      <div
        class="ui-progress__track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(clamped)}
        aria-label={props.label}
      >
        <div
          class="ui-progress__fill"
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  );
}
