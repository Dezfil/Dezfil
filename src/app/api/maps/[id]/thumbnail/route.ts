import { createHash } from "node:crypto";
import { ERROR_CATALOGUE } from "@/lib/api/error-catalogue";
import { requireRequestScope } from "@/lib/auth/scope-http";
import { privateResponse } from "@/lib/auth/http";
import { NextResponse } from "next/server";
import { ApiError, errorResponse } from "@/lib/api/errors";
import { requireMap, requireMapFor } from "@/lib/map-service";
import {
  isThumbnailTheme,
  readPicture,
  type PictureWant,
  type ThumbnailTheme,
} from "@/lib/map-thumbnails";
import { isPictureShape } from "@/lib/pictures/shapes";

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

/** The optional shape and width a request names; absent means none. */
function wantOf(request: Request): PictureWant {
  const query = new URL(request.url).searchParams;
  const shape = query.get("shape"), width = query.get("width");
  if (shape !== null && !isPictureShape(shape)) {
    throw new ApiError("invalid_request", 'The shape must be "card" or "wide".', 400);
  }
  if (width !== null && !/^[1-9][0-9]{0,8}$/.test(width)) {
    throw new ApiError("invalid_request", "The width must be a positive whole number of pixels.", 400);
  }
  return { ...(shape !== null ? { shape } : {}), ...(width !== null ? { width: Number(width) } : {}) };
}

/** Whether the browser already holds these bytes, by any tag it names. */
function holds(request: Request, tag: string): boolean {
  const named = request.headers.get("if-none-match");
  if (named === null) return false;
  return named.split(",").some((item) => {
    const value = item.trim();
    return value === "*" || value.replace(/^W\//, "") === tag;
  });
}

/** The map's latest picture; 404 while none exists. With a theme, that
 * theme's image, falling back to whatever the map has; with a shape or a
 * width, the kept size that fits, or the PNG of a picture that keeps none.
 * Everyone who reaches the map is served an image whose recorded datasets
 * they can all reach now (an unattributed image: the owner alone);
 * anyone else gets the same 404, the card's placeholder. The browser may
 * keep an answer but asks again on every use, so the same check decides
 * each time, and an unchanged picture is answered without its bytes. */
export async function GET(request: Request, { params }: Params) {
  try {
    const scope = requireRequestScope(request);
    const { id } = await params;
    const theme = themeOf(request);
    const want = wantOf(request);
    requireMap(scope, id);
    const picture = await readPicture(scope, id, theme, want);
    if (!picture) {
      throw new ApiError("not_found", "This map has no snapshot yet.", 404);
    }
    const tag = `"${createHash("sha256").update(picture.bytes).digest("base64url")}"`;
    const headers = { etag: tag, "cache-control": "private, no-cache" };
    if (holds(request, tag)) return new NextResponse(null, { status: 304, headers });
    return new NextResponse(new Uint8Array(picture.bytes), {
      headers: { ...headers, "content-type": picture.type },
    });
  } catch (error) {
    return privateResponse(errorResponse(error));
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
