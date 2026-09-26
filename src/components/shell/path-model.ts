"use client";

import { useEffect, useSyncExternalStore } from "react";

/**
 * The shell's one path model: object pages contribute what they know —
 * their name and, when unambiguous, their project — and the shell reads
 * it twice, for the breadcrumb and for the browser title. The store is
 * keyed by the contributing route, so a navigation away makes the old
 * contribution unreadable before the next page mounts: staleness is
 * structural, not an event to forget.
 */

export interface PathObject {
  /** The bold tail's text (the slot still owns its editing). */
  name: string;
  /** The one project this object is in; null when unfiled — and null
   * when membership is ambiguous (several projects show nothing). */
  projectId: string | null;
}

const PATH_EVENT = "dezfil:path";
/** Task 3 dispatches this when the instance name changes in Settings;
 * deliberately distinct from the display name's event, whose payload is
 * the avatar's name. */
export const INSTANCE_NAME_EVENT = "dezfil:instance-name";

let current: { path: string; object: PathObject } | null = null;

function broadcast(): void {
  window.dispatchEvent(new Event(PATH_EVENT));
}

/** An object page announces itself for the route it owns. */
export function contributePath(path: string, object: PathObject): void {
  current = { path, object };
  broadcast();
}

/** An object page leaving cleans up only its own contribution. */
export function releasePath(path: string): void {
  if (current?.path === path) {
    current = null;
    broadcast();
  }
}

/** The contribution for a route — a stale key reads as none. */
export function pathObjectFor(path: string): PathObject | null {
  return current?.path === path ? current.object : null;
}

export function usePathObject(path: string): PathObject | null {
  return useSyncExternalStore(
    (onChange) => {
      window.addEventListener(PATH_EVENT, onChange);
      return () => window.removeEventListener(PATH_EVENT, onChange);
    },
    () => pathObjectFor(path),
    () => null,
  );
}

/**
 * The browser title, the reference's compact hierarchy: an object page
 * never repeats its section; absent parts are skipped, never left as
 * empty separators.
 */
export function browserTitle(parts: {
  name?: string | null;
  project?: string | null;
  section?: string | null;
  instance?: string | null;
}): string {
  const tail = parts.instance?.trim() || "Dezfil";
  if (parts.name) {
    return [parts.name, parts.project || null, tail]
      .filter(Boolean)
      .join(" · ");
  }
  if (parts.section) return `${parts.section} · ${tail}`;
  return tail;
}

/**
 * The instance name: ONE module store every consumer reads, so the chip
 * and the title can never disagree — and a save that lands while the
 * initial read is still in flight wins over it (the event bumps the
 * generation the read captured; a superseded settlement is dropped).
 * Read tolerantly: a partial settings body means none. Null until known.
 */
let instanceName: string | null = null;
let instanceGeneration = 0;
let instanceReadStarted = false;
/** Internal: the initial read settled — distinct from the save event. */
const INSTANCE_SETTLED_EVENT = "dezfil:instance-name-settled";

if (typeof window !== "undefined") {
  // Module scope, so this runs before any consumer's own listener: the
  // store is current by the time subscribers re-read their snapshot.
  window.addEventListener(INSTANCE_NAME_EVENT, (e) => {
    instanceGeneration += 1;
    const detail = (e as CustomEvent<string | null>).detail;
    instanceName =
      typeof detail === "string" && detail.trim() ? detail : null;
  });
}

function readInstanceOnce(): void {
  if (instanceReadStarted) return;
  instanceReadStarted = true;
  const generation = instanceGeneration;
  fetch("/api/settings")
    .then((r) => (r.ok ? r.json() : null))
    .then((body: { instanceName?: string | null } | null) => {
      // A save superseded this read: its older value must not undo it.
      if (generation !== instanceGeneration) return;
      if (body && typeof body.instanceName === "string") {
        instanceName = body.instanceName;
        window.dispatchEvent(new Event(INSTANCE_SETTLED_EVENT));
      }
    })
    .catch(() => {
      /* The shell simply stays on the Dezfil fallback */
    });
}

export function useInstanceName(): string | null {
  useEffect(readInstanceOnce, []);
  return useSyncExternalStore(
    (onChange) => {
      window.addEventListener(INSTANCE_NAME_EVENT, onChange);
      window.addEventListener(INSTANCE_SETTLED_EVENT, onChange);
      return () => {
        window.removeEventListener(INSTANCE_NAME_EVENT, onChange);
        window.removeEventListener(INSTANCE_SETTLED_EVENT, onChange);
      };
    },
    () => instanceName,
    () => null,
  );
}
