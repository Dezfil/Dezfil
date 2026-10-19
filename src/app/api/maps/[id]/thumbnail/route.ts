import { ERROR_CATALOGUE } from "@/lib/api/error-catalogue";
import { requireRequestScope } from "@/lib/auth/scope-http";
import { NextResponse } from "next/server";
import { ApiError, errorResponse } from "@/lib/api/errors";
import { requireMap, requireMapFor } from "@/lib/map-service";
import {
  isThumbnailTheme,
  readThumbnail,
  type ThumbnailTheme,
} from "@/lib/map-thumbnails";

type Params = { params: Promise<{ id: string }> };

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
        // Card URLs carry the published picture version and theme, so short caching
        // is enough.
        "cache-control": "private, max-age=300",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Compatibility refusal. Browser pixels never enter the picture store. */
export async function PUT(request: Request, { params }: Params) {
  try {
    const scope = requireRequestScope(request), { id } = await params;
    requireMapFor(scope, id, "capture");
    throw new ApiError("picture_upload_retired", ERROR_CATALOGUE.picture_upload_retired, 410);
  } catch (error) { return errorResponse(error); }
}
