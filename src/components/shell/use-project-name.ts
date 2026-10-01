"use client";

import { useEffect, useState } from "react";
import { onPrivateReset, privateStateOpen } from "../auth/private-state";

/**
 * Project names for the shell's path: one cached read of the projects
 * listing, invalidated on demand — a rename must not serve stale and a
 * dissolved project must stop rendering a segment, so the cache is
 * disposable rather than durable. While unresolved, callers render
 * nothing: the path never shows an identifier, a placeholder or an
 * empty separator.
 */

export const PROJECTS_CHANGED_EVENT = "dezfil:projects-changed";

/** What the path knows of a project: its name, and how the reader stands
 * to it (its owner, their role) for the segment's people mark. */
export interface ProjectFact {
  name: string;
  role?: "owner" | "editor" | "viewer";
  owner?: { name: string; sqlName: string };
}

let cache: Map<string, ProjectFact> | null = null;
let inflight: Promise<Map<string, ProjectFact>> | null = null;
let generation = 0;
onPrivateReset(() => { cache = null; inflight = null; generation++; });

// The EVENT is the invalidation contract, not the function: any
// dispatcher — another bundle, a test — must drop the cache, and this
// module-scope listener runs before any hook's own (it registered
// first), so re-resolution never reads the stale map. The generation
// bump supersedes an in-flight read: its pre-mutation result must not
// repopulate the cache, and dropping `inflight` makes the next reader
// start a fresh request instead of reusing the stale promise.
if (typeof window !== "undefined") {
  window.addEventListener(PROJECTS_CHANGED_EVENT, () => {
    cache = null;
    generation += 1;
    inflight = null;
  });
}

async function readProjects(): Promise<Map<string, ProjectFact>> {
  const response = await fetch("/api/projects");
  if (!response.ok) throw new Error(String(response.status));
  const listed = (await response.json()) as (ProjectFact & { id: string })[];
  return new Map(
    listed.map((p) => [p.id, { name: p.name, role: p.role, owner: p.owner }]),
  );
}

function resolve(): Promise<Map<string, ProjectFact>> {
  if (cache) return Promise.resolve(cache);
  if (!inflight) {
    const started = generation;
    const read: Promise<Map<string, ProjectFact>> = readProjects()
      .then((names) => {
        // A superseded read never writes; its caller still receives the
        // names it asked for, and the invalidation event has already
        // triggered the fresh read that will correct the render.
        if (started === generation && privateStateOpen()) { cache = names; return names; }
        return new Map<string, ProjectFact>();
      })
      .finally(() => {
        // Only this read may clear the slot — an invalidation may have
        // installed a newer one.
        if (inflight === read) inflight = null;
      });
    inflight = read;
  }
  // A failed read stays uncached, so the next reader retries; the
  // caller meanwhile renders no segment.
  return inflight.catch(() => new Map<string, ProjectFact>());
}

/** Mutating surfaces call this after a project rename or delete; every
 * mounted segment re-resolves. The event carries the whole contract —
 * the module listener above does the invalidating. */
export function invalidateProjects(): void {
  window.dispatchEvent(new Event(PROJECTS_CHANGED_EVENT));
}

export function useProjectFact(id: string | null): ProjectFact | null {
  const [facts, setFacts] = useState<Map<string, ProjectFact> | null>(cache);
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    let version = 0;
    const read = () => {
      const requested = ++version;
      void resolve().then((resolved) => {
        // A fresh Map each settle: the state change must be visible even
        // when the underlying cache object was reused.
        if (!cancelled && requested === version) setFacts(new Map(resolved));
      });
    };
    read();
    window.addEventListener(PROJECTS_CHANGED_EVENT, read);
    return () => {
      cancelled = true;
      window.removeEventListener(PROJECTS_CHANGED_EVENT, read);
    };
  }, [id]);
  return id && facts ? (facts.get(id) ?? null) : null;
}

export function useProjectName(id: string | null): string | null {
  return useProjectFact(id)?.name ?? null;
}
