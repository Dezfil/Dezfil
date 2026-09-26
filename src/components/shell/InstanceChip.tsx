"use client";

import styles from "@/app/(workspace)/layout.module.css";
import { useInstanceName } from "./path-model";

/** The instance's name beside the wordmark: a chip only when the instance is named — never an empty pill.
 * Lives in the workspace shell, so the published viewer never mounts
 * it. */
export function InstanceChip() {
  const name = useInstanceName();
  if (!name) return null;
  return (
    <span className={styles.instChip} title="This instance">
      {name}
    </span>
  );
}
