import { NextResponse } from "next/server";
import { requireRequestAdmin } from "@/lib/auth/admin-http";
import { authFailure, privateResponse } from "@/lib/auth/http";
import { readInstanceSettings } from "@/lib/settings/read";

export async function GET(request: Request) {
  try {
    const context = requireRequestAdmin(request);
    return privateResponse(NextResponse.json(readInstanceSettings(context)));
  } catch (error) { return authFailure(error); }
}
