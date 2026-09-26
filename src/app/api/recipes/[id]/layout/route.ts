import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { jsonBody } from "@/lib/operations/recipe-api";
import { layoutPayload, readLayout, writeLayout } from "@/lib/operations/recipe-layout";

type Params = { params: Promise<{ id: string }> };

/**
 * The canvas layout document: positions for the recipe's nodes and
 * sources, and its notes, beside the recipe and never inside it. Read
 * whole; replaced whole. Nothing here reaches the recipe's steps.
 */
export async function GET(_request: Request, { params }: Params) {
  try {
    const { id } = await params;
    return NextResponse.json({ layout: layoutPayload(readLayout(id)) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(request: Request, { params }: Params) {
  try {
    const { id } = await params;
    const body = await jsonBody(request);
    return NextResponse.json({ layout: layoutPayload(writeLayout(id, body)) });
  } catch (error) {
    return errorResponse(error);
  }
}
