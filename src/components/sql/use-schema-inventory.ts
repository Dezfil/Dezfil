"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { TableInspection, TableListing } from "../api";
import { readApiError } from "../api";
import type { SqlCompletion } from "../sql-editor-extensions";
import { SPATIAL_FUNCTIONS } from "./sql-snippets";

/**
 * The schema inventory (a bounded client cache). Once the listing lands,
 * every table's inspection is read with limited concurrency into one cache
 * that feeds column search, the unfolded columns, the table preview's rows
 * and the editor's completion. Pending and failed entries are visible to
 * the pane; a save or an import invalidates the affected table so it is
 * re-read, and a table that left the listing leaves the cache.
 */

export interface TableSchema {
  columns: { name: string; type: string }[];
  preview: Record<string, unknown>[];
  geometryColumn: string | null;
  rowCount: number;
}

export type SchemaEntry =
  | { status: "pending" }
  | { status: "ready"; schema: TableSchema }
  | { status: "failed"; error: string };

const CONCURRENCY = 3;

async function inspect(name: string): Promise<TableSchema> {
  const response = await fetch(`/api/tables/${encodeURIComponent(name)}`);
  if (!response.ok) throw new Error(await readApiError(response));
  const body = (await response.json()) as TableInspection;
  return {
    columns: body.columns,
    preview: body.preview,
    geometryColumn: body.geometryColumn,
    rowCount: body.rowCount,
  };
}

interface Engine {
  queue: string[];
  inFlight: number;
  generation: number;
  pump: () => void;
  enqueue: (name: string, front?: boolean) => void;
  keepOnly: (names: Set<string>) => void;
  stop: () => void;
}

function createEngine(
  setEntries: React.Dispatch<React.SetStateAction<Map<string, SchemaEntry>>>,
): Engine {
  const engine: Engine = {
    queue: [],
    inFlight: 0,
    generation: 0,
    pump() {
      while (engine.inFlight < CONCURRENCY && engine.queue.length) {
        const name = engine.queue.shift()!;
        const gen = engine.generation;
        engine.inFlight += 1;
        void inspect(name)
          .then((schema) => {
            if (gen !== engine.generation) return;
            setEntries((m) =>
              new Map(m).set(name, { status: "ready", schema }),
            );
          })
          .catch((e: unknown) => {
            if (gen !== engine.generation) return;
            setEntries((m) =>
              new Map(m).set(name, {
                status: "failed",
                error:
                  e instanceof Error ? e.message : "Could not read the table.",
              }),
            );
          })
          .finally(() => {
            engine.inFlight -= 1;
            engine.pump();
          });
      }
    },
    enqueue(name, front = false) {
      if (engine.queue.includes(name)) return;
      if (front) engine.queue.unshift(name);
      else engine.queue.push(name);
    },
    keepOnly(names) {
      engine.queue = engine.queue.filter((n) => names.has(n));
    },
    stop() {
      engine.generation += 1;
      engine.queue = [];
    },
  };
  return engine;
}

export function useSchemaInventory(tables: readonly TableListing[] | null) {
  const [entries, setEntries] = useState<Map<string, SchemaEntry>>(
    () => new Map(),
  );
  // The read queue and its in-flight count live in one engine object
  // created once — the pump runs across renders and chains on itself.
  const [engine] = useState(() => createEngine(setEntries));

  /** (Re)read one table now — after a save, an import, or a failed read. */
  const invalidate = useCallback(
    (name: string) => {
      setEntries((m) => new Map(m).set(name, { status: "pending" }));
      engine.enqueue(name, true);
      engine.pump();
    },
    [engine],
  );

  // Follow the listing: a name without an entry is pending by definition
  // (no state write needed), so the effect only feeds the engine — the
  // external system — and the entries arrive through its callbacks.
  useEffect(() => {
    if (!tables) return;
    const names = new Set(tables.map((t) => t.name));
    for (const name of names) {
      if (!entries.has(name)) engine.enqueue(name);
    }
    engine.keepOnly(names);
    engine.pump();
    // `entries` is deliberately not a dependency: a landing entry must not
    // re-walk the listing; the listing itself is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tables, engine]);

  const listed = useMemo(
    () => new Set((tables ?? []).map((t) => t.name)),
    [tables],
  );

  useEffect(() => () => engine.stop(), [engine]);

  const get = useCallback(
    (name: string): SchemaEntry | undefined =>
      entries.get(name) ?? (listed.has(name) ? { status: "pending" } : undefined),
    [entries, listed],
  );
  const columnsOf = useCallback(
    (name: string): readonly string[] | null => {
      const e = entries.get(name);
      return e?.status === "ready" ? e.schema.columns.map((c) => c.name) : null;
    },
    [entries],
  );

  /** What the editor completes from: every listed table (so names complete
   * at once), with columns as they arrive. */
  const completion = useMemo<SqlCompletion>(() => {
    const out: Record<string, string[]> = {};
    for (const t of tables ?? []) {
      const e = entries.get(t.name);
      out[t.name] =
        e?.status === "ready" ? e.schema.columns.map((c) => c.name) : [];
    }
    return { tables: out, functions: SPATIAL_FUNCTIONS };
  }, [tables, entries]);

  const progress = useMemo(() => {
    let ready = 0;
    let failed = 0;
    for (const name of listed) {
      const e = entries.get(name);
      if (e?.status === "ready") ready += 1;
      else if (e?.status === "failed") failed += 1;
    }
    return { ready, failed, total: listed.size };
  }, [entries, listed]);

  return { get, columnsOf, invalidate, completion, progress };
}
