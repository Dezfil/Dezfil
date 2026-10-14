"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ViewPrefs } from "@/lib/metadata/settings";
import type { Async } from "./ui/AsyncState";

type View = "grid" | "list";

/** How long a list waits for the stored view before it settles at the
 * defaults, as it does when the read fails. The read is one settings row
 * for the signed-in account and answers in tens of milliseconds, so this
 * is a hang guard, far above a working answer: a hung read never holds
 * the list for longer. */
export const STORED_VIEW_WAIT_MS = 2_000;

/** A list's load held at pending until its view is settled, so a stored
 * list view never paints as the default grid first. A failed load shows
 * at once: it reads the same in either view. */
export function untilViewSettled<T>(
  state: Async<T>,
  settled: boolean,
): Async<T> {
  return settled || state.status !== "ready" ? state : { status: "pending" };
}

/**
 * A screen's view and sort belong to the signed-in account. Entry performs
 * a full navigation on account changes, so each account starts with a fresh
 * component state and reads only its own persisted preferences.
 *
 * `settled` says the view to draw is known: the stored answer is in, the
 * read failed or outlasted its wait, or the person chose first. Before it,
 * a screen draws neither view.
 */
export function useViewPrefs<Sort extends string>(
  screen: keyof ViewPrefs,
  defaultSort: Sort,
  validSorts: readonly Sort[],
) {
  const [view, setViewState] = useState<View>("grid");
  const [sort, setSortState] = useState<Sort>(defaultSort);
  // A field the person set before the stored answer arrived keeps their
  // value; the field they left alone still takes the stored one.
  const chosen = useRef({ view: false, sort: false });
  const [answered, setAnswered] = useState(false);
  const [choseFirst, setChoseFirst] = useState(false);

  useEffect(() => {
    // Over once unmounted or given up on: an answer after that changes
    // nothing, so a list already drawn at the defaults stays as drawn.
    let over = false;
    const giveUp = setTimeout(() => {
      over = true;
      setAnswered(true);
    }, STORED_VIEW_WAIT_MS);
    (async () => {
      try {
        const response = await fetch("/api/settings", { cache: "no-store" });
        if (!response.ok) return;
        const body = (await response.json()) as { viewPrefs?: ViewPrefs };
        const prefs = body.viewPrefs?.[screen];
        if (over || !prefs) return;
        if (
          !chosen.current.view &&
          (prefs.view === "grid" || prefs.view === "list")
        )
          setViewState(prefs.view);
        if (!chosen.current.sort && validSorts.includes(prefs.sort as Sort))
          setSortState(prefs.sort as Sort);
      } catch {
        // Defaults are fine; preferences are a nicety, never a blocker.
      } finally {
        if (!over) {
          clearTimeout(giveUp);
          setAnswered(true);
        }
      }
    })();
    return () => {
      over = true;
      clearTimeout(giveUp);
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
      chosen.current.view = true;
      setChoseFirst(true);
      setViewState(v);
      persist({ view: v });
    },
    [persist],
  );

  const setSort = useCallback(
    (s: Sort) => {
      chosen.current.sort = true;
      setChoseFirst(true);
      setSortState(s);
      persist({ sort: s });
    },
    [persist],
  );

  return { view, sort, settled: answered || choseFirst, setView, setSort };
}
