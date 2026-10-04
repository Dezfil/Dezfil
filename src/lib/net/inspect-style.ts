/**
 * Bounded server-side inspection of a custom basemap style URL. One
 * fetch through the egress-governed engine answers one of four verdicts
 * — valid, not a style, unreachable, blocked — plus a safe summary and
 * normalized attribution for the valid case. The check endpoint advises
 * with this; the authoritative save re-runs it. Every dimension is
 * bounded: the engine bounds redirects and connect admission, this
 * module bounds time, body size, and attribution output. Verdicts are
 * answers, not errors — a dead URL is a normal thing to inspect.
 */

import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import { ApiError } from "@/lib/api/errors";
import type { AttributionLine } from "@/lib/basemap";
import { openRemote, type RemoteResponse } from "./remote-fetch";

/** Style JSONs are typically well under 1 MB; twice that is generous. */
export const STYLE_BYTE_CAP = 2 * 1024 * 1024;
export const STYLE_TIMEOUT_MS = 8_000;
const MAX_ATTRIBUTION_LINES = 4;
const MAX_ATTRIBUTION_CHARS = 160;

export type StyleInspection =
  | {
      verdict: "valid";
      /** The style's own name, when it carries one. */
      name: string | null;
      layerCount: number;
      sourceCount: number;
      attribution: AttributionLine[];
    }
  | { verdict: "not_style"; detail: string }
  | { verdict: "unreachable"; detail: string }
  | { verdict: "blocked"; detail: string };

type Opener = (
  url: string,
  options: Parameters<typeof openRemote>[1],
) => Promise<RemoteResponse>;

/** Collect a live stream up to the byte cap; destroy and fail past it. */
function readCapped(response: RemoteResponse): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    response.body.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > STYLE_BYTE_CAP) {
        response.body.destroy();
        reject(
          new ApiError(
            "remote_too_large",
            `The style is larger than ${STYLE_BYTE_CAP / (1024 * 1024)} MB.`,
            413,
          ),
        );
        return;
      }
      chunks.push(chunk);
    });
    response.body.on("end", () => resolve(Buffer.concat(chunks)));
    response.body.on("error", reject);
  });
}

/** Decode the handful of entities attribution strings actually carry. */
function decodeEntities(text: string): string {
  return text
    .replace(/&copy;/gi, "©")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"');
}

/**
 * Source attribution is untrusted display material, conventionally
 * HTML ("© <a href=…>OpenStreetMap</a> contributors"). Normalize to
 * text plus at most one http(s) link per line, bounded in count and
 * length; anything else is dropped, never rendered.
 */
export function normalizeAttribution(raw: unknown[]): AttributionLine[] {
  const lines: AttributionLine[] = [];
  for (const value of raw) {
    if (typeof value !== "string") continue;
    const href = /href\s*=\s*["']?(https?:\/\/[^"'\s>]+)/i.exec(value)?.[1];
    const label = decodeEntities(value.replace(/<[^>]*>/g, " "))
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_ATTRIBUTION_CHARS);
    if (!label) continue;
    if (lines.some((l) => l.label === label)) continue;
    lines.push(href ? { label, href } : { label });
    if (lines.length >= MAX_ATTRIBUTION_LINES) break;
  }
  return lines;
}

/** What makes bytes a MapLibre style: the spec's own validator says so
 * (hand-rolled shape checks passed styles MapLibre rejects, twice). validateStyleMin is the same check the
 * renderer applies, from the already-pinned style-spec package. */
function asStyle(
  parsed: unknown,
): { name: string | null; layers: unknown[]; sources: Record<string, unknown> } | null {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const style = parsed as Record<string, unknown>;
  const errors = validateStyleMin(
    style as Parameters<typeof validateStyleMin>[0],
  );
  if (errors.length > 0) return null;
  return {
    name: typeof style.name === "string" ? style.name.slice(0, 120) : null,
    layers: style.layers as unknown[],
    sources: style.sources as Record<string, unknown>,
  };
}

export async function inspectStyle(
  url: string,
  open: Opener = openRemote,
  signal?: AbortSignal,
): Promise<StyleInspection> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return { verdict: "not_style", detail: "Not a valid URL." };
  }
  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
    return { verdict: "not_style", detail: "Only http(s) URLs can be a style." };
  }

  let bytes: Buffer;
  try {
    const response = await open(url, {
      timeoutMs: STYLE_TIMEOUT_MS,
      signal,
      timeoutError: () =>
        new ApiError("remote_timeout", "The style fetch timed out.", 504),
    });
    if (response.statusCode >= 400) {
      response.body.destroy();
      return { verdict: "unreachable", detail: `HTTP ${response.statusCode}.` };
    }
    bytes = await readCapped(response);
  } catch (error) {
    if (error instanceof ApiError && error.code === "egress_blocked") {
      return {
        verdict: "blocked",
        detail:
          "The egress policy blocks this host. Private and internal " +
          "addresses are denied unless DEZFIL_EGRESS_ALLOWLIST names them.",
      };
    }
    if (error instanceof ApiError && error.code === "remote_too_large") {
      return { verdict: "not_style", detail: error.message };
    }
    const detail =
      error instanceof ApiError ? error.message : "The fetch failed.";
    return { verdict: "unreachable", detail };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    return { verdict: "not_style", detail: "The response is not JSON." };
  }
  const style = asStyle(parsed);
  if (!style) {
    return {
      verdict: "not_style",
      detail:
        "The JSON is not a MapLibre style. It needs a version, sources, " +
        "and layers.",
    };
  }
  const attributions = Object.values(style.sources).map((source) =>
    typeof source === "object" && source !== null
      ? (source as Record<string, unknown>).attribution
      : undefined,
  );
  return {
    verdict: "valid",
    name: style.name,
    layerCount: style.layers.length,
    sourceCount: Object.keys(style.sources).length,
    attribution: normalizeAttribution(attributions),
  };
}
