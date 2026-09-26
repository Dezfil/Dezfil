import { ApiError } from "@/lib/api/errors";
import {
  USER_AGENT,
  configuredEndpoint,
  endpointKey,
  geocoderConfigured,
  searchUrl as providerSearchUrl,
} from "@/lib/geocode/endpoint";
import { takeSlot } from "@/lib/geocode/limiter";
import { limits } from "@/lib/limits";
import { readCapped } from "@/lib/net/read-capped";
import { openRemote } from "@/lib/net/remote-fetch";
import type { PlaceRow, PlacesAnswer } from "./contract";

/**
 * The place-search provider boundary: one deployment-wide bring-your-own
 * endpoint — the configuration geocoding shares — spoken to in the
 * Nominatim-compatible `/search` JSON v2 shape through the outbound engine.
 * Everything here is server-side; the configured URL may carry key query
 * parameters, so failures resolve to sanitized messages that never repeat it.
 * The provider's answer is an untrusted stream: a short deadline, a byte cap,
 * and strict normalization treating everything beyond a name and a point as
 * optional. Attribution comes from the response; results without it are an
 * invalid answer, not an occasion to invent credit.
 *
 * **The pace is not this module's**. The provider sees an instance rather
 * than a feature, so a search waits for the same deployment-wide slot a batch
 * geocode waits for — ahead of one, because a person watching a search box is
 * a different thing from a batch with minutes to run. A limiter only the
 * batch respected would uphold nothing the moment anyone typed here.
 */

const MAX_BYTES = 1_000_000;
/** Place rows per search — the prototype's places group shows six. */
const PLACES_LIMIT = 6;

export { geocoderConfigured };

function searchUrl(query: string): URL | null {
  return providerSearchUrl(query, { limit: String(PLACES_LIMIT) });
}

function failed(message: string): PlacesAnswer {
  return { state: "failed", message };
}

const UNREACHABLE = failed(
  "The configured geocoding endpoint could not be reached.",
);
const INVALID = failed(
  "The configured geocoding endpoint answered in a shape this map search " +
    "does not understand (Nominatim-compatible /search JSON v2 expected).",
);

interface WireEntry {
  name?: unknown;
  display_name?: unknown;
  lat?: unknown;
  lon?: unknown;
  boundingbox?: unknown;
  licence?: unknown;
}

/** A coordinate from the wire: a finite number, from a number or a
 * non-empty string — `Number(null)` and `Number("")` are 0 and must
 * not become a place at null island. */
function wireNumber(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeEntry(entry: WireEntry): PlaceRow | null {
  // The wire is untrusted: `[null]` is valid JSON and must resolve to
  // a skipped entry, never a thrown TypeError escaping the boundary.
  if (typeof entry !== "object" || entry === null) return null;
  const lat = wireNumber(entry.lat);
  const lng = wireNumber(entry.lon);
  if (lat === null || lng === null) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const display =
    typeof entry.display_name === "string" ? entry.display_name : "";
  const name =
    typeof entry.name === "string" && entry.name !== ""
      ? entry.name
      : display.split(",")[0]?.trim() ?? "";
  if (!name) return null;
  const context = display.includes(",")
    ? display.slice(display.indexOf(",") + 1).trim() || null
    : null;
  const row: PlaceRow = { name, context, lng, lat };
  if (Array.isArray(entry.boundingbox) && entry.boundingbox.length === 4) {
    const box = entry.boundingbox.map(wireNumber);
    const [minLat, maxLat, minLng, maxLng] = box;
    if (
      box.every((n) => n !== null) &&
      Math.abs(minLat!) <= 90 &&
      Math.abs(maxLat!) <= 90 &&
      Math.abs(minLng!) <= 180 &&
      Math.abs(maxLng!) <= 180
    ) {
      row.bounds = [minLng!, minLat!, maxLng!, maxLat!];
    }
  }
  return row;
}

export async function searchPlaces(query: string): Promise<PlacesAnswer> {
  const url = searchUrl(query);
  if (!url) {
    return geocoderConfigured()
      ? INVALID // configured but not a URL — an administrator typo, worded as such
      : { state: "unconfigured" };
  }

  // The instance's next slot for this endpoint, taken ahead of any waiting
  // batch — and **held until this exchange is over**, because one request in
  // flight at a time is the contract, not merely one per interval. Released in
  // a `finally`, since this function answers from a dozen places.
  const release = await takeSlot(
    endpointKey(configuredEndpoint() ?? ""),
    "interactive",
  );
  try {
    return await exchange(url);
  } finally {
    release();
  }
}

async function exchange(url: URL): Promise<PlacesAnswer> {
  let response;
  try {
    response = await openRemote(url.toString(), {
      timeoutMs: limits.geocodeRequestTimeoutMs,
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
    });
  } catch (error) {
    // The uniform egress refusal is deliberately repeatable (never a
    // scanner oracle); every other transport failure embeds the URL in
    // its message and must not cross this boundary.
    if (error instanceof ApiError && error.code === "egress_blocked") {
      return failed(error.message);
    }
    return UNREACHABLE;
  }

  const status = response.statusCode;
  if (status !== 200) {
    // Destroyed rather than drained: this returns while the slot is released
    // in its `finally`, and a body still flowing would hold an exchange open
    // past the one-in-flight contract the batch depends on. Same shape as the
    // batch path's early return, found at the same review.
    response.body.destroy();
    return failed(
      `The configured geocoding endpoint answered with status ${status}.`,
    );
  }

  let text: string | null;
  try {
    text = await readCapped(response.body, MAX_BYTES);
  } catch {
    return UNREACHABLE;
  }
  if (text === null) return INVALID;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return INVALID;
  }
  if (!Array.isArray(parsed)) return INVALID;

  const results = (parsed as WireEntry[])
    .map(normalizeEntry)
    .filter((r): r is PlaceRow => r !== null)
    .slice(0, PLACES_LIMIT);

  if (results.length === 0) {
    return { state: "ok", attribution: null, results: [] };
  }
  const licence = (parsed as WireEntry[]).find(
    (e) =>
      typeof e === "object" &&
      e !== null &&
      typeof e.licence === "string" &&
      e.licence !== "",
  )?.licence;
  if (typeof licence !== "string") return INVALID;
  return { state: "ok", attribution: licence, results };
}
