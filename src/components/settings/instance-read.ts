"use client";
import { useEffect, useState } from "react";
import { accountRequest, failureMessage, settingsWrite } from "./api";
import type { Value } from "./save-unit";
import type { ReadSetting } from "./server-set";

/** The configuration read: every instance setting as it resolved, with the
 * facts the System tab shows beside them. Admins only. */
export interface InstanceRead {
  readonly settings: Readonly<Record<string, ReadSetting>>;
  readonly capacities: { readonly geocodeRows: number; readonly isochroneOrigins: number };
  readonly maxImageDimension: number;
  readonly version: string;
  readonly startedAt: string;
  readonly warnings: readonly string[];
}

export const INSTANCE_SETTINGS = "/api/instance/settings";

/** The read, fetched when the tab opens, with a retry for a failed one. */
export function useInstanceRead(): { read: InstanceRead | null; error: string | null; retry: () => void } {
  const [read, setRead] = useState<InstanceRead | null>(null);
  const [error, setError] = useState<string | null>(null), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    accountRequest<InstanceRead>(INSTANCE_SETTINGS).then(body => {
      if (!cancelled) { setRead(body); setError(null); }
    }).catch(failure => { if (!cancelled) setError(failureMessage(failure)); });
    return () => { cancelled = true; };
  }, [attempt]);
  return { read, error, retry: () => { setError(null); setAttempt(value => value + 1); } };
}

/** The write: the keys changed, answered with the whole read. */
export function writeInstanceSettings(patch: Record<string, Value>): Promise<InstanceRead> {
  return settingsWrite<InstanceRead>(INSTANCE_SETTINGS, "PATCH", patch);
}

/** What a response reports as kept, for a card's keys. */
export function keptValues(read: InstanceRead, keys: readonly string[]): Record<string, Value> {
  return Object.fromEntries(keys.filter(key => key in read.settings).map(key => [key, read.settings[key].value as Value]));
}
