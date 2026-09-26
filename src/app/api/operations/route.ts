import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { OPERATIONS } from "@/lib/operations/catalog";
import { withAvailability } from "@/lib/operations/capability";

/**
 * The operations this instance offers, described as data, each carrying whether
 * this instance can actually run it.
 *
 * Availability is resolved here rather than declared in the catalog because it
 * is a fact about the deployment: an administrator who configures a provider changes
 * the answer without changing a verb.
 */
export async function GET() {
  try {
    return NextResponse.json({ operations: withAvailability(OPERATIONS) });
  } catch (error) {
    return errorResponse(error);
  }
}
