import { largeBodyText } from "@/lib/api/json-body";
import { ApiError } from "@/lib/api/errors";
import type { PublishedTheme, ViewerControls } from "@/lib/metadata/maps";
import type { PublishSettings } from "./publish-service";

const CONTROL_KEYS = ["tilt", "fit", "theme", "basemap", "coords"] as const;

function invalid(message: string): never {
  throw new ApiError("invalid_request", message, 400);
}

/**
 * The optional publish body. Empty and bodyless requests stay valid —
 * callers from before either feature publish with no body at all. A
 * body that is present must be a JSON object, and any field it states
 * must be well-formed; anything else answers the documented code, never
 * a 500 and never a silent publish.
 *
 * The two settings are parsed independently, and that is the contract,
 * not an implementation detail: a stated theme with no controls (the
 * builder's workspace-theme sync) must leave the author's checklist
 * untouched, so an absent field returns undefined — "change nothing" —
 * rather than a defaulted object.
 */
export async function parsePublishBody(
  request: Request,
): Promise<PublishSettings> {
  const text = (await largeBodyText(request)).trim();
  if (!text) return {};
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch (error) {
      if (error instanceof ApiError) throw error;
    invalid("The request body must be JSON.");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    invalid("The request body must be a JSON object.");
  }
  const stated = body as Record<string, unknown>;
  return {
    theme: parseTheme(stated),
    viewerControls: parseViewerControls(stated),
  };
}

function parseTheme(body: Record<string, unknown>): PublishedTheme | undefined {
  if (!("theme" in body) || body.theme === undefined) return undefined;
  if (body.theme !== "light" && body.theme !== "dark") {
    invalid(`The "theme" field accepts "light" or "dark".`);
  }
  return body.theme;
}

function parseViewerControls(
  body: Record<string, unknown>,
): Partial<ViewerControls> | undefined {
  if (!("viewerControls" in body) || body.viewerControls === undefined) {
    return undefined;
  }
  const stated = body.viewerControls;
  if (typeof stated !== "object" || stated === null || Array.isArray(stated)) {
    invalid(`The "viewerControls" field must be a JSON object.`);
  }
  const source = stated as Record<string, unknown>;
  const unknown = Object.keys(source).filter(
    (key) => !(CONTROL_KEYS as readonly string[]).includes(key),
  );
  if (unknown.length > 0) {
    invalid(
      `The "viewerControls" field accepts ${CONTROL_KEYS.join(", ")}; ` +
        `not ${unknown.join(", ")}.`,
    );
  }
  const out: Partial<ViewerControls> = {};
  for (const key of CONTROL_KEYS) {
    if (!(key in source) || source[key] === undefined) continue;
    if (typeof source[key] !== "boolean") {
      invalid(`The "viewerControls.${key}" field accepts true or false.`);
    }
    out[key] = source[key] as boolean;
  }
  return out;
}
