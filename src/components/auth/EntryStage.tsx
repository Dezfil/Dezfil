"use client";
import type { ReactNode } from "react";
import { ThemeProvider, ThemeToggle } from "@/components/theme";
import styles from "./EntryScreen.module.css";

/** What every screen before sign-in stands in: the river delta with the
 * wordmark and the instance's name, the theme button, and a column for the
 * screen's own heading and action. */
export function EntryStage({ instance, subtitle, children }: { instance: string | null; subtitle: string; children: ReactNode }) {
  return <ThemeProvider><div className={styles.stage}>
    <aside className={styles.brandPane} aria-label="Dezfil">
      <div className={styles.shade} />
      <span className={styles.wordmark}>Dezfil</span>
      <div className={styles.foot}>{instance && <span className={styles.instance}>{instance}</span>}
        <span className={styles.subtitle}>{subtitle}</span>
      </div>
      <span className={styles.coordinate} aria-hidden="true">32°23′N · 48°24′E</span>
    </aside>
    <div className={styles.theme}><ThemeToggle /></div>
    <main className={styles.formPane}><div className={styles.column}>{children}</div></main>
  </div></ThemeProvider>;
}
