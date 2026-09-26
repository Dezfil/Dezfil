import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { requireTarget } from "@/lib/postgis/import";
import { browseRemoteTables } from "@/lib/postgis/access";

type Params = { params: Promise<{ id: string }> };

/** List the source database's tables: spatial first, then attribute-only.
 * A read: it observes the source but records nothing about the
 * connection, so the stored health answers for the last test, import or
 * refresh. */
export async function GET(_request: Request, { params }: Params) {
  try {
    const { id } = await params;
    const { target } = requireTarget(id);
    const { tables } = await browseRemoteTables(target);
    return NextResponse.json({ tables });
  } catch (error) {
    return errorResponse(error);
  }
}
