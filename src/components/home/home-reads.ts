"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TemplateList } from "@/lib/templates/card";
import type { MapOverview, TableListing } from "../api";
import { readRecipes } from "../api";
import { readJson } from "../projects/home-read";
import type { ProjectOverview } from "../projects/model";
import { readLastRun, type LastRun } from "../projects/run-history";
import type { HomeProject, HomeRead, HomeReads } from "./home-model";

/**
 * Home's reads, each list its own state as the signed-in account reads
 * it: the maps, the workflows of workflow origin, the datasets, the
 * projects (their names and how the reader stands to each) and the
 * template list. A part draws as its own read answers, and Try again asks
 * that read alone again. Every attempt owns its answer: an older answer
 * that lands after a newer attempt began is dropped, so a slow first read
 * never overwrites a fresher one.
 */

export type HomeList = keyof HomeReads;

/** The projects list as Home holds it: each project's name, for a where
 * line, and how the reader stands to it, for who may run what. */
export function homeProjects(list: readonly ProjectOverview[]): HomeProject[] {
  return list.map((p) => ({ id: p.id, name: p.name, role: p.role }));
}

const LOADERS: { [K in HomeList]: () => Promise<HomeReads[K] extends HomeRead<infer T> ? T : never> } = {
  maps: () => readJson<MapOverview[]>("/api/maps", "load the maps"),
  workflows: () => readRecipes("workflow"),
  tables: () => readJson<TableListing[]>("/api/tables", "load the datasets"),
  projects: () => readJson<ProjectOverview[]>("/api/projects", "load the projects").then(homeProjects),
  templates: () => readJson<TemplateList>("/api/templates", "load the templates"),
};

/** One read: its state, Try again (pending until the answer), and a quiet
 * re-read that keeps what is shown until its own answer lands; a quiet
 * re-read that fails leaves a shown answer in place. */
function useRead<T>(load: () => Promise<T>): {
  state: HomeRead<T>;
  retry: () => void;
  reload: () => void;
} {
  const [state, setState] = useState<HomeRead<T>>({ status: "pending" });
  const latest = useRef(0);

  // Each attempt is numbered; only the newest one's answer is taken.
  const run = useCallback(
    (quiet: boolean) => {
      latest.current += 1;
      const mine = latest.current;
      load().then(
        (value) => {
          if (latest.current === mine) setState({ status: "ready", value });
        },
        (cause: unknown) => {
          if (latest.current !== mine) return;
          const error = cause instanceof Error ? cause.message : "Something went wrong.";
          setState((shown) => (quiet && shown.status === "ready" ? shown : { status: "failed", error }));
        },
      );
    },
    [load],
  );

  useEffect(() => {
    run(false);
    // Leaving disowns whatever is in flight.
    return () => {
      latest.current += 1;
    };
  }, [run]);

  const retry = useCallback(() => {
    setState({ status: "pending" });
    run(false);
  }, [run]);
  const reload = useCallback(() => run(true), [run]);
  return { state, retry, reload };
}

export interface HomeReadsHandle {
  reads: HomeReads;
  /** Ask one list again, its part pending until the answer. */
  retry: Record<HomeList, () => void>;
  /** Re-read one list quietly, what is shown staying until the answer. */
  reload: Record<HomeList, () => void>;
}

export function useHomeReads(): HomeReadsHandle {
  const maps = useRead(LOADERS.maps);
  const workflows = useRead(LOADERS.workflows);
  const tables = useRead(LOADERS.tables);
  const projects = useRead(LOADERS.projects);
  const templates = useRead(LOADERS.templates);
  const reads = useMemo<HomeReads>(
    () => ({
      maps: maps.state,
      workflows: workflows.state,
      tables: tables.state,
      projects: projects.state,
      templates: templates.state,
    }),
    [maps.state, workflows.state, tables.state, projects.state, templates.state],
  );
  const retry = useMemo(
    () => ({
      maps: maps.retry,
      workflows: workflows.retry,
      tables: tables.retry,
      projects: projects.retry,
      templates: templates.retry,
    }),
    [maps.retry, workflows.retry, tables.retry, projects.retry, templates.retry],
  );
  const reload = useMemo(
    () => ({
      maps: maps.reload,
      workflows: workflows.reload,
      tables: tables.reload,
      projects: projects.reload,
      templates: templates.reload,
    }),
    [maps.reload, workflows.reload, tables.reload, projects.reload, templates.reload],
  );
  return { reads, retry, reload };
}

/** The leading workflow's newest run, read once when a workflow comes to
 * lead (null when none leads); "pending" until that read answers, so the
 * card shows the glyph and never "Never run" meanwhile. */
export function useLeadHistory(workflowId: string | null): LastRun | "pending" {
  const [answer, setAnswer] = useState<{ id: string; value: LastRun } | null>(null);
  useEffect(() => {
    if (workflowId === null) return;
    let current = true;
    void readLastRun(workflowId).then((value) => {
      if (current) setAnswer({ id: workflowId, value });
    });
    return () => {
      current = false;
    };
  }, [workflowId]);
  return workflowId !== null && answer?.id === workflowId ? answer.value : "pending";
}
