import { NextResponse } from "next/server";
import { ApiError } from "@/lib/api/errors";
import { authFailure, requireRequestAuth } from "@/lib/auth/http";
import { templatePicture } from "@/lib/templates/catalogue";
import { TEMPLATE_THEMES, type TemplateTheme } from "@/lib/templates/format";

/** A template card's map picture, in the theme named (light when none is). */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireRequestAuth(request);
    const { id } = await params;
    const theme = new URL(request.url).searchParams.get("theme") ?? "light";
    if (!(TEMPLATE_THEMES as readonly string[]).includes(theme)) {
      throw new ApiError("invalid_request", 'The theme must be "light" or "dark".', 400);
    }
    const png = await templatePicture(id, theme as TemplateTheme);
    if (!png) throw new ApiError("not_found", "This template has no picture to show.", 404);
    return new NextResponse(new Uint8Array(png), {
      headers: { "content-type": "image/png", "cache-control": "private, max-age=300", "x-content-type-options": "nosniff" },
    });
  } catch (error) { return authFailure(error); }
}
