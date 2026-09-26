"use client";

import { useCallback, useEffect, useState } from "react";
import type { ViewPrefs } from "@/lib/metadata/settings";

type View = "grid" | "list";

/**
 * A screen's persisted view mode + sort: read once from workspace
 * settings, write back fire-and-forget on change — the same store as
 * the display name, still no auth implied.
 */
export function useViewPrefs<Sort extends string>(
  screen: keyof ViewPrefs,
  defaultSort: Sort,
  validSorts: readonly Sort[],
) {
  const [view, setViewState] = useState<View>("grid");
  const [sort, setSortState] = useState<Sort>(defaultSort);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/settings");
        if (!response.ok) return;
        const body = (await response.json()) as { viewPrefs?: ViewPrefs };
        const prefs = body.viewPrefs?.[screen];
        if (cancelled || !prefs) return;
        if (prefs.view === "grid" || prefs.view === "list")
          setViewState(prefs.view);
        if (validSorts.includes(prefs.sort as Sort))
          setSortState(prefs.sort as Sort);
      } catch {
        // Defaults are fine; preferences are a nicety, never a blocker.
      }
    })();
    return () => {
      cancelled = true;
    };
    // validSorts is a constant list per call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen]);

  const persist = useCallback(
    (patch: { view?: View; sort?: Sort }) => {
      void fetch("/api/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ viewPrefs: { [screen]: patch } }),
      }).catch(() => {});
    },
    [screen],
  );

  const setView = useCallback(
    (v: View) => {
      setViewState(v);
      persist({ view: v });
    },
    [persist],
  );

  const setSort = useCallback(
    (s: Sort) => {
      setSortState(s);
      persist({ sort: s });
    },
    [persist],
  );

  return { view, sort, setView, setSort };
}
