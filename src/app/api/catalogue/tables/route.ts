import { errorResponse } from "@/lib/api/errors";
import { parseCatalogueQuery, readTableCatalogue } from "@/lib/table-catalogue";

/** Bounded metadata-only catalogue, shared by assistant and headless clients. */
export async function GET(request: Request) {
  try {
    return Response.json(await readTableCatalogue(parseCatalogueQuery(new URL(request.url)), request.signal));
  } catch (error) { return errorResponse(error); }
}
