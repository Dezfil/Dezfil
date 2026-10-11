import { NextResponse } from "next/server";
import { authFailure, privateResponse, requireRequestAuth } from "@/lib/auth/http";
import { listTemplates } from "@/lib/templates/catalogue";

/** The template list, from what this server holds; nothing is sent. */
export async function GET(request: Request) {
  try {
    requireRequestAuth(request);
    return privateResponse(NextResponse.json(await listTemplates()));
  } catch (error) { return authFailure(error); }
}
