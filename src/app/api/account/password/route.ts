import { NextResponse } from "next/server";
import { changeOwnPassword } from "@/lib/auth/accounts";
import { authBody, authFailure, privateResponse, requireRequestAuth } from "@/lib/auth/http";

export async function POST(request: Request) {
  try {
    const context = requireRequestAuth(request);
    const body = await authBody(request, ["currentPassword", "password"]);
    await changeOwnPassword(context, body.currentPassword, body.password, undefined, undefined, request.signal);
    return privateResponse(NextResponse.json({ changed: true }));
  } catch (error) { return authFailure(error); }
}
