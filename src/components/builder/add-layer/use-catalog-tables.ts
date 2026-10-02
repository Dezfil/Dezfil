"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { TableListing } from "../../api";
import { readApiError } from "../../api";
import { scopeParam, type ProjectScope } from "../../scope/model";
import { readProjectsDirectory } from "../../scope/use-scope-world";

/** The catalog's base world: the project directory and the
 * unscoped listing — the popover's rows and counts, and All's rows. */
export interface CatalogWorld {
  projects: { id: string; name: string }[];
  all: TableListing[];
}

/** What the shared browser renders from — one bundle, so the Tables
 * view and the SQL workbench cannot drift apart. */
export interface CatalogListing {
  world: CatalogWorld | null;
  worldError: string | null;
  /** The active scope's rows: All rides the base world with no second
   * fetch; a named or unfiled scope rides the documented scoped
   * listing. Null while pending — never another scope's rows. */
  offered: TableListing[] | null;
  /** The scoped listing's own failure — a deleted project surfaces the
   * server's refusal here, never a silent All. */
  offeredError: string | null;
  scope: ProjectScope;
  onScope: (id: string) => void;
  onRetry: () => void;
  /** A dataset as the map's SQL types it; the reader's console's way
   * without a map. */
  typed?: (table: TableListing) => string;
  /** The line under the scope on someone else's map. */
  homeLine?: { lead: string; example: string } | null;
}

async function readListing(scopeKey: string | null): Promise<TableListing[]> {
  const target =
    scopeKey === null
      ? "/api/tables"
      : `/api/tables?project=${encodeURIComponent(scopeKey)}`;
  let response: Response;
  try {
    response = await fetch(target);
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : "Network failure.");
  }
  if (!response.ok) throw new Error(await readApiError(response));
  return (await response.json()) as TableListing[];
}

/**
 * The catalog's reads (extracted from the dialog at its touch): truth
 * re-established per attempt (the / pattern), re-read when a mid-batch
 * import changes the authoritative set (stamp), and the active scope
 * keyed to attempt and scope — the keyed-async contract, so a
 * superseded scope's answer can never repaint a newer one. `onOffered`
 * fires as each offered set resolves, so the host can settle decisions
 * (a stored pick absent from the new truth is cleared, never merely
 * hidden).
 */
export function useCatalogTables(opts: {
  scope: ProjectScope;
  listingStamp: number;
  onOffered?: (tables: TableListing[]) => void;
}): { listing: Omit<CatalogListing, "scope" | "onScope">; retry: () => void } {
  const { scope, listingStamp, onOffered } = opts;
  const [attempt, setAttempt] = useState(1);
  const [base, setBase] = useState<{
    attempt: number;
    stamp: number;
    world: CatalogWorld | null;
    error: string | null;
  }>({ attempt: 0, stamp: -1, world: null, error: null });
  const scopeKey = scope.kind === "all" ? null : scopeParam(scope);
  // The live scope at settle time: a read that lands after the scope
  // moved on must not announce its rows as the offered truth. Effect-
  // updated, and every settle runs strictly after effects.
  const scopeKeyRef = useRef(scopeKey);
  useEffect(() => {
    scopeKeyRef.current = scopeKey;
  }, [scopeKey]);
  const [scoped, setScoped] = useState<{
    attempt: number;
    stamp: number;
    key: string;
    tables: TableListing[] | null;
    error: string | null;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const mark = { attempt, stamp: listingStamp };
    void (async () => {
      try {
        const [projects, all] = await Promise.all([
          readProjectsDirectory(),
          readListing(null),
        ]);
        if (cancelled) return;
        setBase({ ...mark, world: { projects, all }, error: null });
        if (scopeKeyRef.current === null) onOffered?.(all);
      } catch (e) {
        if (!cancelled) {
          setBase({
            ...mark,
            world: null,
            error: e instanceof Error ? e.message : "Network failure.",
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // scopeKey/onOffered ride the read that is in flight; only a new
    // attempt or a changed authoritative set re-runs the base read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt, listingStamp]);

  useEffect(() => {
    if (scopeKey === null) return;
    let cancelled = false;
    const mark = { attempt, stamp: listingStamp, key: scopeKey };
    void (async () => {
      try {
        const tables = await readListing(scopeKey);
        if (cancelled) return;
        setScoped({ ...mark, tables, error: null });
        if (scopeKeyRef.current === mark.key) onOffered?.(tables);
      } catch (e) {
        if (!cancelled) {
          setScoped({
            ...mark,
            tables: null,
            error: e instanceof Error ? e.message : "Network failure.",
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt, listingStamp, scopeKey]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  // The answered-attempt pattern: an older read's leftovers are not
  // this attempt's truth, and another scope's answer is not this one's.
  const baseAnswered =
    base.attempt === attempt && base.stamp === listingStamp ? base : null;
  const scopedAnswered =
    scopeKey !== null &&
    scoped !== null &&
    scoped.attempt === attempt &&
    scoped.stamp === listingStamp &&
    scoped.key === scopeKey
      ? scoped
      : null;

  const world = baseAnswered?.world ?? null;
  return {
    listing: {
      world,
      worldError: baseAnswered?.error ?? null,
      offered:
        scopeKey === null ? (world?.all ?? null) : (scopedAnswered?.tables ?? null),
      offeredError: scopeKey === null ? null : (scopedAnswered?.error ?? null),
      onRetry: retry,
    },
    retry,
  };
}
