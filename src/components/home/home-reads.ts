"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TemplateList } from "@/lib/templates/card";
import type { MapOverview, TableListing } from "../api";
import { readRecipes } from "../api";
import { readJson } from "../projects/home-read";
import type { ProjectOverview } from "../projects/model";
import { readLastRun, type LastRun } from "../projects/run-history";
import { asksRefresh, type HomeProject, type HomeRead, type HomeReads } from "./home-model";

/**
 * Home's reads, each list its own state as the signed-in account reads
 * it: the maps, the workflows of workflow origin, the datasets, the
 * projects (their names and how the reader stands to each) and the
 * template list. A part draws as its own read answers, and Try again asks
 * that read alone again. Every attempt owns its answer: an older answer
 * that lands after a newer attempt began is dropped, so a slow first read
 * never overwrites a fresher one. Once the template list answers, Home
 * asks the server to read the catalogue, as the Templates page does, and
 * the refresh's answer stands for that list.
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
 * re-read that fails leaves a shown answer in place. Each attempt answers
 * whether the read landed, and follows a newer attempt that replaced it:
 * an answer that was dropped says nothing about what is shown. */
function useRead<T>(load: () => Promise<T>): {
  state: HomeRead<T>;
  retry: () => void;
  reload: () => Promise<boolean>;
} {
  const [state, setState] = useState<HomeRead<T>>({ status: "pending" });
  const latest = useRef(0);
  const waiting = useRef(new Set<(landed: boolean) => void>());

  const answer = useCallback((landed: boolean) => {
    const waiters = waiting.current;
    waiting.current = new Set();
    for (const resolve of waiters) resolve(landed);
  }, []);

  // Each attempt is numbered; only the newest one's answer is taken.
  const run = useCallback(
    (quiet: boolean): Promise<boolean> => {
      latest.current += 1;
      const mine = latest.current;
      const landed = new Promise<boolean>((resolve) => waiting.current.add(resolve));
      load().then(
        (value) => {
          if (latest.current !== mine) return;
          setState({ status: "ready", value });
          answer(true);
        },
        (cause: unknown) => {
          if (latest.current !== mine) return;
          const error = cause instanceof Error ? cause.message : "Something went wrong.";
          setState((shown) => (quiet && shown.status === "ready" ? shown : { status: "failed", error }));
          answer(false);
        },
      );
      return landed;
    },
    [load, answer],
  );

  useEffect(() => {
    void run(false);
    // Leaving disowns whatever is in flight.
    return () => {
      latest.current += 1;
      answer(false);
    };
  }, [run, answer]);

  const retry = useCallback(() => {
    setState({ status: "pending" });
    void run(false);
  }, [run]);
  const reload = useCallback(() => run(true), [run]);
  return { state, retry, reload };
}

/** The server reads the catalogue again (its own ten-minute rule bounds
 * how often) and answers the list as it then stands; null when it did not
 * answer one. Home says nothing about the catalogue: the Templates page
 * says why it lists nothing, one link away. */
async function refreshTemplates(): Promise<TemplateList | null> {
  try {
    const response = await fetch("/api/templates/refresh", { method: "POST", cache: "no-store" });
    return response.ok ? ((await response.json()) as TemplateList) : null;
  } catch {
    return null;
  }
}

/** The template list as it stands: the list read's answer, then the
 * refresh's answer for it. The refresh is asked once per answer of the
 * list read, never while the catalogue is off or its saved address cannot
 * be read, so a retried list asks again; an answer for a list that has
 * since been read again is dropped. */
function useTemplateList(listRead: HomeRead<TemplateList>): HomeRead<TemplateList> {
  const [refreshed, setRefreshed] = useState<{ of: TemplateList; list: TemplateList } | null>(null);
  const asked = asksRefresh(listRead) && listRead.status === "ready" ? listRead.value : null;
  useEffect(() => {
    if (asked === null) return;
    let current = true;
    void refreshTemplates().then((list) => {
      if (current && list) setRefreshed({ of: asked, list });
    });
    return () => {
      current = false;
    };
  }, [asked]);
  return useMemo(
    () =>
      listRead.status === "ready" && refreshed?.of === listRead.value
        ? { status: "ready", value: refreshed.list }
        : listRead,
    [listRead, refreshed],
  );
}

