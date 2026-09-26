import { NextResponse } from "next/server";
import { ApiError, errorResponse } from "@/lib/api/errors";
import { deleteCustomPalette } from "@/lib/metadata/palettes";

type Params = { params: Promise<{ name: string }> };

/**
 * Delete a saved custom palette. Styles that used it keep rendering —
 * their colors were baked in at classification time; only the picker
 * entry goes away. Curated palettes cannot be deleted.
 */
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const { name } = await params;
    if (!deleteCustomPalette(name)) {
      throw new ApiError(
        "not_found",
        `No custom palette named "${name}".`,
        404,
      );
    }
    return NextResponse.json({ deleted: true });
  } catch (error) {
    return errorResponse(error);
  }
}
