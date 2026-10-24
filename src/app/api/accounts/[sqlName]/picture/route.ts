import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { privateResponse } from "@/lib/auth/http";
import { requireRequestScope } from "@/lib/auth/scope-http";
import { clientHolds, readProfilePicture } from "@/lib/profile-pictures/read";

type Params = { params: Promise<{ sqlName: string }> };

/** A person's current picture, for any active account. `v` names the
 * version a read gave; an earlier one answers 404, so a replaced or removed
 * picture serves no bytes at its old address. The browser may keep the
 * answer but asks again before each use, the same checks decide each time,
 * and an unchanged picture is answered without its bytes. */
export async function GET(request: Request, { params }: Params) {
  try {
    const scope = requireRequestScope(request);
    const { sqlName } = await params;
    const picture = await readProfilePicture(scope, sqlName, new URL(request.url).searchParams.get("v"));
    const headers = { etag: picture.tag, "cache-control": "private, no-cache" };
    if (clientHolds(request, picture.tag)) return new NextResponse(null, { status: 304, headers });
    // An attachment by name, as every byte answer an agent reads is; an
    // image element shows it all the same.
    return new NextResponse(new Uint8Array(picture.bytes), { headers: { ...headers, "content-type": "image/webp",
      "content-disposition": `attachment; filename="${sqlName}.webp"` } });
  } catch (error) {
    return privateResponse(errorResponse(error));
  }
}
