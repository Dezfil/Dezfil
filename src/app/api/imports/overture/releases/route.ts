import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { listOvertureReleases } from "@/lib/overture/releases";

/** Available Overture releases, newest first (honest picker). */
export async function GET() {
  try {
    const releases = await listOvertureReleases();
    return NextResponse.json({ releases, latest: releases[0] });
  } catch (error) {
    return errorResponse(error);
  }
}
