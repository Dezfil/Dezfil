"use client";

import { useCallback, useEffect, useState } from "react";
import { readApiError } from "../api";

/**
 * The source panel's documented table read: the facts the listing does
 * not carry, from `GET /api/tables/{name}`. The answer says which table
 * it is about, so a stale one never dresses the next selection; a
 * failed read keeps the panel and offers Retry.
 */

export interface TableFacts {
  rowCount: number;
  geometryColumn: string | null;
  geometryType: string | null;
  sourceFilename: string | null;
  format: string;
  columns: { name: string; type: string }[];
  /** A derived table's recorded inputs; null for an imported one. */
  inputs: { name: string | null; missing?: boolean }[] | null;
}

export type TableRead =
  | { state: "reading" }
  | { state: "read"; facts: TableFacts }
  | { state: "failed"; message: string; retry: () => void };

export function useTableFacts(name: string | null): TableRead {
  const [attempt, setAttempt] = useState(0);
  const [answer, setAnswer] = useState<{ of: string; at: number; read: TableRead } | null>(null);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  useEffect(() => {
    if (!name) return;
    let cancelled = false;
    const of = name;
    const at = attempt;
    void (async () => {
      try {
        const response = await fetch(`/api/tables/${encodeURIComponent(of)}`);
        if (!response.ok) throw new Error(await readApiError(response));
        const body = (await response.json()) as TableFacts & { inputs: { name: string | null; missing?: boolean }[] | null };
        if (cancelled) return;
        setAnswer({
          of,
          at,
          read: {
            state: "read",
            facts: {
              rowCount: body.rowCount,
              geometryColumn: body.geometryColumn,
              geometryType: body.geometryType,
              sourceFilename: body.sourceFilename,
              format: body.format,
              columns: body.columns ?? [],
              inputs: body.inputs ?? null,
            },
          },
        });
      } catch (e) {
        if (cancelled) return;
        setAnswer({ of, at, read: { state: "failed", message: e instanceof Error ? e.message : "Could not read the table.", retry } });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [name, attempt, retry]);
  if (!name) return { state: "reading" };
  if (answer && answer.of === name && answer.at === attempt) return answer.read;
  return { state: "reading" };
}
