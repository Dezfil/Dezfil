"use client";

import { useCallback, useEffect, useState } from "react";
import { readApiError, type TableListing } from "../../api";

/**
 * The workspace's tables, as every surface inside the drawer reads them.
 *
 * Three questions need this same list and would otherwise each fetch their
 * own: which tables an operation may read, whether the name the Result section
 * promises is already taken, and which tables are recipe outputs. Sharing one
 * load is also what keeps those three answers **consistent with each other** —
 * a form that validated a name against a list older than the picker beside it
 * would refuse a name that is free, or promise one that is not.
 */
export interface WorkspaceTablesPort {
  tables: TableListing[] | null;
  error: string | null;
  reload: () => void;
  /** Whether a name is already registered — the comparison the registry makes,
   * which is case-insensitive. */
  taken: (name: string) => boolean;
}

export function useWorkspaceTables(): WorkspaceTablesPort {
  const [answer, setAnswer] = useState<{
    tables: TableListing[] | null;
    error: string | null;
  }>({ tables: null, error: null });
  // A reload is a new attempt, not a mutation of the old one: the effect keys
  // on the number, so a load in flight is abandoned rather than raced.
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  const { tables, error } = answer;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/tables");
        if (!response.ok) throw new Error(await readApiError(response));
        const loaded = (await response.json()) as TableListing[];
        if (!cancelled) setAnswer({ tables: loaded, error: null });
      } catch (e) {
        if (cancelled) return;
        setAnswer({
          tables: [],
          error: e instanceof Error ? e.message : "Could not load tables.",
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const taken = useCallback(
    (name: string) =>
      (tables ?? []).some(
        (t) => t.name.toLowerCase() === name.trim().toLowerCase(),
      ),
    [tables],
  );

  return { tables, error, reload, taken };
}
