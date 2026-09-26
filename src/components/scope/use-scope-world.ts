"use client";

import { useCallback, useRef, useState } from "react";
import { readApiError } from "../api";
import { serverUnreachable } from "../failure-copy";
import { useAsync, type Async } from "../ui/AsyncState";
import { scopeParam, type ProjectScope } from "./model";

/**
 * One scope world per screen: the project directory, the unscoped
 * listing of the kind (the popover's counts) and the documented
 * server-scoped listing for the active results — one
 * pending/failed/ready state keyed to the address, so a superseded
 * scope's answer cannot repaint a newer one (the keyed-async contract;
 * the several answers are not an atomic snapshot). An unknown, empty or
 * deleted scope is SENT THROUGH and surfaces the listing's own refusal
 * as the failure state — never a silent All. Mutations overlay in
 * place; the quiet refresh is generation-guarded so a read that started
 * before a newer mutation writes nothing.
 */

export interface ScopeWorld<T> {
  projects: { id: string; name: string }[];
  /** The unscoped collection: counts and, under All, the results. */
  all: T[];
  /** The active scope's results (=== all under All projects). */
  scoped: T[];
}

export async function readProjectsDirectory(): Promise<
  { id: string; name: string }[]
> {
  let response: Response;
  try {
    response = await fetch("/api/projects", { cache: "no-store" });
  } catch {
    throw new Error(serverUnreachable("load the projects"));
  }
  if (!response.ok) throw new Error(await readApiError(response));
  const listed = (await response.json()) as {
    id: string;
    name: string;
    updatedAt: string;
  }[];
  // The popover follows the Projects screen's default order: most
  // recently updated first (the listing itself arrives by creation).
  return [...listed].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function useScopeWorld<T>(opts: {
  kind: string;
  scope: ProjectScope;
  fetchUnscoped: () => Promise<T[]>;
  /** The documented composed listing; the raw address value rides
   * through so the server's own refusal reaches the failure state. */
  fetchScoped: (param: string) => Promise<T[]>;
}): {
  state: Async<ScopeWorld<T>>;
  retry: () => void;
  mutate: (transform: (world: ScopeWorld<T>) => ScopeWorld<T>) => void;
  refresh: () => Promise<void>;
} {
  const { kind, scope, fetchUnscoped, fetchScoped } = opts;
  const param = scope.kind === "invalid" ? "" : scopeParam(scope);

  const load = useCallback(async (): Promise<ScopeWorld<T>> => {
    const [projects, all, scoped] = await Promise.all([
      readProjectsDirectory(),
      fetchUnscoped(),
      param === null ? null : fetchScoped(param),
    ]);
    return { projects, all, scoped: scoped ?? all };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [param]);

  const { state: loadState, retry } = useAsync<ScopeWorld<T>>(
    load,
    `${kind}:${param ?? "all"}`,
  );
  const [edits, setEdits] = useState<{
    base: ScopeWorld<T>;
    value: ScopeWorld<T>;
  } | null>(null);
  const generation = useRef(0);

  const base = loadState.status === "ready" ? loadState.value : null;
  const value = base ? (edits && edits.base === base ? edits.value : base) : null;

  const mutate = useCallback(
    (transform: (world: ScopeWorld<T>) => ScopeWorld<T>) => {
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
    const started = generation.current;
    const fresh = await load();
    if (generation.current !== started) return;
    setEdits(base ? { base, value: fresh } : null);
  }, [base, load]);

  return {
    state: value ? { status: "ready", value } : loadState,
    retry,
    mutate,
    refresh,
  };
}
