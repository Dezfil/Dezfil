"use client";

import { useEffect, useState } from "react";
import rail from "@/app/(workspace)/layout.module.css";
import styles from "./HealthDot.module.css";

/** Quiet readiness indicator wired to the documented health check. */
export function HealthDot() {
  const [state, setState] = useState<"checking" | "ready" | "unready">(
    "checking",
  );

  useEffect(() => {
    let cancelled = false;
    fetch("/api/health")
      .then((r) => {
        if (!cancelled) setState(r.ok ? "ready" : "unready");
      })
      .catch(() => {
        if (!cancelled) setState("unready");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // A dot in the rail's icon column; its label joins it when the rail is
  // expanded. The state rides on an attribute the journey watches. Row
  // geometry comes from the shared rail styles so the dot lines up with
  // the icons above it.
  return (
    <span
      className={styles.wrap}
      title={`instance ${state}`}
      aria-label={`instance ${state}`}
      data-health={state}
    >
      <span className={rail.railIcon}>
        <span className={styles.dot} data-state={state} />
      </span>
      <span className={rail.railStatusLabel}>instance {state}</span>
    </span>
  );
}
