import { NextResponse } from "next/server";
import { authFailure, privateResponse, requireRequestAuth } from "@/lib/auth/http";
import { refreshCatalogue } from "@/lib/templates/catalogue";

/** Read the template catalogue again, under the ten-minute rule. */
export async function POST(request: Request) {
  try {
    requireRequestAuth(request);
    return privateResponse(NextResponse.json(await refreshCatalogue()));
  } catch (error) { return authFailure(error); }
}
