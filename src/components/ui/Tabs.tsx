"use client";

import { useRef, type ReactNode } from "react";
import styles from "./Tabs.module.css";

export type TabSpec<T extends string> = {
  value: T;
  label: ReactNode;
  /** Used when the label is not plain text. */
  name?: string;
};

const tabId = (group: string, value: string) => `${group}-tab-${value}`;
const panelId = (group: string, value: string) => `${group}-panel-${value}`;

/** A content tab strip: tablist/tab/tabpanel with real
 * linkage, one tab stop, and arrow/Home/End moving the selection. Selection
 * follows focus, which is the model a tab strip whose panels are already
 * mounted should use — nothing is fetched by arrowing across. */
export function Tabs<T extends string>({
  group,
  label,
  value,
  onChange,
  tabs,
  fill = false,
  className,
}: {
  /** Namespaces the tab and panel ids so two strips can coexist. */
  group: string;
  label: string;
  value: T;
  onChange: (next: T) => void;
  tabs: readonly TabSpec<T>[];
  /** Spread the tabs evenly across the row. */
  fill?: boolean;
  className?: string;
}) {
  const stripRef = useRef<HTMLDivElement>(null);

  const move = (delta: number | "first" | "last") => {
    const at = tabs.findIndex((t) => t.value === value);
    const next =
      delta === "first"
        ? 0
        : delta === "last"
          ? tabs.length - 1
          : (at + delta + tabs.length) % tabs.length;
    const target = tabs[next];
    if (!target || target.value === value) return;
    onChange(target.value);
    stripRef.current
      ?.querySelector<HTMLButtonElement>(`#${CSS.escape(tabId(group, target.value))}`)
      ?.focus();
  };

  return (
    <div
      ref={stripRef}
      role="tablist"
      aria-label={label}
      data-fill={fill || undefined}
      className={className ? `${styles.tabs} ${className}` : styles.tabs}
      onKeyDown={(e) => {
        const step =
          e.key === "ArrowRight" || e.key === "ArrowDown"
            ? 1
            : e.key === "ArrowLeft" || e.key === "ArrowUp"
              ? -1
              : e.key === "Home"
                ? ("first" as const)
                : e.key === "End"
                  ? ("last" as const)
                  : null;
        if (step === null) return;
        e.preventDefault();
        move(step);
      }}
    >
      {tabs.map((tab) => {
        const selected = tab.value === value;
        return (
          <button
            key={tab.value}
            type="button"
            role="tab"
            id={tabId(group, tab.value)}
            className={styles.tab}
            aria-selected={selected}
            aria-controls={panelId(group, tab.value)}
            aria-label={tab.name}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.value)}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

/** The panel a tab controls. Rendered only when its tab is selected — the
 * surfaces here all mount one panel at a time — and always labelled by its
 * tab, so the relationship is real rather than visual. */
export function TabPanel({
  group,
  value,
  className,
  children,
}: {
  group: string;
  value: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      role="tabpanel"
      id={panelId(group, value)}
      aria-labelledby={tabId(group, value)}
      className={className}
    >
      {children}
    </div>
  );
}
