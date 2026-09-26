import type { WidgetSelection } from "@/lib/widgets";

/**
 * Asking a publication for a layer's current extent — the one case the
 * reader's browser cannot answer for itself, a tiled layer whose features
 * never reach it whole.
 *
 * The reader never names a field. Widget selections go by widget id and
 * the timeline window carries only its bounds; the fields come from the
 * publication's own stored widgets and dock.
 */

export type ExtentAnswer =
  | { ok: true; box: [number, number, number, number] | null }
  | { ok: false; message: string };

/** Epoch milliseconds as the wire's time value; null stays open-ended. */
export function msToTimeValue(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

export async function fetchPublishedExtent(
  token: string,
  layerId: string,
  state: {
    selections: WidgetSelection[];
    timeline?: { min: string | null; max: string | null };
  },
): Promise<ExtentAnswer> {
  try {
    const response = await fetch(
      `/api/published/${encodeURIComponent(token)}/extent/${encodeURIComponent(layerId)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(state),
      },
    );
    if (!response.ok) {
      return {
        ok: false,
        message: "The map could not be fitted to the current view.",
      };
    }
    const body = (await response.json()) as {
      kind: "extent" | "empty";
      box?: [number, number, number, number];
    };
    return { ok: true, box: body.kind === "extent" ? (body.box ?? null) : null };
  } catch {
    return {
      ok: false,
      message: "The map could not be fitted. The server could not be reached.",
    };
  }
}
