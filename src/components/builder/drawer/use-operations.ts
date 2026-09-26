"use client";

import { useEffect, useState } from "react";
import type { OperationDef } from "@/lib/operations/catalog";
import { readApiError, readOperations } from "../../api";

/**
 * The operation catalog, read as data.
 *
 * **The drawer renders from the same endpoint an agent discovers**, so the
 * picker and the parameter grid cannot drift from what the run endpoint
 * accepts: a verb this instance does not offer cannot appear here, and a verb
 * added by a later spec appears without this module changing.
 */
export function useOperations(): {
  operations: OperationDef[] | null;
  error: string | null;
} {
  const [answer, setAnswer] = useState<{
    operations: OperationDef[] | null;
    error: string | null;
  }>({ operations: null, error: null });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // The request itself is shared with the workflow canvas.
        const operations = await readOperations();
        if (!cancelled) setAnswer({ operations, error: null });
      } catch (e) {
        if (cancelled) return;
        setAnswer({
          operations: [],
          error:
            e instanceof Error ? e.message : "Could not load the operations.",
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return answer;
}

/** A table's columns, for the parameters that name one. Null while unknown —
 * a field picker with no columns yet says so rather than offering none. */
export function useTableColumns(name: string | null): {
  columns: { name: string; type: string }[] | null;
  error: string | null;
} {
  // The answer carries **which table it is about**, so a stale one is
  // discarded at render rather than cleared by an effect — the picker for a
  // newly chosen input never briefly offers the previous input's columns.
  const [answer, setAnswer] = useState<{
    of: string | null;
    columns: { name: string; type: string }[] | null;
    error: string | null;
  }>({ of: null, columns: null, error: null });

  useEffect(() => {
    if (!name) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/tables/${encodeURIComponent(name)}`);
        if (!response.ok) throw new Error(await readApiError(response));
        const table = (await response.json()) as {
          columns: { name: string; type: string }[];
        };
        if (!cancelled) setAnswer({ of: name, columns: table.columns, error: null });
      } catch (e) {
        if (cancelled) return;
        setAnswer({
          of: name,
          columns: [],
          error: e instanceof Error ? e.message : "Could not read its columns.",
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [name]);

  return answer.of === name && name !== null
    ? { columns: answer.columns, error: answer.error }
    : { columns: null, error: null };
}
