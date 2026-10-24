import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { gateHead, gateOnly, withRouteGate } from "@/lib/auth/route-gate";
import { requireRequestScope } from "@/lib/auth/scope-http";
import { removeOwnPicture, setOwnPicture } from "@/lib/profile-pictures/own";

/** Set your own picture: the request's one file, received within the
 * picture's fixed bounds, processed into the server's own copy. */
async function upload(request: Request) {
  try {
    return NextResponse.json({ account: await setOwnPicture(requireRequestScope(request), request) });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Remove your own picture; removing none changes nothing. */
async function remove(request: Request) {
  try {
    return NextResponse.json({ account: await removeOwnPicture(requireRequestScope(request)) });
  } catch (error) {
    return errorResponse(error);
  }
}

// The upload's body is never copied by the middleware, so every method
// the framework can dispatch here passes the gate first.
export async function PUT(request: Request) { return withRouteGate(request, () => upload(request)); }
export async function DELETE(request: Request) { return withRouteGate(request, () => remove(request)); }
export async function GET(request: Request) { return gateOnly(request); }
export async function HEAD(request: Request) { return gateHead(request, GET); }
export async function OPTIONS(request: Request) { return gateOnly(request); }
export async function POST(request: Request) { return gateOnly(request); }
export async function PATCH(request: Request) { return gateOnly(request); }
