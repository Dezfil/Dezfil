import { requireRequestScope } from "@/lib/auth/scope-http";
import { ApiError, errorResponse } from "@/lib/api/errors";
import { exportTable, isExportFormat } from "@/lib/table-service";
import { streamPrivateCopy } from "@/lib/export/copy-stream";
import { addressDataset } from "@/lib/dataset-address";

type Params = { params: Promise<{ name: string }> };

/** Download a table: the GeoParquet artifact itself, or a
 * DuckDB-written GeoJSON/CSV conversion, streamed as an attachment. */
export async function GET(request: Request, { params }: Params) {
  try {
    const scope = requireRequestScope(request);
    const { name } = await params;
    const format =
      new URL(request.url).searchParams.get("format") ?? "geoparquet";
    if (!isExportFormat(format)) {
      throw new ApiError(
        "invalid_request",
        `Unknown export format "${format}". Use geoparquet, geojson, or csv.`,
        400,
      );
    }
    const table = addressDataset(scope, name).table;
    return await streamPrivateCopy(scope, [{ table: "data_tables", id: table.id }],
      () => exportTable(scope, name, format, request.signal), request.signal);
  } catch (error) {
    return errorResponse(error);
  }
}
