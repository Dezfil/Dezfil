import { NextResponse } from "next/server";
import { createApiToken, listApiTokens } from "@/lib/auth/credentials";
import { authBody, authFailure, privateResponse, requireRequestAuth } from "@/lib/auth/http";

export async function GET(request: Request) {
  try {
    return privateResponse(NextResponse.json({ tokens: listApiTokens(requireRequestAuth(request)) }));
  } catch (error) { return authFailure(error); }
}

export async function POST(request: Request) {
  try {
    const context = requireRequestAuth(request);
    const body = await authBody(request, ["name"]);
    return privateResponse(NextResponse.json(createApiToken(context, body.name), { status: 201 }));
  } catch (error) { return authFailure(error); }
}
