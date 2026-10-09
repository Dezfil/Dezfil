import { NextResponse } from "next/server";
import { ApiError } from "@/lib/api/errors";
import { requireRequestAdmin } from "@/lib/auth/admin-http";
import { authFailure, privateResponse } from "@/lib/auth/http";
import { isPart, PARTS } from "@/lib/system/part-test-answer";
import { testPart } from "@/lib/system/part-tests";

/** Run one part's Test, as the part is configured now. */
export async function POST(request: Request, { params }: { params: Promise<{ part: string }> }) {
  try {
    const context = requireRequestAdmin(request);
    const { part } = await params;
    if (!isPart(part)) throw new ApiError("not_found", `There is no such part to test: ${PARTS.join(" or ")}.`, 404);
    return privateResponse(NextResponse.json(await testPart(context, part)));
  } catch (error) { return authFailure(error); }
}
