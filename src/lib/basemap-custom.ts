/**
 * The authoritative write path for a per-map custom basemap style. The
 * check endpoint advises with the same inspector; this is where saving
 * is decided: a valid style saves with its attribution snapshot,
 * warning verdicts (unreachable, blocked) save only with explicit force
 * intent and carry the hostname as credit, and not-a-style never saves.
 * The stored basemap key is never touched here — removal elsewhere
 * simply reveals it again.
 */

import { ApiError } from "@/lib/api/errors";
import type { CustomBasemap } from "@/lib/metadata/maps";
import { inspectStyle } from "@/lib/net/inspect-style";

export const CUSTOM_URL_MAX = 2048;
export const CUSTOM_NAME_MAX = 120;

function invalid(message: string): never {
  throw new ApiError("invalid_request", message, 400);
}

/**
 * Validate and inspect a stated `customBasemap` write. Returns the
 * value to store — null clears. Throws the documented invalid_request
 * wordings for malformed shapes, non-style URLs, and unforced warning
 * verdicts.
 */
export async function resolveCustomBasemapWrite(
  stated: unknown,
  inspect: typeof inspectStyle = inspectStyle,
): Promise<CustomBasemap | null> {
  if (stated === null) return null;
  if (typeof stated !== "object" || Array.isArray(stated)) {
    invalid(
      "customBasemap must be { url, name?, force? }, or null to remove " +
        "the custom style.",
    );
  }
  const o = stated as Record<string, unknown>;
  if (typeof o.url !== "string" || !o.url.trim()) {
    invalid("customBasemap.url must be a non-empty string.");
  }
  const url = o.url.trim();
  if (url.length > CUSTOM_URL_MAX) {
    invalid(`customBasemap.url must be at most ${CUSTOM_URL_MAX} characters.`);
  }
  if (o.name !== undefined && o.name !== null && typeof o.name !== "string") {
    invalid("customBasemap.name must be a string or null.");
  }
  const trimmedName = typeof o.name === "string" ? o.name.trim() : "";
  if (trimmedName.length > CUSTOM_NAME_MAX) {
    // Rejected, never silently truncated.
    invalid(
      `customBasemap.name must be at most ${CUSTOM_NAME_MAX} characters.`,
    );
  }
  const name = trimmedName || null;
  if (o.force !== undefined && typeof o.force !== "boolean") {
    invalid("customBasemap.force must be true or false.");
  }
  const force = o.force === true;

  const inspection = await inspect(url);
  switch (inspection.verdict) {
    case "valid": {
      const attribution = inspection.attribution.length
        ? inspection.attribution
        : [{ label: new URL(url).hostname }];
      return { url, name, attribution };
    }
    case "not_style":
      invalid(`The URL is not a MapLibre style: ${inspection.detail}`);
      break;
    case "unreachable":
    case "blocked": {
      if (!force) {
        invalid(
          `The style could not be verified (${inspection.detail}). Every ` +
            "reader's browser fetches the style itself, so this may still " +
            "work. State force: true to save it anyway.",
        );
      }
      // A forced save's credit is the only thing the server can vouch
      // for: the host itself.
      return { url, name, attribution: [{ label: new URL(url).hostname }] };
    }
  }
  // Exhaustive over the verdicts; TypeScript sees the invalid() throws.
  invalid("The style inspection returned no verdict.");
}
