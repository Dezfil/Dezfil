"use client";

import { useCallback, useEffect, useState } from "react";
import type { SourceGrouping } from "./source-groups";

/**
 * How the signed-in account groups the console's source list: by person
 * until it chooses by project. Read from and written to the account's
 * settings, like the list screens' view and sort, so the choice follows
 * the account and not the browser.
 */
export function useSourceGrouping(): [SourceGrouping, (next: SourceGrouping) => void] {
  const [grouping, setGrouping] = useState<SourceGrouping>("person");
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/settings", { cache: "no-store" });
        if (!response.ok) return;
        const body = (await response.json()) as { sourceGrouping?: unknown };
        if (cancelled) return;
        if (body.sourceGrouping === "person" || body.sourceGrouping === "project") setGrouping(body.sourceGrouping);
      } catch {
        // The default is fine; a preference is a nicety, never a blocker.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  const choose = useCallback((next: SourceGrouping) => {
    setGrouping(next);
    void fetch("/api/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceGrouping: next }),
    }).catch(() => {});
  }, []);
  return [grouping, choose];
}
