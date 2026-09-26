"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { TableListing } from "../api";
import { readTables } from "../api";
import { serverUnreachable } from "../failure-copy";

/**
 * The console's table listing: pending, failed and ready are the
 * AsyncState contract's states; a refresh after a save or an import
 * re-reads while the current list stays on screen — the browser never
 * blinks back to "Reading your tables…" for a list it already has. A
 * late answer from a superseded read never lands.
 */
export type ListingState =
  | { status: "pending" }
  | { status: "failed"; error: string }
  | { status: "ready"; value: TableListing[] };

export function useTableListing() {
  const [state, setState] = useState<ListingState>({ status: "pending" });
  const attempt = useRef(0);

  const load = useCallback(async (keep: boolean) => {
    const mine = ++attempt.current;
    if (!keep) setState({ status: "pending" });
    try {
      // The request itself is shared with the workflow canvas.
      const value = await readTables();
      if (mine === attempt.current) setState({ status: "ready", value });
    } catch (e) {
      if (mine !== attempt.current) return;
      setState((s) =>
        keep && s.status === "ready"
          ? s
          : {
              status: "failed",
              error: e instanceof Error ? e.message : serverUnreachable("read your tables"),
            },
      );
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  const retry = useCallback(() => void load(false), [load]);
  const refresh = useCallback(() => void load(true), [load]);
  return { state, retry, refresh };
}
