import { thumbnailBody } from "@/lib/api/thumbnail-body";
import { requireRequestScope } from "@/lib/auth/scope-http";
import { NextResponse } from "next/server";
import { ApiError, errorResponse } from "@/lib/api/errors";
import { requireMap, requireMapFor } from "@/lib/map-service";
import {
  isThumbnailCycle,
  isThumbnailTheme,
  readThumbnail,
  saveThemedThumbnail,
  saveThumbnail,
  type ThumbnailTheme,
} from "@/lib/map-thumbnails";
import { captureBasemap, captureInputs } from "@/lib/thumbnail-evidence";
import { isMapSqlRevision } from "@/lib/map-sql-revision";

type Params = { params: Promise<{ id: string }> };

/** Far above any honest capture; a backstop, not a budget. */
const THUMBNAIL_MAX_BYTES = 4 * 1024 * 1024;

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The optional theme a request names; absent means none. */
function themeOf(request: Request): ThumbnailTheme | null {
  const theme = new URL(request.url).searchParams.get("theme");
  if (theme === null) return null;
  if (!isThumbnailTheme(theme)) {
    throw new ApiError(
      "invalid_request",
      'The theme must be "light" or "dark".',
      400,
    );
  }
  return theme;
}

/** The map's latest snapshot; 404 while none exists. With a
 * theme, that theme's image, falling back to whatever the map has.
 * Everyone who reaches the map is served an image whose recorded datasets
 * they can all reach now (an unattributed image: the owner alone);
 * anyone else gets the same 404, the card's placeholder. */
export async function GET(request: Request, { params }: Params) {
  try {
    const scope = requireRequestScope(request);
    const { id } = await params;
    const theme = themeOf(request);
    requireMap(scope, id);
    const png = await readThumbnail(scope, id, theme);
    if (!png) {
      throw new ApiError("not_found", "This map has no snapshot yet.", 404);
    }
    return new NextResponse(new Uint8Array(png), {
      headers: {
        "content-type": "image/png",
        // Card URLs carry ?v=<updatedAt> and the theme, so short caching
        // is enough.
        "cache-control": "private, max-age=300",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/** The map's SQL revision the capture saw when it started; absent means none. */
function revisionOf(request: Request): string | null {
  const revision = new URL(request.url).searchParams.get("revision");
  if (revision === null) return null;
  if (!isMapSqlRevision(revision)) {
    throw new ApiError("invalid_request", "A revision is 16 lowercase hexadecimal digits.", 400);
  }
  return revision;
}

/** Store the map's snapshot — a PNG body, captured by the builder. With a
 * theme and a cycle, one of a themed pair: held (202) until the partner
 * arrives under the same cycle, then published together (204). Each image
 * is stamped with what the map's SQL draws at the revision the capture saw,
 * or kept unattributed when that revision is missing or has moved, and with
 * the basemap the map stands on as it is saved, which its credit names. */
export async function PUT(request: Request, { params }: Params) {
  try {
    const scope = requireRequestScope(request);
    const { id } = await params;
    requireMapFor(scope, id, "capture");
    const theme = themeOf(request);
    const cycle = new URL(request.url).searchParams.get("cycle");
    if (theme && !isThumbnailCycle(cycle)) {
      throw new ApiError(
        "invalid_request",
        "A themed snapshot names its cycle: 1 to 64 letters, digits, - or _.",
        400,
      );
    }
    if (!theme && cycle !== null) {
      throw new ApiError(
        "invalid_request",
        "A cycle belongs to a themed snapshot; name the theme too.",
        400,
      );
    }
    const body = await thumbnailBody(request);
    if (body.byteLength === 0 || body.byteLength > THUMBNAIL_MAX_BYTES) {
      throw new ApiError(
        "invalid_request",
        `The snapshot must be a PNG of at most ${THUMBNAIL_MAX_BYTES / (1024 * 1024)} MB.`,
        400,
      );
    }
    if (!PNG_MAGIC.every((byte, i) => body[i] === byte)) {
      throw new ApiError("invalid_request", "The body is not a PNG.", 400);
    }
    const revision = revisionOf(request);
    const inputs = await captureInputs(scope, id, revision);
    const basemap = captureBasemap(id, theme);
    if (theme) {
      const outcome = await saveThemedThumbnail(scope, id, theme, cycle!, body, inputs, basemap);
      return new NextResponse(null, {
        status: outcome === "held" ? 202 : 204,
      });
    }
    await saveThumbnail(scope, id, body, inputs, basemap);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}
