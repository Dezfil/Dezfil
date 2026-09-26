import { NextResponse } from "next/server";
import { ApiError, errorResponse } from "@/lib/api/errors";
import { ERROR_CATALOGUE } from "@/lib/api/error-catalogue";
import { lookRetention, type LookVariant } from "@/lib/export/look-retention";

type Params = { params: Promise<{ renderId: string }> };

/**
 * The retained image of a map check: exactly the bytes the model was
 * given, or the thumbnail derived from them at retention, as a PNG
 * attachment. Never a render: after eviction or a restart the answer is
 * the documented unavailability.
 */
export async function GET(request: Request, { params }: Params) {
  try {
    const { renderId } = await params;
    const raw = new URL(request.url).searchParams.get("variant") ?? "full";
    if (raw !== "full" && raw !== "thumbnail") throw new ApiError("invalid_request", 'variant must be "full" or "thumbnail".', 400);
    const bytes = lookRetention.read(renderId, raw as LookVariant);
    if (!bytes) throw new ApiError("look_image_unavailable", ERROR_CATALOGUE.look_image_unavailable, 404);
    return new NextResponse(Buffer.from(bytes), {
      headers: {
        "content-type": "image/png",
        "content-length": String(bytes.byteLength),
        "content-disposition": `attachment; filename="look-${renderId}${raw === "thumbnail" ? "-thumbnail" : ""}.png"`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
