"use client";

import { useEffect, useMemo, useState } from "react";
import { onPrivateReset, privateStateOpen } from "../auth/private-state";
import type { ProjectPersonWire } from "./people";

/**
 * A project's people, read through the project's people route and kept for
 * the page's lifetime: the marks on the Projects page and on the header
 * path read them for the projects the signed-in person owns (a project
 * shared with them already says its owner and their role). The cache is
 * disposable: a change to a project's people announces itself with
 * `invalidateProjectPeople`, and a sign-out drops it. A failed read stays
 * uncached and shows no mark.
 */

export const PEOPLE_CHANGED_EVENT = "dezfil:people-changed";

let cache = new Map<string, ProjectPersonWire[]>();
let inflight = new Map<string, Promise<ProjectPersonWire[] | null>>();
let generation = 0;

function drop(): void {
  cache = new Map();
  inflight = new Map();
  generation += 1;
}
onPrivateReset(drop);
if (typeof window !== "undefined") {
  // Module scope, so the cache is gone before any hook re-reads.
  window.addEventListener(PEOPLE_CHANGED_EVENT, drop);
}

async function readPeople(id: string): Promise<ProjectPersonWire[] | null> {
  try {
    const response = await fetch(`/api/projects/${encodeURIComponent(id)}/people`, { cache: "no-store" });
    if (!response.ok) return null;
    return ((await response.json()) as { people: ProjectPersonWire[] }).people;
  } catch {
    return null;
  }
}

function resolve(id: string): Promise<ProjectPersonWire[] | null> {
  const known = cache.get(id);
  if (known) return Promise.resolve(known);
  const pending = inflight.get(id);
  if (pending) return pending;
  const started = generation;
  const read = readPeople(id).then((people) => {
    // A read that an invalidation overtook writes nothing.
    if (people && started === generation && privateStateOpen()) cache.set(id, people);
    if (inflight.get(id) === read) inflight.delete(id);
    return people;
  });
  inflight.set(id, read);
  return read;
}

/** Whoever changes a project's people calls this; every mounted mark
 * re-reads. */
export function invalidateProjectPeople(): void {
  window.dispatchEvent(new Event(PEOPLE_CHANGED_EVENT));
}

/** The people of each project asked for, as they land. */
export function useProjectPeople(ids: readonly string[]): Map<string, ProjectPersonWire[]> {
  const key = useMemo(() => [...new Set(ids)].sort().join("\n"), [ids]);
  const [known, setKnown] = useState<Map<string, ProjectPersonWire[]>>(() => {
    const seeded = new Map<string, ProjectPersonWire[]>();
    for (const id of ids) {
      const people = cache.get(id);
      if (people) seeded.set(id, people);
    }
    return seeded;
  });
  useEffect(() => {
    const wanted = key ? key.split("\n") : [];
    if (wanted.length === 0) return;
    let cancelled = false;
    const read = () => {
      void Promise.all(wanted.map(async (id) => [id, await resolve(id)] as const)).then((answers) => {
        if (cancelled) return;
        const next = new Map<string, ProjectPersonWire[]>();
        for (const [id, people] of answers) if (people) next.set(id, people);
        setKnown(next);
      });
    };
    read();
    window.addEventListener(PEOPLE_CHANGED_EVENT, read);
    return () => {
      cancelled = true;
      window.removeEventListener(PEOPLE_CHANGED_EVENT, read);
    };
  }, [key]);
  return known;
}
