import { requireRequestScope } from "@/lib/auth/scope-http";
import { errorResponse } from "@/lib/api/errors";
import { parseCatalogueQuery, readTableCatalogue } from "@/lib/table-catalogue";

/** Bounded metadata-only catalogue, shared by assistant and headless clients. */
export async function GET(request: Request) {
  try {
    const scope = requireRequestScope(request);
    return Response.json(await readTableCatalogue(scope, parseCatalogueQuery(new URL(request.url)), request.signal));
  } catch (error) { return errorResponse(error); }
}
