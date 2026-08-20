import { createStore } from "./store";

export type Theme = "light" | "dark" | "system";

const STORAGE_KEY = "ptl-operator-theme";
const THEME_ORDER: ReadonlyArray<Theme> = ["light", "dark", "system"];

function loadStoredTheme(): Theme {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") {
      return stored;
    }
  } catch {
    // localStorage may be unavailable; fall back to system.
  }
  return "system";
}

export const themeStore = createStore<{ theme: Theme }>({
  theme: loadStoredTheme(),
});

function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute("data-theme", theme);
}

/** Apply the stored theme to <html> and keep it in sync with the store. */
export function initTheme(): void {
  applyTheme(themeStore.get().theme);
  themeStore.subscribe(() => {
    applyTheme(themeStore.get().theme);
  });
}

export function setTheme(theme: Theme): void {
  themeStore.set({ theme });
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Persistence is best-effort only.
  }
}

/** Cycle light -> dark -> system -> light (topbar toggle). */
export function cycleTheme(): void {
  const current = themeStore.get().theme;
  const index = THEME_ORDER.indexOf(current);
  const next = THEME_ORDER[(index + 1) % THEME_ORDER.length];
  setTheme(next);
}
