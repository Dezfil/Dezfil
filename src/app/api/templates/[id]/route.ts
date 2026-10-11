import { NextResponse } from "next/server";
import { authFailure, privateResponse, requireRequestAuth } from "@/lib/auth/http";
import { readTemplate } from "@/lib/templates/catalogue";

/** One template's card and how it is made; nothing is sent. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireRequestAuth(request);
    const { id } = await params;
    return privateResponse(NextResponse.json(await readTemplate(id)));
  } catch (error) { return authFailure(error); }
}
