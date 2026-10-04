import { largeJsonValue } from "@/lib/api/json-body";
import { requireRequestScope } from "@/lib/auth/scope-http";
import { requireAccountScope, type AccountScope } from "@/lib/auth/scope";
import { openPrivateExport } from "@/lib/export/private-file";
import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import {
  ApiError,
  EvaluationCancelled,
  errorResponse,
} from "@/lib/api/errors";
import {
  queryDownloadTickets,
  observeLayerDownloadStream,
  type LayerDownloadBinding,
} from "@/lib/export/layer-download-tickets";
import {
  exportQueryResult,
  isLayerExportFormat,
  type LayerExportFormat,
} from "@/lib/export/layer-export";
import { trackInflight } from "@/lib/query/inflight";

/**
 * Download a query's full result as a file: the SQL's every row as CSV,
 * parquet, or — with a geometry column — GeoJSON. The evaluation is the
 * bounded, read-only, cancellable one every user-SQL door takes; the scratch
 * file vanishes once the download (or an abort) closes the stream, the boot
 * sweep covering a process that dies mid-stream.
 *
 * Two roads, one file policy:
 *
 *  - **Direct** — `POST` with `{sql, format, name?}` streams the attachment.
 *    The documented operation; what an agent or a script calls.
 *  - **Prepared** — `POST … {prepare: true}` writes the file and answers a
 *    single-use ticket; `GET ?ticket=…&key=…&format=…` redeems it as a
 *    native streamed attachment. The page takes this road (its
 *    boundary: bytes never pass through a whole-response browser blob,
 *    and a failure stays in-app at the prepare step). The ticket store is
 *    the layer download's class with its own instance and its binding
 *    keyed by the SQL's digest rather than a layer id; expiry, single use
 *    and cleanup are the store's.
 */

function bindingFor(sql: string, format: LayerExportFormat): LayerDownloadBinding {
  return { layerId: keyOf(sql), format };
}
function keyOf(sql: string): string {
  return createHash("sha256").update(sql).digest("base64url").slice(0, 32);
}
function unavailable(): ApiError {
  return new ApiError(
    "not_found",
    "This prepared download is no longer available.",
    410,
  );
}

interface Body {
  sql: string;
  format: LayerExportFormat;
  name: string;
  prepare: boolean;
}

async function readBody(request: Request): Promise<Body> {
  let raw: Record<string, unknown>;
  try {
    raw = (await largeJsonValue(request)) as Record<string, unknown>;
  } catch (error) {
      if (error instanceof ApiError) throw error;
    throw new ApiError(
      "invalid_request",
      'Expected a JSON body like {"sql": "SELECT …", "format": "csv"}.',
      400,
    );
  }
  const { sql, format, name, prepare } = raw;
  if (typeof sql !== "string" || sql.trim() === "") {
    throw new ApiError(
      "invalid_request",
      'The "sql" field must be a non-empty string.',
      400,
    );
  }
  if (!isLayerExportFormat(format)) {
    throw new ApiError(
      "invalid_request",
      `Unknown export format "${String(format)}". Use geoparquet, geojson, or csv.`,
      400,
    );
  }
  return {
    sql,
    format,
    name: typeof name === "string" && name.trim() ? name : "query_result",
    prepare: prepare === true,
  };
}

export async function POST(request: Request) {
  try {
    const scope = requireRequestScope(request);
    const body = await readBody(request);
    return body.prepare
      ? await prepareDownload(scope, request, body)
      : await directDownload(scope, request, body);
  } catch (error) {
    return errorResponse(error);
  }
}

/** Redeem a prepared download: a single-use native attachment. */
export async function GET(request: Request) {
  try {
    const scope = requireRequestScope(request);
    const search = new URL(request.url).searchParams;
    const ticket = search.get("ticket") ?? "";
    const key = search.get("key") ?? "";
    const format = search.get("format");
    if (!ticket || !key || !isLayerExportFormat(format)) throw unavailable();
    const claimed = queryDownloadTickets.claim(scope, ticket, { layerId: key, format });
    if (!claimed) throw unavailable();

    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = (await openPrivateExport(scope, { path: claimed.path, cleanup: async () => claimed.fail() })).handle;
    } catch {
      claimed.fail();
      requireAccountScope(scope);
      throw unavailable();
    }
    if (request.signal.aborted) {
      await handle.close().catch(() => undefined);
      claimed.fail();
      throw new EvaluationCancelled();
    }
    const stream = handle.createReadStream();
    if (!observeLayerDownloadStream(stream, request.signal, claimed)) {
      if (request.signal.aborted) throw new EvaluationCancelled();
      throw unavailable();
    }
    return new NextResponse(Readable.toWeb(stream) as ReadableStream, {
      headers: {
        "content-type": claimed.contentType,
        "content-length": String(claimed.size),
        "content-disposition": `attachment; filename="${claimed.filename}"`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

async function directDownload(scope: AccountScope, request: Request, body: Body) {
  // Resolve-and-open is one tracked reader: the descriptor is held before
  // the response starts, so a scratch sweep cannot land between write and
  // open.
  const { file, handle, size } = await trackInflight(
    (async () => {
      const file = await exportQueryResult(
        scope,
        body.sql,
        body.format,
        request.signal,
        body.name,
      );
      const { handle, size } = await openPrivateExport(scope, file);
      return { file, handle, size };
    })(),
  );
  const stream = handle.createReadStream();
  stream.once("close", () => void file.cleanup());
  return new NextResponse(Readable.toWeb(stream) as ReadableStream, {
    headers: {
      "content-type": file.contentType,
      "content-length": String(size),
      "content-disposition": `attachment; filename="${file.filename}"`,
    },
  });
}

async function prepareDownload(scope: AccountScope, request: Request, body: Body) {
  const binding = bindingFor(body.sql, body.format);
  let ticket: string | null = null;
  try {
    if (request.signal.aborted) throw new EvaluationCancelled();
    ticket = await trackInflight(
      (async () => {
        const file = await exportQueryResult(
          scope,
          body.sql,
          body.format,
          request.signal,
          body.name,
        );
        try {
          const size = (await stat(file.path)).size;
          return queryDownloadTickets.prepare(
            scope,
            binding,
            { ...file, size },
            request.signal,
          );
        } catch (error) {
          await file.cleanup().catch(() => undefined);
          throw error;
        }
      })(),
    );
    if (request.signal.aborted) throw new EvaluationCancelled();
    return NextResponse.json(
      { ticket, key: binding.layerId, format: body.format },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (ticket !== null) await queryDownloadTickets.release(scope, ticket, binding);
    throw error;
  }
}
