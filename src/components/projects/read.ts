"use client";

import { useCallback, useRef, useState } from "react";
import type { MapOverview, TableListing } from "../api";
import { readApiError, readRecipes } from "../api";
import { serverUnreachable } from "../failure-copy";
import { useAsync, type Async } from "../ui/AsyncState";
import type { WorkflowListing } from "../workflow-model";
import type { ProjectOverview } from "./model";

/**
 * The Projects list's composed read: the project overviews, the
 * unscoped map overview (the pictures and the unfiled map count), the
 * workflow-origin listing (displayed workflow counts — never the
 * overview's recipe count) and the whole dataset listing (the pictures'
 * dataset tiles; the unfiled count derives from it), as ONE honest load
 * state: an auxiliary failure fails the read rather than becoming a
 * false zero or an empty picture.
 */

export interface ProjectsWorld {
  projects: ProjectOverview[];
  maps: MapOverview[];
  workflows: WorkflowListing[];
  tables: TableListing[];
}

async function readJson<T>(path: string, doing: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { cache: "no-store" });
  } catch {
    throw new Error(serverUnreachable(doing));
  }
  if (!response.ok) throw new Error(await readApiError(response));
  return (await response.json()) as T;
}

export async function loadProjectsWorld(): Promise<ProjectsWorld> {
  const [projects, maps, workflows, tables] = await Promise.all([
    readJson<ProjectOverview[]>("/api/projects", "load the projects"),
    readJson<MapOverview[]>("/api/maps", "load the maps"),
    readRecipes("workflow"),
    readJson<TableListing[]>("/api/tables", "load the datasets"),
  ]);
  return { projects, maps, workflows, tables };
}

/** The composite sibling of the collection hook: one async value with
 * an in-place edits overlay (mutations update what is shown; a retry's
 * fresh answer discards them) and a quiet refresh that replaces the
 * shown value without re-entering pending. */
export function useProjectsWorld(): {
  state: Async<ProjectsWorld>;
  retry: () => void;
  mutate: (transform: (world: ProjectsWorld) => ProjectsWorld) => void;
  refresh: () => Promise<void>;
} {
  const { state: loadState, retry } = useAsync<ProjectsWorld>(
    loadProjectsWorld,
    "projects-world",
  );
  const [edits, setEdits] = useState<{
    base: ProjectsWorld;
    value: ProjectsWorld;
  } | null>(null);
  // Every mutation bumps the generation; a quiet refresh that started
  // before a newer mutation never overwrites it (the review's catch: a
  // snapshot read pre-create could arrive after and swallow the new
  // project until reload).
  const generation = useRef(0);

  const base = loadState.status === "ready" ? loadState.value : null;
  const value = base ? (edits && edits.base === base ? edits.value : base) : null;

  const mutate = useCallback(
    (transform: (world: ProjectsWorld) => ProjectsWorld) => {
      generation.current += 1;
      setEdits((current) => {
        const from =
          current && base && current.base === base ? current.value : base;
        if (!from || !base) return current;
        return { base, value: transform(from) };
      });
    },
    [base],
  );

  const refresh = useCallback(async () => {
    // After a dissolution the memberships change server-side in ways
    // the client cannot derive (a shared dataset keeps its other
    // memberships); a quiet re-read replaces the shown world without a
    // pending flash. A failed refresh keeps what is shown, and a
    // superseded one (a mutation landed after it started) writes
    // nothing.
    const started = generation.current;
    const fresh = await loadProjectsWorld();
    if (generation.current !== started) return;
    setEdits(base ? { base, value: fresh } : null);
  }, [base]);

  return { state: value ? { status: "ready", value } : loadState, retry, mutate, refresh };
}
