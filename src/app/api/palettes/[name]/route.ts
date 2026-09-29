import { NextResponse } from "next/server";
import { ApiError } from "@/lib/api/errors";
import { authFailure, privateResponse, requireRequestAuth } from "@/lib/auth/http";
import { deleteCustomPalette } from "@/lib/metadata/palettes";

type Params = { params: Promise<{ name: string }> };

/**
 * Delete a saved custom palette. Styles that used it keep rendering —
 * their colors were baked in at classification time; only the picker
 * entry goes away. Curated palettes cannot be deleted.
 */
export async function DELETE(request: Request, { params }: Params) {
  try {
    requireRequestAuth(request);
    const { name } = await params;
    requireRequestAuth(request);
    if (!deleteCustomPalette(name)) {
      throw new ApiError(
        "not_found",
        `No custom palette named "${name}".`,
        404,
      );
    }
    return privateResponse(NextResponse.json({ deleted: true }));
  } catch (error) {
    return authFailure(error);
  }
}
