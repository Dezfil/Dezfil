import { NextResponse } from "next/server";
import { requireRequestAdmin } from "@/lib/auth/admin-http";
import { authFailure, privateResponse } from "@/lib/auth/http";
import { signEveryoneOut } from "@/lib/auth/sign-out-everyone";
export async function POST(request: Request) {
  try { return privateResponse(NextResponse.json(signEveryoneOut(requireRequestAdmin(request)))); }
  catch (error) { return authFailure(error); }
}
