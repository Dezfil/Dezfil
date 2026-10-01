"use client";

import { useEffect, useState } from "react";
import { readApiError } from "../../api";

/**
 * The dry run that gates Run.
 *
 * Run is available only for the parameter values represented by the current
 * successful dry run — which is how table-only truth and every assumed-CRS
 * warning are on screen *before* the one committed gesture, and how the
 * probed verbs (the SQL tool above all) can say what they will produce at
 * all. The check writes nothing and mints nothing; the route answers from
 * a bounded describe.
 *
 * **A late answer never replaces a newer form state.** Every request carries
 * the fingerprint of the values it was asked about, and an answer only lands
 * if the fingerprint still matches — so with two deliberately reordered
 * responses, only the one for the current values renders. The
 * in-flight request is also aborted on change, but the fingerprint is the
 * guard the criterion tests; the abort is just economy.
 */

/** The three-case preview, in the server's own vocabulary. */
export interface DryRunPreview {
  rowCount: number;
  geometry: "none" | "undetermined" | "classified";
  geometryType: string | null;
  warnings: string[];
}

export type DryRunGate =
  | { state: "waiting" }
  | { state: "checking" }
  | { state: "ready"; preview: DryRunPreview }
  | { state: "refused"; message: string };

export interface DryRunRequest {
  operation: string;
  parameters: Record<string, unknown>;
  /** Where the parameters were written, when not the caller's console: a
   * layer's SQL is its map's, and is carried from there as the run's
   * capture is. */
  writtenIn?: { kind: "map"; id: string };
}

/** The dry run's request body. */
export function dryRunBody(request: DryRunRequest): string {
  return JSON.stringify({
    operation: request.operation,
    parameters: request.parameters,
    dryRun: true,
    ...(request.writtenIn ? { writtenIn: request.writtenIn } : {}),
  });
}

/** Long enough to swallow per-keystroke churn, short enough that the gate
 * does not read as a dead button while the user reaches for Run. */
const DEBOUNCE_MS = 350;

export function useDryRun(request: DryRunRequest | null): DryRunGate {
  // Keyed by value, not by object identity: the caller rebuilds the request
  // every render, and an effect keyed on the object would re-check on every
  // keystroke elsewhere in the form. The fingerprint IS the request,
  // serialized — the effect reconstructs it rather than holding the object,
  // so there is no ref to fall out of step with the render that asked.
  const fingerprint = request === null ? null : dryRunBody(request);

  const [answer, setAnswer] = useState<{
    for: string;
    gate: DryRunGate;
  } | null>(null);

  useEffect(() => {
    if (fingerprint === null) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void fetch("/api/operations/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: fingerprint,
        signal: controller.signal,
      })
        .then(async (response) => {
          if (!response.ok) throw new Error(await readApiError(response));
          return (await response.json()) as {
            dryRun: {
              rowCount: number;
              geometry: "none" | "undetermined" | "classified";
              geometryType: string | null;
            };
            warnings?: string[];
          };
        })
        .then((body) =>
          setAnswer({
            for: fingerprint,
            gate: {
              state: "ready",
              preview: { ...body.dryRun, warnings: body.warnings ?? [] },
            },
          }),
        )
        .catch((e: unknown) => {
          if (controller.signal.aborted) return;
          setAnswer({
            for: fingerprint,
            gate: {
              state: "refused",
              message:
                e instanceof Error ? e.message : "The check could not run.",
            },
          });
        });
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [fingerprint]);

  if (fingerprint === null) return { state: "waiting" };
  if (answer === null || answer.for !== fingerprint) return { state: "checking" };
  return answer.gate;
}
