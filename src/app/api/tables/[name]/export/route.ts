import { open } from "node:fs/promises";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { ApiError, errorResponse } from "@/lib/api/errors";
import { exportTable, isExportFormat } from "@/lib/table-service";
import { trackInflight } from "@/lib/query/inflight";

type Params = { params: Promise<{ name: string }> };

/** Download a table: the GeoParquet artifact itself, or a
 * DuckDB-written GeoJSON/CSV conversion, streamed as an attachment. */
export async function GET(request: Request, { params }: Params) {
  try {
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
    // Resolve-and-open is one tracked reader: the descriptor is held before
    // the response starts, so a concurrent refresh retiring the artifact
    // cannot land between path resolution and open — and once open, the
    // descriptor outlives any removal for the whole download.
    const { file, handle, size } = await trackInflight(
      (async () => {
        const file = await exportTable(name, format);
        const handle = await open(file.path);
        const size = (await handle.stat()).size;
        return { file, handle, size };
      })(),
    );
    const stream = handle.createReadStream();
    // Temp conversions vanish once the download (or an abort) closes the
    // stream; the GeoParquet artifact's cleanup is a no-op.
    stream.once("close", () => void file.cleanup());
    return new NextResponse(Readable.toWeb(stream) as ReadableStream, {
      headers: {
        "content-type": file.contentType,
        "content-length": String(size),
        "content-disposition": `attachment; filename="${file.filename}"`,
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
