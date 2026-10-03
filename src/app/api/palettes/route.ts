import { largeJsonValue } from "@/lib/api/json-body";
import { NextResponse } from "next/server";
import { ApiError } from "@/lib/api/errors";
import { authFailure, privateResponse, requireRequestAuth } from "@/lib/auth/http";
import { PALETTES } from "@/lib/style/palettes";
import {
  createCustomPalette,
  customPaletteProblem,
  listCustomPalettes,
  type CustomPaletteStop,
} from "@/lib/metadata/palettes";

/**
 * The palette offer: the curated catalogue plus every saved custom
 * palette — one call gives the picker and any agent the full list.
 */
export async function GET(request: Request) {
  try {
    requireRequestAuth(request);
    return privateResponse(NextResponse.json({
      curated: PALETTES,
      custom: listCustomPalettes(),
    }));
  } catch (error) {
    return authFailure(error);
  }
}

/**
 * Save a custom palette: a named gradient of ordered color stops,
 * instance-global, usable wherever palettes are offered.
 */
export async function POST(request: Request) {
  try {
    requireRequestAuth(request);
    const body = (await largeJsonValue(request, () => null)) as {
      label?: unknown;
      stops?: unknown;
    } | null;
    if (!body) {
      throw new ApiError("invalid_request", "Expected a JSON body.", 400);
    }
    const problem = customPaletteProblem(body);
    if (problem) {
      throw new ApiError("invalid_request", problem, 400);
    }
    requireRequestAuth(request);
    const palette = createCustomPalette({
      label: body.label as string,
      stops: body.stops as CustomPaletteStop[],
    });
    return privateResponse(NextResponse.json(palette, { status: 201 }));
  } catch (error) {
    return authFailure(error);
  }
}
