"use client";

import Link from "next/link";
import { ErrorNote } from "../ui/ErrorNote";
import { ChevronIcon } from "../ui/icons";
import styles from "./BuilderFallback.module.css";

/** What the builder shows instead of itself: the map is still
 * arriving, or it could not be opened at all. Extracted from `MapBuilder`
 * when the load failure gained a retry — the decomposition habit's answer
 * to a module that would otherwise grow past its ceiling. */
export function BuilderLoading() {
  return <div className={styles.fatal}>Loading map…</div>;
}

export function BuilderLoadFailure({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className={styles.fatal}>
      <Link href="/maps" className={styles.back}>
        <ChevronIcon /> Maps
      </Link>
      <ErrorNote message={message} onRetry={onRetry} />
    </div>
  );
}
