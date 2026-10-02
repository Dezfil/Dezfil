import { failureProse } from "../widgets/dashboard-state";

/**
 * How a layer's failed render reads in the shipped failure note.
 *
 * A reference the reader cannot reach fails with the resource diagnostic,
 * the product's own sentence: the dataset's name as written, and that it is
 * not available to them. It says what to fix and nothing about whether the
 * dataset exists or whose it is, so it leads the note as written. Every
 * other failure keeps the catalogue's line, with the engine's own text one
 * click deeper for an author and nowhere for a reader.
 */

const UNAVAILABLE = /^The dataset "[^"\n]+" is not available to you\.$/;

export interface LayerFailure {
  code: string;
  message: string;
}

/** The diagnostic's sentence, when this failure is the diagnostic. */
export function datasetUnavailable(failure: LayerFailure | null): string | null {
  return failure && failure.code === "sql_error" && UNAVAILABLE.test(failure.message)
    ? failure.message
    : null;
}

export function layerFailureCopy(
  failure: LayerFailure | null,
  audience: "author" | "reader",
): { message: string; detail: string | null } {
  const unavailable = datasetUnavailable(failure);
  if (unavailable) return { message: unavailable, detail: null };
  return {
    message: failureProse(failure, "reader"),
    detail: audience === "author" ? (failure?.message ?? null) : null,
  };
}
