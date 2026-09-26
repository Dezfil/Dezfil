"use client";

import { useEffect, useMemo, useState } from "react";
import type { TableFeaturesResult } from "@/lib/table-service";
import type { TableInspection } from "../api";
import { readApiError } from "../api";
import { serverUnreachable } from "../failure-copy";

/**
 * The two reads the results band adds to the canvas: the table inspection
 * for the Data and Provenance tabs, the sampled features for the Map tab,
 * read only while Map is shown. The key is the dataset's id, its name,
 * when its data was last produced (a re-run under the same name is a new
 * key) and the band's renewal counter; an answer lands only while its key
 * is still the one wanted, so a stale one never dresses a newer
 * selection. A read that fails holds its message and is retried on
 * request; a read the server answers "not found" is *gone*, the deleted
 * state's signal. Nothing is cached across keys.
 */

export interface DatasetKey {
  id: string;
  name: string;
  producedAt: string | null;
  /** Bumped by the band at each selection and each choice of a result tab. */
  renewal: number;
  /** Whether the features are wanted (Map shown). */
  features: boolean;
}

export type ReadState<T> = { status: "reading" } | { status: "read"; value: T } | { status: "gone" } | { status: "failed"; message: string };

export interface DatasetReads {
  /** The dataset these reads are about (its key without the tab), so a
   * state still the previous dataset's is never taken for the next one's. */
  key: string | null;
  inspection: ReadState<TableInspection>;
  /** Null while the features are not wanted. */
  features: ReadState<TableFeaturesResult> | null;
}

const EMPTY: DatasetReads = { key: null, inspection: { status: "reading" }, features: null };

export type Fetcher = (path: string) => Promise<Response>;

export const datasetPart = (k: DatasetKey) => [k.id, k.name, k.producedAt ?? "", String(k.renewal)].join("|");

async function readOne<T>(fetcher: Fetcher, path: string, action: string): Promise<ReadState<T>> {
  let response: Response;
  try {
    response = await fetcher(path);
  } catch {
    return { status: "failed", message: serverUnreachable(action) };
  }
  if (response.status === 404) return { status: "gone" };
  if (!response.ok) return { status: "failed", message: await readApiError(response) };
  return { status: "read", value: (await response.json()) as T };
}

export class DatasetReader {
  state: DatasetReads = EMPTY;
  private wanted: DatasetKey | null = null;
  private slots: { inspection: string | null; features: string | null } = { inspection: null, features: null };
  private tokens = { inspection: 0, features: 0 };
  private listeners = new Set<() => void>();

  constructor(private readonly fetcher: Fetcher = (path) => fetch(path, { cache: "no-store" })) {}

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  private set(patch: Partial<DatasetReads>) {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  /** Read for the key wanted now; null clears everything. */
  read(key: DatasetKey | null) {
    this.wanted = key;
    if (!key) {
      this.slots = { inspection: null, features: null };
      this.tokens.inspection++;
      this.tokens.features++;
      this.set(EMPTY);
      return;
    }
    const part = datasetPart(key);
    if (this.slots.inspection !== part) {
      this.slots.inspection = part;
      // A new dataset: nothing of the previous one's state survives.
      this.set({ key: part, inspection: { status: "reading" }, features: null });
      void this.fetchInspection(key, ++this.tokens.inspection);
    }
    if (!key.features) {
      this.slots.features = null;
      this.tokens.features++;
      // A features read that found the table gone is the deleted state's
      // only signal until the inspection is read again: it is kept when
      // the Map tab falls away, never cleared with the rest.
      if (this.state.features !== null && this.state.features.status !== "gone") this.set({ features: null });
    } else if (this.slots.features !== part) {
      this.slots.features = part;
      this.set({ features: { status: "reading" } });
      void this.fetchFeatures(key, ++this.tokens.features);
    }
  }

  /** Read again what failed, for the key wanted now. */
  retry = () => {
    const key = this.wanted;
    if (!key) return;
    if (this.state.inspection.status === "failed") {
      this.set({ inspection: { status: "reading" } });
      void this.fetchInspection(key, ++this.tokens.inspection);
    }
    if (key.features && this.state.features?.status === "failed") {
      this.set({ features: { status: "reading" } });
      void this.fetchFeatures(key, ++this.tokens.features);
    }
  };

  private async fetchInspection(key: DatasetKey, token: number) {
    const read = await readOne<TableInspection>(this.fetcher, `/api/tables/${encodeURIComponent(key.name)}`, "read the dataset");
    if (token !== this.tokens.inspection) return;
    this.set({ inspection: read });
  }

  private async fetchFeatures(key: DatasetKey, token: number) {
    const read = await readOne<TableFeaturesResult>(this.fetcher, `/api/tables/${encodeURIComponent(key.name)}/features?sample=1`, "read the features");
    if (token !== this.tokens.features) return;
    this.set({ features: read });
  }
}

/** The reads for the key wanted, re-rendering as they land. Until the
 * reader has been told of a new key (the effect runs after the render), a
 * state still the previous dataset's is masked as reading, so nothing of
 * one dataset is ever shown or judged under another's lead. */
export function useDatasetReads(key: DatasetKey | null): DatasetReads & { retry: () => void } {
  const reader = useMemo(() => new DatasetReader(), []);
  const [, bump] = useState(0);
  useEffect(() => reader.subscribe(() => bump((n) => n + 1)), [reader]);
  const id = key?.id ?? null;
  const name = key?.name ?? null;
  const producedAt = key?.producedAt ?? null;
  const renewal = key?.renewal ?? 0;
  const features = key?.features ?? false;
  useEffect(() => {
    reader.read(id !== null && name !== null ? { id, name, producedAt, renewal, features } : null);
  }, [reader, id, name, producedAt, renewal, features]);
  const wanted = id !== null && name !== null ? datasetPart({ id, name, producedAt, renewal, features }) : null;
  const state = reader.state.key === wanted ? reader.state : { ...EMPTY, key: wanted };
  return { ...state, retry: reader.retry };
}
