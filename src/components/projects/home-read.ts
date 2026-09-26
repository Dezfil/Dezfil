"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { MapOverview, TableListing } from "../api";
import { readApiError, readRecipes } from "../api";
import { serverUnreachable } from "../failure-copy";
import { ProjectHomeReader, type HomeAction, type HomeField, type HomeSave } from "./home-reader";
import type { WorkflowListing } from "../workflow-model";

/**
 * The project home's reads: the record and the three scoped,
 * origin-composed listings as one honest load state, and, for the empty
 * home and the picker, the workspace catalogue — the three unscoped
 * listings — read only when asked.
 */

export interface ProjectRecordWire {
  id: string;
  name: string;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HomeWorld {
  record: ProjectRecordWire;
  maps: MapOverview[];
  workflows: WorkflowListing[];
  tables: TableListing[];
  /** Every project's name, for a shared dataset's other memberships. */
  names: Map<string, string>;
  /** The newest recorded run's start per workflow: an ISO time, null
   * when none is recorded, "unreadable" when the history read failed —
   * never invented (the spec's most-recent-recorded-run fact). */
  lastRuns: Map<string, string | null | "unreadable">;
}

export type HomeState =
  | { status: "pending" }
  | { status: "missing"; message: string }
  | { status: "failed"; error: string }
  | { status: "ready"; value: HomeWorld };

export async function readJson<T>(path: string, doing: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { cache: "no-store" });
  } catch {
    throw new Error(serverUnreachable(doing));
  }
  if (!response.ok) throw new Error(await readApiError(response));
  return (await response.json()) as T;
}

/** One composite read, two-phased so an unknown project classifies as
 * missing (its own designed state) rather than a generic failure. */
export async function readHome(id: string): Promise<HomeState> {
  let record: ProjectRecordWire;
  try {
    let response: Response;
    try {
      response = await fetch(`/api/projects/${id}`, { cache: "no-store" });
    } catch {
      throw new Error(serverUnreachable("load the project"));
    }
    if (response.status === 404) {
      return { status: "missing", message: await readApiError(response) };
    }
    if (!response.ok) throw new Error(await readApiError(response));
    record = (await response.json()) as ProjectRecordWire;
  } catch (e) {
    return {
      status: "failed",
      error:
        e instanceof Error ? e.message : serverUnreachable("load the project"),
    };
  }
  try {
    const [maps, workflows, tables, projects] = await Promise.all([
      readJson<MapOverview[]>(`/api/maps?project=${id}`, "load the maps"),
      readJson<{ recipes: WorkflowListing[] }>(
        `/api/recipes?origin=workflow&project=${id}`,
        "load the workflows",
      ).then((body) => body.recipes),
      readJson<TableListing[]>(`/api/tables?project=${id}`, "load the datasets"),
      readJson<{ id: string; name: string }[]>(
        "/api/projects",
        "load the projects",
      ),
    ]);
    const lastRuns = new Map<string, string | null | "unreadable">(
      await Promise.all(
        workflows.map(
          async (w): Promise<[string, string | null | "unreadable"]> => {
            try {
              const body = await readJson<{ runs: { startedAt: string }[] }>(
                `/api/recipes/${w.id}/runs`,
                "read the runs",
              );
              return [w.id, body.runs[0]?.startedAt ?? null];
            } catch {
              return [w.id, "unreadable"];
            }
          },
        ),
      ),
    );
    return {
      status: "ready",
      value: {
        record,
        maps,
        workflows,
        tables,
        names: new Map(projects.map((p) => [p.id, p.name])),
        lastRuns,
      },
    };
  } catch (e) {
    return {
      status: "failed",
      error:
        e instanceof Error ? e.message : serverUnreachable("load the project"),
    };
  }
}

export function useProjectHome(id: string) {
  const reader = useMemo(() => new ProjectHomeReader(readHome), []);
  const visit = useMemo(() => ({ id }), [id]);
  const snapshot = useSyncExternalStore(reader.subscribe, reader.getSnapshot, reader.getSnapshot);
  useEffect(() => {
    void reader.activate(visit);
    return () => reader.dispose(visit);
  }, [reader, visit]);
  const actions = useMemo(() => ({
    retry: () => { void reader.retry(visit); },
    refresh: () => reader.refresh(visit),
    confirmMembership: () => reader.confirmMembership(visit),
    beginAction: () => reader.beginAction(visit),
    ownsAction: (action: HomeAction) => reader.ownsAction(action),
    beginSave: (field: HomeField) => reader.beginSave(visit, field),
    ownsSave: (save: HomeSave) => reader.ownsSave(save),
    acceptSave: (save: HomeSave, record: ProjectRecordWire) => reader.acceptSave(save, record),
  }), [reader, visit]);
  const state: HomeState = snapshot.visit === visit ? snapshot.state : { status: "pending" };
  return { state, ...actions };
}

/* ---- the workspace catalogue (behaviors 8 and 11) ---- */

export interface Catalogue {
  maps: MapOverview[];
  workflows: WorkflowListing[];
  tables: TableListing[];
}

export type CatalogueState =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "failed"; error: string }
  | { status: "ready"; value: Catalogue };

export async function readCatalogue(): Promise<Catalogue> {
  const [maps, workflows, tables] = await Promise.all([
    readJson<MapOverview[]>("/api/maps", "load the maps"),
    readRecipes("workflow"),
    readJson<TableListing[]>("/api/tables", "load the datasets"),
  ]);
  return { maps, workflows, tables };
}

/** The three unscoped listings, read only while wanted (an empty home,
 * an open picker); a failed read is its own state, never an empty
 * catalogue. `reload` re-reads quietly, keeping what is shown until
 * the answer lands. */
export function useCatalogue(wanted: boolean): {
  state: CatalogueState;
  reload: () => Promise<void>;
  retry: () => void;
} {
  const [attempt, setAttempt] = useState(0);
  const [answered, setAnswered] = useState<{
    attempt: number;
    state: CatalogueState;
  }>({ attempt: -1, state: { status: "idle" } });

  useEffect(() => {
    if (!wanted) return;
    let cancelled = false;
    const mine = attempt;
    void readCatalogue()
      .then((value) => {
        if (!cancelled) setAnswered({ attempt: mine, state: { status: "ready", value } });
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setAnswered({
            attempt: mine,
            state: {
              status: "failed",
              error:
                e instanceof Error ? e.message : serverUnreachable("load the workspace"),
            },
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [wanted, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const reload = useCallback(async () => {
    try {
      const value = await readCatalogue();
      setAnswered((current) => ({ ...current, state: { status: "ready", value } }));
    } catch {
      /* What is shown stays; the next open re-reads */
    }
  }, []);

  const state: CatalogueState = !wanted
    ? { status: "idle" }
    : answered.attempt === attempt
      ? answered.state
      : { status: "pending" };
  return { state, reload, retry };
}
