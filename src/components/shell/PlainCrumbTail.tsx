"use client";

import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import styles from "@/components/builder/MapBuilder.module.css";

const subscribeNever = () => () => {};

/**
 * The non-renaming object tail: the table detail's name in the
 * breadcrumb, reference row 8 — the same bold text as the builder's
 * tail but no button, no rename, no hover invitation. The route's path
 * contribution stays the page's own concern.
 */
export function PlainCrumbTail({ name }: { name: string }) {
  const mounted = useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false,
  );
  if (!mounted) return null;
  const slot = document.getElementById("header-crumb-slot");
  if (!slot) return null;
  return createPortal(
    <span className={styles.crumbTail}>
      <span className={styles.crumbSep}>/</span>
      <span className={styles.plainName}>{name}</span>
    </span>,
    slot,
  );
}