export interface HomeReadsHandle {
  reads: HomeReads;
  /** Ask one list again, its part pending until the answer. */
  retry: Record<HomeList, () => void>;
  /** Re-read one list quietly, what is shown staying until the answer;
   * true when the read landed. */
  reload: Record<HomeList, () => Promise<boolean>>;
}

export function useHomeReads(): HomeReadsHandle {
  const maps = useRead(LOADERS.maps);
  const workflows = useRead(LOADERS.workflows);
  const tables = useRead(LOADERS.tables);
  const projects = useRead(LOADERS.projects);
  const templates = useRead(LOADERS.templates);
  const templateList = useTemplateList(templates.state);
  const reads = useMemo<HomeReads>(
    () => ({
      maps: maps.state,
      workflows: workflows.state,
      tables: tables.state,
      projects: projects.state,
      templates: templateList,
    }),
    [maps.state, workflows.state, tables.state, projects.state, templateList],
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

/** The leading workflow's newest run: read when a workflow comes to lead
 * (nothing when none leads), "pending" until that read answers, so the
 * card shows the glyph and never "Never run" meanwhile. Try again asks a
 * failed read again, pending until it answers; a quiet re-read keeps what
 * is shown until its own answer lands, and one that cannot read the
 * history leaves a shown answer in place. An answer is taken only for the
 * workflow that leads and from the newest attempt. */
export interface LeadHistory {
  lastRun: LastRun | "pending";
  retry: () => void;
  reload: () => void;
}

export function useLeadHistory(workflowId: string | null): LeadHistory {
  const [answer, setAnswer] = useState<{ id: string; value: LastRun } | null>(null);
  const latest = useRef(0);
  const leading = useRef(workflowId);
  useEffect(() => {
    leading.current = workflowId;
  });

  // One attempt at the history of `id`; only the newest attempt's answer
  // is taken. Quiet, an answer that cannot read the history leaves a shown
  // one in place.
  const ask = useCallback((id: string, quiet: boolean) => {
    latest.current += 1;
    const mine = latest.current;
    void readLastRun(id).then((value) => {
      if (latest.current !== mine) return;
      setAnswer((shown) => (quiet && value === "unreadable" && shown?.id === id ? shown : { id, value }));
    });
  }, []);

  useEffect(() => {
    if (workflowId === null) return;
    ask(workflowId, false);
    return () => {
      latest.current += 1;
    };
  }, [workflowId, ask]);

  const retry = useCallback(() => {
    const id = leading.current;
    if (id === null) return;
    // Pending again, the glyph alone, until the answer.
    setAnswer((shown) => (shown?.id === id ? null : shown));
    ask(id, false);
  }, [ask]);
  const reload = useCallback(() => {
    if (leading.current !== null) ask(leading.current, true);
  }, [ask]);
  const lastRun = workflowId !== null && answer?.id === workflowId ? answer.value : "pending";
  return { lastRun, retry, reload };
}

/** What a run tells Home, made into Home's re-read. A run's runner
 * notifies its recipe and its tables ports together as the run settles
 * (and its recipe port alone as it adopts a run or as it progresses):
 * the notifications of one turn share ONE re-read, begun after them, and
 * never a read already in flight, which began before the change and so
 * cannot answer for it. Answers whether the re-read landed. */
export function useRereadAfterRun(reread: () => Promise<boolean>): () => Promise<boolean> {
  const next = useRef<Promise<boolean> | null>(null);
  const current = useRef(reread);
  useEffect(() => {
    current.current = reread;
  });
  return useCallback(() => {
    if (next.current) return next.current;
    const asked = new Promise<boolean>((resolve) => {
      // Begun once this turn's notifications have all asked.
      queueMicrotask(() => {
        next.current = null;
        current.current().then(resolve, () => resolve(false));
      });
    });
    next.current = asked;
    return asked;
  }, []);
}
