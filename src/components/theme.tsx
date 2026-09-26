"use client";

import {
  createContext,
  useCallback,
  useContext,
  useSyncExternalStore,
} from "react";
import styles from "./theme.module.css";

/**
 * The theme choice: light by default, remembered per browser, applied as
 * [data-theme] on the root element. The root layout's boot script stamps the
 * attribute before first paint; the attribute is the store — this provider
 * mirrors it (server snapshot: light, so hydration is clean) and the toggle
 * mutates it. Published pages live outside the provider and never theme.
 */

export type Theme = "dark" | "light";

const STORAGE_KEY = "dezfil-theme";

function readTheme(): Theme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function subscribeTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  return () => observer.disconnect();
}

const ThemeContext = createContext<{ theme: Theme; toggle: () => void }>({
  theme: "light",
  toggle: () => {},
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const theme = useSyncExternalStore(subscribeTheme, readTheme, () => "light" as Theme);

  const toggle = useCallback(() => {
    const next: Theme = readTheme() === "light" ? "dark" : "light";
    if (next === "dark") document.documentElement.dataset.theme = "dark";
    else delete document.documentElement.dataset.theme;
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Storage may be unavailable (private mode); the toggle still applies.
    }
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, toggle }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): { theme: Theme; toggle: () => void } {
  return useContext(ThemeContext);
}

/**
 * The header control. Both icons are always in the DOM and CSS shows the
 * one matching [data-theme] — the pre-paint attribute decides, so the icon
 * never hydrates wrong.
 */
export function ThemeToggle() {
  const { toggle } = useTheme();
  return (
    <button
      type="button"
      className={styles.toggle}
      data-hint="Switch theme"
      aria-label="Switch between dark and light theme"
      onClick={toggle}
    >
      <svg
        className={styles.moon}
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
      </svg>
      <svg
        className={styles.sun}
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </svg>
    </button>
  );
}
